// -----------------------------------------------------------------------------
// The service of the `nasweb-push` sub-container: the HTTP endpoint the
// NASweb module posts its status to (the "address" of its status
// subscription), and the channel that hands each push to the main container.
// The main container cannot publish a port; this container does (Gladys
// picks the host port).
//
// Accepted: exactly `POST /nasweb/<push token>` (no query string), a body of
// 32 KB at most. Everything else is answered 404 (405 for another method on
// the right path, 413 for a body too large, 429 over the rate) and never
// reaches the main container. The token keeps another machine of the
// network from posting a status by guessing the URL (it travels in clear,
// over HTTP: whoever sees the traffic can read it); the main container then
// checks the source address and the serial number of the module
// (src/app.js).
//
// Bounded for a 64 MB container: 32 connections at most, 4 per source
// address, 4 kept for DEVICE_ADDRESS when set; over a limit the OLDEST
// connection whose request is not complete is closed (one that sent no byte
// first, then one with partial headers), never the newcomer
// of the module (it sends its request as soon as it connects). A connection
// that sends nothing is closed within 10 s (the headers timeout closes it at
// about 5 s, our own timer at 10 s), the headers must arrive within 5 s and
// the whole request within 10 s (checked every second: about 11 s at worst).
// 240 posts a minute in all; the module (DEVICE_ADDRESS) has that whole
// budget, any other source 60 of it, over which its latest post is kept (8
// sources at most) and sent once its window frees. When DEVICE_ADDRESS is set ("Check the sender" on), a post
// from another address is answered 403 before any budget is spent, and the
// main container is told (at most every 10 s), never with its body.
//
// Environment, set by the main container through startContainer:
//   PUSH_TOKEN     the secret of the push URL
//   CHANNEL_TOKEN  the secret the main container says hello with
//   HTTP_PORT      8080 (published by Gladys)
//   CHANNEL_PORT   7778 (private network only)
//   DEVICE_ADDRESS the IP address of the module, when the sender is checked
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
  const device = normalizeIp(env.DEVICE_ADDRESS ?? '') ?? '';
  const idleMs = Number(env.IDLE_MS ?? LIMITS.receiverIdleMs);
  let window = [];
  /** source address -> times of its posts in the last minute (bounded map) */
  const bySource = new Map();
  /** The open connections, oldest first; `requested` once their headers arrived. */
  const conns = new Set();
  /** source address -> the latest post over its minute budget, sent once the window frees */
  const deferred = new Map();
  let lastRefusedNotice = -Infinity;
  const http = createServer(
    {
      connectionsCheckingInterval: 1000,
      headersTimeout: 5000,
      requestTimeout: 10_000,
      keepAliveTimeout: 1000,
      maxHeaderSize: 8192,
    },
    (request, response) => {
      const from = normalizeIp(request.socket.remoteAddress ?? '') ?? '';
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
      if (device && from !== device) {
        request.resume();
        reply(response, 403, 'Forbidden');
        if (time - lastRefusedNotice >= 10_000) {
          lastRefusedNotice = time;
          channel.send(
            { type: 'refused', from, at: new Date(time).toISOString() },
            { queue: false },
          );
        }
        return;
      }
      window = window.filter((t) => time - t < 60_000);
      const mine = (bySource.get(from) ?? []).filter((t) => time - t < 60_000);
      if (window.length >= LIMITS.pushesPerMinute) {
        request.resume();
        reply(response, 429, 'Too many requests');
        return;
      }
      // The module (DEVICE_ADDRESS) has the whole budget; another source over its
      // own share has its LATEST post kept and sent once its window frees.
      const over = !(device && from === device) && mine.length >= LIMITS.pushesPerSource;
      if (over && !deferred.has(from) && deferred.size >= LIMITS.deferredSources) {
        request.resume();
        reply(response, 429, 'Too many requests');
        return;
      }
      if (!over) {
        window.push(time);
        mine.push(time);
      }
      if (!bySource.has(from) && bySource.size >= 256) {
        bySource.clear();
      }
      bySource.set(from, mine);
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
        const message = {
          type: 'push',
          from,
          at: new Date(time).toISOString(),
          body: Buffer.concat(parts, size).toString('utf8'),
        };
        if (over) {
          defer(from, message, mine[0] + 60_000 - time);
        } else {
          channel.send(message);
        }
        reply(response, 200, ANSWER, 'application/json');
      });
      request.on('error', () => {});
    },
  );
  /** Keeps the latest post of a source over its budget; sent when its window frees. */
  function defer(from, message, wait) {
    const pending = deferred.get(from);
    if (pending) {
      pending.message = message;
      return;
    }
    const entry = { message };
    entry.timer = setTimeout(
      () => {
        deferred.delete(from);
        const t = now();
        window = window.filter((x) => t - x < 60_000);
        const times = (bySource.get(from) ?? []).filter((x) => t - x < 60_000);
        window.push(t);
        times.push(t);
        bySource.set(from, times);
        channel.send(entry.message);
      },
      Math.max(0, wait),
    );
    entry.timer.unref?.();
    deferred.set(from, entry);
  }

  const isDevice = (socket) => device !== '' && socket.nwFrom === device;
  /**
   * Closes the oldest connection whose request is not complete, among `which`:
   * first one that has sent no byte at all, only then one with partial headers
   * (a module sending its headers in pieces is never the first to go).
   */
  const evictOldestSilent = (which) => {
    for (const pass of [(socket) => socket.bytesRead === 0, () => true]) {
      for (const socket of conns) {
        if (!socket.nwRequested && which(socket) && pass(socket)) {
          conns.delete(socket);
          socket.destroy();
          return true;
        }
      }
    }
    return false;
  };
  const count = (which) => {
    let n = 0;
    for (const socket of conns) if (which(socket)) n += 1;
    return n;
  };

  http.maxHeadersCount = 50;
  http.on('request', (request) => {
    request.socket.nwRequested = true;
  });
  http.on('connection', (socket) => {
    // Idle from its acceptance: a connection that sends nothing is closed. A
    // timer of our own (socket.setTimeout is reset by the HTTP server once its
    // headers timeout passes); the headers (5 s) and request (10 s) timeouts
    // of the server apply too, then keepAliveTimeout (1 s).
    const idle = setTimeout(() => socket.destroy(), idleMs);
    idle.unref?.();
    socket.once('close', () => {
      clearTimeout(idle);
      conns.delete(socket);
    });
    socket.nwFrom = normalizeIp(socket.remoteAddress ?? '') ?? '';
    // Over a limit, the newcomer is never the one refused: the oldest connection
    // still silent goes (the module sends its request as soon as it connects).
    // The address of the module, when known, keeps its own places and is never
    // refused.
    if (isDevice(socket)) {
      if (count(isDevice) >= LIMITS.receiverConnectionsPerSource) {
        evictOldestSilent(isDevice);
      }
    } else {
      const same = (s) => s.nwFrom === socket.nwFrom;
      const others = (s) => !isDevice(s);
      const limit = device
        ? LIMITS.receiverConnections - LIMITS.receiverConnectionsPerSource
        : LIMITS.receiverConnections;
      if (
        (count(same) >= LIMITS.receiverConnectionsPerSource && !evictOldestSilent(same)) ||
        (count(others) >= limit && !evictOldestSilent(others))
      ) {
        socket.destroy();
        return;
      }
    }
    conns.add(socket);
  });
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
      for (const entry of deferred.values()) clearTimeout(entry.timer);
      await new Promise((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      await channel.stop();
    },
  };
}
