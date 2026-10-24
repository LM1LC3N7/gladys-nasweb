// -----------------------------------------------------------------------------
// The service of the `nasweb-push` sub-container: the HTTP endpoint the
// NASweb module posts its status to (the "address" of its status
// subscription), and the channel that hands each push to the main container.
// The main container cannot publish a port; this container does (Gladys
// picks the host port).
//
// Accepted: exactly `POST /nasweb/<push token>` (no query string), a body of
// 32 KB at most, read within 10 s, 120 pushes a minute at most. Everything
// else is answered 404 (405 for another method on the right path, 413 for a
// body too large, 429 over the rate) and never reaches the main container.
// The token keeps another machine of the network from posting a status by
// guessing the URL; the main container then checks the source address and
// the serial number of the module (src/app.js).
//
// Environment, set by the main container through startContainer:
//   PUSH_TOKEN     the secret of the push URL
//   CHANNEL_TOKEN  the secret the main container says hello with
//   HTTP_PORT      8080 (published by Gladys)
//   CHANNEL_PORT   7778 (private network only)
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createChannelServer } from '../channel.js';
import { LIMITS, RECEIVER } from '../constants.js';
import { isToken, normalizeIp } from '../config.js';

const PATH = /^\/nasweb\/([A-Za-z0-9_-]{32,128})$/;
const ANSWER = '{"response": "ok"}';

const sameToken = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

/** Whether a request target is exactly the push path with the right token. */
export function isPushPath(url, token) {
  if (!isToken(token) || typeof url !== 'string') {
    return false;
  }
  const match = PATH.exec(url);
  return Boolean(match) && sameToken(match[1], token);
}

const reply = (response, status, body, type = 'text/plain') => {
  response.writeHead(status, { 'Content-Type': type, Connection: 'close' }).end(body);
};

/**
 * @returns {Promise<{ http, channel, stop(): Promise, port: number }>}
 */
export async function startPushService({ env = process.env, logger, now = Date.now } = {}) {
  const pushToken = env.PUSH_TOKEN ?? '';
  if (!isToken(pushToken)) {
    logger?.warn('PUSH_TOKEN is missing: every push will be refused');
  }
  const channel = createChannelServer({
    port: Number(env.CHANNEL_PORT ?? RECEIVER.channelPort),
    token: env.CHANNEL_TOKEN,
    logger,
    queueSize: LIMITS.pushQueue,
  });
  let window = [];
  const http = createServer((request, response) => {
    if (!isPushPath(request.url, pushToken)) {
      request.resume();
      reply(response, 404, 'Not found');
      return;
    }
    if (request.method !== 'POST') {
      request.resume();
      reply(response, 405, 'Method not allowed');
      return;
    }
    const time = now();
    window = window.filter((t) => time - t < 60_000);
    if (window.length >= LIMITS.pushesPerMinute) {
      request.resume();
      reply(response, 429, 'Too many requests');
      return;
    }
    window.push(time);
    const declared = request.headers['content-length'];
    if (
      declared !== undefined &&
      (!/^\d{1,9}$/.test(declared) || Number(declared) > LIMITS.pushBytes)
    ) {
      request.resume();
      reply(response, 413, 'Too large');
      return;
    }
    const parts = [];
    let size = 0;
    let refused = false;
    request.on('data', (chunk) => {
      if (refused) return;
      size += chunk.length;
      if (size > LIMITS.pushBytes) {
        refused = true;
        reply(response, 413, 'Too large');
        request.destroy();
        return;
      }
      parts.push(chunk);
    });
    request.on('end', () => {
      if (refused) return;
      const from = normalizeIp(request.socket.remoteAddress ?? '') ?? '';
      channel.send({
        type: 'push',
        from,
        at: new Date(time).toISOString(),
        body: Buffer.concat(parts, size).toString('utf8'),
      });
      reply(response, 200, ANSWER, 'application/json');
    });
    request.on('error', () => {});
  });
  http.requestTimeout = 10_000;
  http.headersTimeout = 10_000;
  http.maxHeadersCount = 50;
  await channel.start();
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(Number(env.HTTP_PORT ?? RECEIVER.httpPort), env.HTTP_HOST ?? '0.0.0.0', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const port = http.address().port;
  logger?.info(`Push receiver on HTTP port ${port}; channel on port ${channel.port}`);
  return {
    http,
    channel,
    port,
    async stop() {
      await new Promise((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      await channel.stop();
    },
  };
}
