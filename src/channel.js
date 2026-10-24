// -----------------------------------------------------------------------------
// The link between the two containers: JSON lines over TCP on the private
// network of the integration (Gladys gives the receiver the DNS alias of its
// name, `nasweb-push`, and joins the main container to that network). The
// port is not published: only the main container reaches it.
//
// - the receiver runs the server: it keeps what the module pushed while the
//   main container is away (a bounded queue) and streams it once a client has
//   proved it knows the channel secret;
// - the main container runs the client: it reconnects by itself, and accepts
//   nothing before the server has proved it knows the secret too.
//
// Mutual challenge-response, the secret never on the wire:
//   server -> { type: 'challenge', nonce: Ns }
//   client -> { type: 'hello', nonce: Nc, proof: HMAC(secret, 'client|Ns|Nc') }
//   server -> { type: 'ready', proof: HMAC(secret, 'server|Nc|Ns'), queued, dropped }
// Fresh nonces on both sides: a recorded exchange cannot be replayed.
//
// Sub-containers get no Gladys credentials: the receiver only ever talks to
// the module and to this channel. Taken from LM1LC3N7/gladys-mystrom (same
// author, Apache-2.0), the line splitter made linear for longer lines.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CHANNEL_PORT = 7778;
/** A line holds one push (32 KB of body, escaped in JSON): 256 KB at most. */
const MAX_LINE = 256 * 1024;
const NONCE = /^[0-9a-f]{32}$/;

const nonce = () => randomBytes(16).toString('hex');

export const proof = (secret, role, first, second) =>
  createHmac('sha256', String(secret ?? ''))
    .update(`${role}|${first}|${second}`)
    .digest('hex');

const sameProof = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

/**
 * Splits a socket's data into JSON objects; drops the socket on garbage or on
 * a line over MAX_LINE. Linear: each chunk is searched once for its line ends,
 * the pieces of a line are joined once.
 */
function onJsonLines(socket, handler) {
  let parts = [];
  let size = 0;
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    let start = 0;
    let end;
    while ((end = chunk.indexOf('\n', start)) >= 0) {
      parts.push(chunk.slice(start, end));
      const line = parts.join('');
      parts = [];
      size = 0;
      start = end + 1;
      if (line.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      if (line.trim() === '') continue;
      let object;
      try {
        object = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      handler(object);
      if (socket.destroyed) return;
    }
    const rest = chunk.slice(start);
    size += rest.length;
    if (size > MAX_LINE) {
      socket.destroy();
      return;
    }
    if (rest !== '') parts.push(rest);
  });
}

/**
 * Receiver side.
 * @returns {{ start(): Promise, stop(): Promise, send(object): void, port: number, connected: boolean }}
 */
export function createChannelServer({
  port = CHANNEL_PORT,
  host = '0.0.0.0',
  token,
  queueSize = 500,
  logger,
  hello = () => ({}),
}) {
  const queue = [];
  let client;
  let server;
  let dropped = 0;
  const secret = String(token ?? '');

  const write = (socket, object) => socket?.write(`${JSON.stringify(object)}\n`);

  const channel = {
    get port() {
      return server?.address()?.port;
    },
    get connected() {
      return Boolean(client);
    },
    /** Sends now, or queues while no client is connected (unless `queue` is false). */
    send(object, { queue: keep = true } = {}) {
      if (client) {
        write(client, object);
        return;
      }
      if (!keep) return;
      queue.push(object);
      if (queue.length > queueSize) {
        queue.shift();
        dropped += 1;
      }
    },
    start() {
      return new Promise((resolve, reject) => {
        server = createServer((socket) => {
          socket.setKeepAlive(true, 30_000);
          let state = 'challenged';
          const serverNonce = nonce();
          const timer = setTimeout(() => state === 'ready' || socket.destroy(), 10_000);
          write(socket, { type: 'challenge', nonce: serverNonce });
          onJsonLines(socket, (object) => {
            if (state === 'ready') return; // the main container sends nothing else
            const valid =
              secret !== '' &&
              object?.type === 'hello' &&
              NONCE.test(String(object.nonce ?? '')) &&
              sameProof(object.proof, proof(secret, 'client', serverNonce, object.nonce));
            if (!valid) {
              logger?.warn('Channel: refused a client that does not know the secret');
              socket.destroy();
              return;
            }
            state = 'ready';
            clearTimeout(timer);
            if (client && client !== socket) client.destroy();
            client = socket;
            write(socket, {
              type: 'ready',
              proof: proof(secret, 'server', object.nonce, serverNonce),
              queued: queue.length,
              dropped,
              ...hello(),
            });
            while (queue.length > 0) write(socket, queue.shift());
            dropped = 0;
            logger?.info('Channel: main container connected');
          });
          socket.on('error', () => {});
          socket.on('close', () => {
            clearTimeout(timer);
            if (client === socket) {
              client = undefined;
              logger?.info('Channel: main container disconnected, keeping messages');
            }
          });
        });
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    stop() {
      client?.destroy();
      return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    },
  };
  return channel;
}

/**
 * Main container side: emits `message` (each object), `up` and `down`.
 * Reconnects with a 1 s to 30 s backoff.
 */
export class ChannelClient extends EventEmitter {
  constructor({
    host = 'nasweb-push',
    port = CHANNEL_PORT,
    token,
    logger,
    delays = [1000, 2000, 5000, 10_000, 30_000],
    handshakeTimeout = 10_000,
  }) {
    super();
    this.host = host;
    this.port = port;
    this.secret = String(token ?? '');
    this.logger = logger;
    this.delays = delays;
    this.handshakeTimeout = handshakeTimeout;
    this.attempt = 0;
    this.connected = false;
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
    this.socket = undefined;
  }

  connect() {
    if (this.stopped) return;
    if (this.secret === '') {
      // Without a secret no proof means anything: never connect.
      this.logger?.error('Channel: no secret, not connecting to the receiver');
      this.stopped = true;
      return;
    }
    const socket = createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setKeepAlive(true, 30_000);
    let state = 'waiting';
    let clientNonce;
    let serverNonce;
    // A receiver that stalls the handshake is dropped (and tried again later).
    const handshake = setTimeout(() => {
      if (state !== 'ready') {
        this.logger?.debug('Channel: handshake timed out');
        socket.destroy();
      }
    }, this.handshakeTimeout);
    handshake.unref?.();
    socket.on('close', () => clearTimeout(handshake));
    onJsonLines(socket, (object) => {
      if (state === 'waiting') {
        if (object?.type !== 'challenge' || !NONCE.test(String(object.nonce ?? ''))) {
          socket.destroy();
          return;
        }
        serverNonce = object.nonce;
        clientNonce = nonce();
        state = 'hello';
        socket.write(
          `${JSON.stringify({
            type: 'hello',
            nonce: clientNonce,
            proof: proof(this.secret, 'client', serverNonce, clientNonce),
          })}\n`,
        );
        return;
      }
      if (state === 'hello') {
        // Nothing is accepted before a ready that proves the receiver knows the secret.
        if (
          object?.type !== 'ready' ||
          !sameProof(object.proof, proof(this.secret, 'server', clientNonce, serverNonce))
        ) {
          this.logger?.warn('Channel: the receiver did not prove it knows the secret');
          socket.destroy();
          return;
        }
        state = 'ready';
        clearTimeout(handshake);
        this.connected = true;
        this.attempt = 0;
        const { proof: _proof, ...info } = object;
        this.emit('up', info);
        return;
      }
      this.emit('message', object);
    });
    socket.on('error', (err) => this.logger?.debug(`Channel: ${err.message}`));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.connected) {
        this.connected = false;
        this.emit('down');
      }
      if (!this.stopped) {
        const delay = this.delays[Math.min(this.attempt, this.delays.length - 1)];
        this.attempt += 1;
        this.timer = setTimeout(() => this.connect(), delay);
        this.timer.unref?.();
      }
    });
  }
}
