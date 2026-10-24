// -----------------------------------------------------------------------------
// The only network access to the module: one HTTPS request per TLS
// connection, the certificate checked BEFORE a single byte is written.
//
// The NASweb module serves a self-signed certificate (webio-api connects
// with verify_ssl=False), so no authority can vouch for it. The connection
// resolves with the SHA-256 fingerprint of the certificate and `trust()`
// (src/app.js) compares it with the pin kept in /data: the login and the
// hash of the password never reach another machine. `rejectUnauthorized:
// false` is safe only with that check.
//
// Bounded: the whole request in time, the head of the answer (8 KB), its
// body (64 KB), parsed in one pass over the bytes as they come (the parser
// comes from LM1LC3N7/gladys-alfen, same author, Apache-2.0). No redirect
// is ever followed. Every failure is a DeviceError whose kind says whether
// the request may have reached the module; its message never holds the
// address, the credentials nor any byte of the answer.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import tls from 'node:tls';
import { LIMITS } from '../constants.js';

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection (TLS included). Nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Connected, then silent or cut: the request may have been received. */
  TIMEOUT: 'timeout',
  /** An HTTP status that is not handled more precisely (`status` holds it). */
  HTTP: 'http',
  /** 401, or "Not Authorized": the login or the password was refused. */
  AUTH: 'auth',
  /** Too large, not HTTP, not JSON, not the expected shape. */
  PROTOCOL: 'protocol',
  /** The certificate is not the one pinned (`fingerprint` holds the new one). Nothing was sent. */
  CERTIFICATE: 'certificate_changed',
  /** Another module answers at the address (`serial` holds it). Nothing was sent. */
  OTHER_DEVICE: 'other_device',
  /** The time a command was given ran out before its request: nothing was sent. */
  LATE: 'late',
  /** The request belongs to a configuration replaced meanwhile: nothing was sent. */
  STALE: 'stale',
  /** The first pin could not be kept in /data: nothing was sent. */
  STORAGE: 'storage',
  /** A check right before the write refused it (`refusal` holds why): nothing was sent. */
  REFUSED: 'refused',
});

export class DeviceError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'DeviceError';
    this.kind = kind;
    for (const [key, value] of Object.entries(details)) {
      this[key] = value;
    }
  }
}

/** Whether a failure says for sure that nothing reached the module. */
export const notSent = (err) =>
  err?.notSent === true ||
  [
    ERROR_KINDS.UNREACHABLE,
    ERROR_KINDS.LATE,
    ERROR_KINDS.CERTIFICATE,
    ERROR_KINDS.OTHER_DEVICE,
    ERROR_KINDS.STALE,
    ERROR_KINDS.STORAGE,
    ERROR_KINDS.REFUSED,
  ].includes(err?.kind);

const CRLF = Buffer.from('\r\n\r\n');
const code = (err) => (/^[A-Z0-9_]{1,40}$/.test(String(err?.code ?? '')) ? err.code : 'error');

/** The fingerprint as Node prints it: "AB:CD:…", upper case. */
export const normalizeFingerprint = (value) =>
  typeof value === 'string' && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(value.trim())
    ? value.trim().toUpperCase()
    : undefined;

/**
 * A parser of ONE HTTP/1.1 answer, fed with the chunks as they come. Linear:
 * the head is searched in at most 8 KB (kept in a buffer capped to that
 * size), the body bytes are copied once into a list of slices.
 */
export class AnswerParser {
  constructor({ maxBytes = LIMITS.responseBytes, headerBytes = LIMITS.headerBytes } = {}) {
    this.maxBytes = maxBytes;
    this.headerBytes = headerBytes;
    this.head = Buffer.alloc(0);
    this.phase = 'head';
    this.status = 0;
    this.headers = {};
    this.parts = [];
    this.size = 0;
    this.remaining = 0;
    this.chunkLine = '';
    this.untilClose = false;
    this.done = false;
    this.keepAlive = true;
  }

  fail(message) {
    throw new DeviceError(ERROR_KINDS.PROTOCOL, message);
  }

  /** Feeds bytes; returns true once the answer is complete. */
  push(chunk) {
    let offset = 0;
    if (this.phase === 'head') {
      // Only the bytes that may hold the head are joined (8 KB at most).
      const room = this.headerBytes - this.head.length;
      const take = chunk.subarray(0, Math.max(0, room));
      const joined = Buffer.concat([this.head, take]);
      const end = joined.indexOf(CRLF);
      if (end === -1) {
        if (joined.length >= this.headerBytes) this.fail('Head too large');
        this.head = joined;
        return false;
      }
      offset = end + 4 - this.head.length;
      this.head = Buffer.alloc(0);
      if (this.parseHead(joined.subarray(0, end).toString('latin1')) === 'interim') {
        // A 1xx answer (100 Continue…) is not the answer: skipped, 4 at most.
        this.interims = (this.interims ?? 0) + 1;
        if (this.interims > 4) this.fail('Too many interim answers');
        return this.push(chunk.subarray(offset));
      }
    }
    this.feed(chunk, offset);
    return this.done;
  }

  parseHead(text) {
    const lines = text.split('\r\n');
    const status = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(lines[0]);
    if (!status) this.fail('Not HTTP');
    this.status = Number(status[1]);
    const headers = Object.create(null);
    for (const line of lines.slice(1)) {
      const at = line.indexOf(':');
      if (at <= 0) this.fail('Bad header');
      const name = line.slice(0, at).trim().toLowerCase();
      if (!/^[a-z0-9-]{1,64}$/.test(name)) this.fail('Bad header');
      headers[name] = line.slice(at + 1).trim();
    }
    if (this.status >= 100 && this.status < 200 && this.status !== 101) {
      this.status = 0;
      return 'interim';
    }
    this.headers = headers;
    const connection = String(headers.connection ?? '').toLowerCase();
    this.keepAlive = connection !== 'close';
    const encoding = String(headers['transfer-encoding'] ?? '').toLowerCase();
    if (this.status === 204 || this.status === 304 || (this.status >= 100 && this.status < 200)) {
      this.phase = 'body';
      this.remaining = 0;
      this.done = true;
      return;
    }
    if (encoding.includes('chunked')) {
      this.phase = 'size';
      return;
    }
    if (headers['content-length'] !== undefined) {
      if (!/^\d{1,9}$/.test(headers['content-length'])) this.fail('Bad length');
      this.remaining = Number(headers['content-length']);
      if (this.remaining > this.maxBytes) this.fail('Answer too large');
      this.phase = 'body';
      this.done = this.remaining === 0;
      return;
    }
    // Neither: the body ends with the connection.
    this.phase = 'body';
    this.untilClose = true;
    this.keepAlive = false;
  }

  take(slice) {
    this.size += slice.length;
    if (this.size > this.maxBytes) this.fail('Answer too large');
    this.parts.push(slice);
  }

  feed(chunk, offset) {
    let i = offset;
    while (i < chunk.length && !this.done) {
      if (this.phase === 'body') {
        if (this.untilClose) {
          this.take(chunk.subarray(i));
          return;
        }
        const n = Math.min(this.remaining, chunk.length - i);
        this.take(chunk.subarray(i, i + n));
        this.remaining -= n;
        i += n;
        if (this.remaining === 0) this.done = true;
      } else if (this.phase === 'size' || this.phase === 'trailer' || this.phase === 'dataEnd') {
        // One line, byte by byte (bounded to 64 characters).
        const byte = chunk[i];
        i += 1;
        if (byte !== 0x0a) {
          this.chunkLine += String.fromCharCode(byte);
          if (this.chunkLine.length > 64) this.fail('Bad chunk');
          continue;
        }
        const line = this.chunkLine.replace(/\r$/, '');
        this.chunkLine = '';
        if (this.phase === 'dataEnd') {
          if (line !== '') this.fail('Bad chunk');
          this.phase = 'size';
        } else if (this.phase === 'trailer') {
          if (line === '') this.done = true;
        } else {
          const size = /^([0-9a-f]{1,8})(?:;.*)?$/i.exec(line);
          if (!size) this.fail('Bad chunk');
          const n = parseInt(size[1], 16);
          if (n === 0) {
            this.phase = 'trailer';
          } else {
            if (this.size + n > this.maxBytes) this.fail('Answer too large');
            this.remaining = n;
            this.phase = 'data';
          }
        }
      } else if (this.phase === 'data') {
        const n = Math.min(this.remaining, chunk.length - i);
        this.take(chunk.subarray(i, i + n));
        this.remaining -= n;
        i += n;
        if (this.remaining === 0) this.phase = 'dataEnd';
      }
    }
  }

  /** The connection ended: an answer read until the close is complete then. */
  end() {
    if (this.phase === 'body' && this.untilClose) {
      this.done = true;
    }
    return this.done;
  }

  result() {
    return {
      status: this.status,
      headers: this.headers,
      body: Buffer.concat(this.parts, this.size).toString('utf8'),
    };
  }
}

/**
 * One request on a new TLS connection.
 *
 * `trust(fingerprint)` runs once the handshake is done, before anything is
 * written (it throws to refuse the certificate; it may await the first pin
 * being kept); `beforeSend()` runs right before the bytes leave: what either
 * throws is rethrown marked `notSent`, the connection closed unwritten.
 *
 * @param {{ host: string, port: number, path: string, body?: string,
 *   timeoutMs: number, trust: Function, beforeSend?: Function,
 *   connect?: Function }} options
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function pinnedRequest({
  host,
  port,
  path,
  body,
  timeoutMs,
  trust,
  beforeSend,
  connect = tls.connect,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let socket;
    const parser = new AnswerParser();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          sent
            ? new DeviceError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
            : new DeviceError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'),
        ),
      Math.max(1, timeoutMs),
    );
    try {
      socket = connect({
        host,
        port,
        servername: isIP(host) ? undefined : host,
        rejectUnauthorized: false,
        // TLS 1.2 at least, whatever NODE_OPTIONS says; the cipher list at
        // security level 1 for older embedded TLS (the pin vouches for the module).
        minVersion: 'TLSv1.2',
        ciphers: 'DEFAULT@SECLEVEL=1',
      });
    } catch (err) {
      finish(new DeviceError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${code(err)}`));
      return;
    }
    socket.on('error', (err) => {
      finish(
        sent
          ? new DeviceError(ERROR_KINDS.TIMEOUT, `Connection lost: ${code(err)}`)
          : new DeviceError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${code(err)}`),
      );
    });
    socket.on('data', (chunk) => {
      if (!sent) {
        // The module speaks before it was asked anything: not this protocol.
        finish(new DeviceError(ERROR_KINDS.PROTOCOL, 'Unexpected data', { notSent: true }));
        return;
      }
      try {
        if (parser.push(chunk)) finish(null, parser.result());
      } catch (err) {
        finish(err);
      }
    });
    const ended = () => {
      if (!sent) {
        finish(new DeviceError(ERROR_KINDS.UNREACHABLE, 'Connection closed', { notSent: true }));
      } else if (parser.end()) {
        finish(null, parser.result());
      } else {
        finish(new DeviceError(ERROR_KINDS.TIMEOUT, 'Connection lost'));
      }
    };
    socket.on('end', ended);
    socket.on('close', ended);
    socket.once('secureConnect', async () => {
      const fingerprint = normalizeFingerprint(socket.getPeerCertificate?.()?.fingerprint256);
      try {
        if (!fingerprint) {
          throw new DeviceError(ERROR_KINDS.CERTIFICATE, 'No certificate');
        }
        await trust(fingerprint);
        if (settled) return;
        beforeSend?.();
      } catch (err) {
        const error =
          err instanceof DeviceError ? err : new DeviceError(ERROR_KINDS.REFUSED, 'Refused');
        error.notSent = true;
        if (!(err instanceof DeviceError)) error.cause = err;
        finish(error);
        return;
      }
      if (settled) return;
      const payload = Buffer.from(body ?? '', 'utf8');
      const lines = [
        `POST ${path} HTTP/1.1`,
        `Host: ${isIP(host) === 6 ? `[${host}]` : host}`,
        'Connection: close',
        'Accept: application/json, text/plain, */*',
        ...(body === undefined
          ? ['Content-Length: 0']
          : ['Content-Type: application/json', `Content-Length: ${payload.length}`]),
      ];
      if (lines.some((line) => /[\r\n]/.test(line))) {
        finish(new DeviceError(ERROR_KINDS.PROTOCOL, 'Bad header', { notSent: true }));
        return;
      }
      sent = true;
      socket.write(
        Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), payload]),
      );
    });
  });
}
