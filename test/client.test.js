// -----------------------------------------------------------------------------
// The client of the module against a REAL local TLS server (self-signed test
// certificates of test/fixtures, made for these tests only): the pin is
// checked before a single byte is written, the body is the one webio-api
// sends, a refused login is told apart, the answers are bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { NaswebClient, normalizeSerial, passwordHash } from '../src/nasweb/client.js';
import { DeviceError, ERROR_KINDS, notSent } from '../src/nasweb/http.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const CERT = fixture('module-cert.pem');
const KEY = fixture('module-key.pem');
const PIN = new X509Certificate(CERT).fingerprint256;
const OTHER_PIN = new X509Certificate(fixture('other-cert.pem')).fingerprint256;

/** A TLS server answering each request with `answer(request)`; counts the bytes it received. */
async function server(answer) {
  const seen = { bytes: 0, requests: [] };
  const srv = tls.createServer({ cert: CERT, key: KEY }, (socket) => {
    let text = '';
    socket.on('data', (chunk) => {
      seen.bytes += chunk.length;
      text += chunk.toString('utf8');
      const end = text.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/content-length: (\d+)/i.exec(text.slice(0, end))?.[1] ?? 0);
      if (text.length < end + 4 + length) return;
      const [line, ...headers] = text.slice(0, end).split('\r\n');
      const request = { line, headers, body: text.slice(end + 4, end + 4 + length) };
      seen.requests.push(request);
      const reply = answer(request);
      if (reply === 'silent') return;
      socket.end(reply);
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { port: srv.address().port, seen, close: () => new Promise((r) => srv.close(r)) };
}

const http = (status, body, extra = '') =>
  `HTTP/1.1 ${status} X\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`;

const options = (port, trust = async () => {}) => ({
  target: { host: '127.0.0.1', port },
  credentials: { username: 'admin', password: 'sécret' },
  timeoutMs: 2000,
  trust,
});

test('the password goes as webio-api sends it: SHA-1, upper-case hexadecimal', () => {
  assert.equal(passwordHash('admin'), 'D033E22AE348AEB5660FC2140AEC35850C4DA997');
  assert.equal(normalizeSerial('00-11-AA-bb'), '0011AABB');
  assert.equal(normalizeSerial(''), undefined);
  assert.equal(normalizeSerial('a b'), undefined);
  assert.equal(normalizeSerial(42), undefined);
});

test('getDeviceInfo: the body, the identity, the pin seen by trust()', async () => {
  const srv = await server(() => http(200, '{"devSN":"12-34-56","devName":"Garage\\u0007 box"}'));
  let pinned;
  try {
    const info = await new NaswebClient().deviceInfo(
      options(srv.port, async (fingerprint) => {
        pinned = fingerprint;
      }),
    );
    assert.deepEqual(info, { serial: '123456', name: 'Garage  box' });
    assert.equal(pinned, PIN);
    const [request] = srv.seen.requests;
    assert.equal(request.line, 'POST /rest/integration/hass/getDeviceInfo HTTP/1.1');
    assert.deepEqual(JSON.parse(request.body), {
      login: 'admin',
      password: passwordHash('sécret'),
    });
    assert.ok(!request.body.includes('sécret'), 'never the password itself');
  } finally {
    await srv.close();
  }
});

test('another certificate: refused before a single byte is written', async () => {
  const srv = await server(() => http(200, '{"Answer":"OK"}'));
  try {
    await assert.rejects(
      new NaswebClient().setOutput(
        options(srv.port, async (fingerprint) => {
          assert.notEqual(fingerprint, OTHER_PIN);
          throw new DeviceError(ERROR_KINDS.CERTIFICATE, 'changed', { fingerprint });
        }),
        1,
        true,
      ),
      (err) => err.kind === ERROR_KINDS.CERTIFICATE && notSent(err),
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(srv.seen.bytes, 0, 'nothing written: no login, no command');
  } finally {
    await srv.close();
  }
});

test('beforeSend refuses: nothing written, the refusal kept as the cause', async () => {
  const srv = await server(() => http(200, '{"Answer":"OK"}'));
  const refusal = new Error('Commands are off');
  try {
    await assert.rejects(
      new NaswebClient().setOutput(
        {
          ...options(srv.port),
          beforeSend: () => {
            throw refusal;
          },
        },
        1,
        true,
      ),
      (err) => err.kind === ERROR_KINDS.REFUSED && err.cause === refusal && notSent(err),
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(srv.seen.bytes, 0);
  } finally {
    await srv.close();
  }
});

test('setOutput and the subscription: the bodies and the "OK" answer', async () => {
  const answers = ['{"Answer":"OK"}', '{"Answer":"ERROR"}', '{"Answer":"OK"}'];
  const srv = await server(() => http(200, answers.shift()));
  try {
    const client = new NaswebClient();
    assert.equal(await client.setOutput(options(srv.port), 3, true), true);
    assert.equal(await client.setOutput(options(srv.port), 3, false), false);
    assert.equal(
      await client.subscription(options(srv.port), 'http://192.168.1.10:41000/nasweb/x', true),
      true,
    );
    const bodies = srv.seen.requests.map((r) => JSON.parse(r.body));
    assert.deepEqual(bodies[0], {
      login: 'admin',
      password: passwordHash('sécret'),
      index: 3,
      status: true,
    });
    assert.equal(bodies[1].status, false);
    assert.deepEqual(bodies[2], {
      login: 'admin',
      password: passwordHash('sécret'),
      address: 'http://192.168.1.10:41000/nasweb/x',
      subscribe: true,
    });
    assert.equal(
      srv.seen.requests[2].line,
      'POST /rest/integration/hass/statusSubscription HTTP/1.1',
    );
  } finally {
    await srv.close();
  }
});

test('a refused login: 401 or "Not Authorized"; other statuses are HTTP errors', async () => {
  const answers = [
    http(401, ''),
    http(200, 'Not Authorized'),
    http(500, 'oops'),
    http(200, 'not json'),
  ];
  const srv = await server(() => answers.shift());
  try {
    const client = new NaswebClient();
    await assert.rejects(client.deviceInfo(options(srv.port)), { kind: ERROR_KINDS.AUTH });
    await assert.rejects(client.deviceInfo(options(srv.port)), { kind: ERROR_KINDS.AUTH });
    await assert.rejects(client.deviceInfo(options(srv.port)), (err) => {
      assert.equal(err.kind, ERROR_KINDS.HTTP);
      assert.ok(!err.message.includes('oops'), 'no byte of the answer in the message');
      return true;
    });
    await assert.rejects(client.deviceInfo(options(srv.port)), { kind: ERROR_KINDS.PROTOCOL });
  } finally {
    await srv.close();
  }
});

test('bounded: an answer too large, a silent module, nobody listening', async () => {
  const big = 'x'.repeat(70 * 1024);
  const answers = [http(200, big), 'silent'];
  const srv = await server(() => answers.shift());
  try {
    const client = new NaswebClient();
    await assert.rejects(client.deviceInfo(options(srv.port)), { kind: ERROR_KINDS.PROTOCOL });
    const started = Date.now();
    await assert.rejects(
      client.setOutput({ ...options(srv.port), timeoutMs: 300 }, 1, true),
      (err) => err.kind === ERROR_KINDS.TIMEOUT && !notSent(err),
    );
    assert.ok(Date.now() - started < 2000);
  } finally {
    await srv.close();
  }
  await assert.rejects(new NaswebClient().deviceInfo(options(srv.port)), (err) => notSent(err));
});

test('the fixture certificates are distinct (the pin test means something)', () => {
  assert.notEqual(PIN, OTHER_PIN);
  assert.equal(
    createHash('sha256').update(new X509Certificate(CERT).raw).digest('hex').toUpperCase(),
    PIN.replace(/:/g, ''),
  );
});
