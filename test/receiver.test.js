// -----------------------------------------------------------------------------
// The push receiver (sub-container) for real: its HTTP server on a free port,
// its channel, and the main container's ChannelClient. Exact method and
// path, the token, the size, the rate, and the relay of each push.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import * as netModule from 'node:net';
import { ChannelClient, createChannelServer } from '../src/channel.js';
import { isPushPath, startPushService } from '../src/push/service.js';

const PUSH = 'p'.repeat(40);
const CHANNEL = 'c'.repeat(40);

function send(port, { method = 'POST', path = `/nasweb/${PUSH}`, body = '{}', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The receiver on the loopback; `now` is the clock, every other key goes to its env. */
async function service({ now, ...env } = {}) {
  return startPushService({
    env: {
      PUSH_TOKEN: PUSH,
      CHANNEL_TOKEN: CHANNEL,
      HTTP_PORT: '0',
      CHANNEL_PORT: '0',
      HTTP_HOST: '127.0.0.1',
      ...env,
    },
    ...(now ? { now } : {}),
  });
}

function client(port, token = CHANNEL) {
  const channel = new ChannelClient({ host: '127.0.0.1', port, token, delays: [20] });
  const messages = [];
  channel.on('message', (m) => messages.push(m));
  const up = new Promise((resolve) => channel.once('up', resolve));
  channel.start();
  return { channel, messages, up };
}

const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('the push path: exact, with the right token only', () => {
  assert.equal(isPushPath(`/nasweb/${PUSH}`, PUSH), true);
  for (const path of [
    `/nasweb/${PUSH}/`,
    `/nasweb/${PUSH}?a=1`,
    `/nasweb/${'q'.repeat(40)}`,
    `/NASWEB/${PUSH}`,
    `/api/nasweb/${PUSH}`,
    '/nasweb/',
  ]) {
    assert.equal(isPushPath(path, PUSH), false, path);
  }
  assert.equal(isPushPath('/nasweb/', ''), false, 'no token: nothing accepted');
  assert.equal(
    isPushPath(`/nasweb/${'x'.repeat(31)}`, 'x'.repeat(31)),
    false,
    'a short token is refused',
  );
});

test('a push is relayed to the main container, with its source address', async () => {
  const svc = await service();
  const main = client(svc.channel.port);
  try {
    await main.up;
    const body = JSON.stringify({ type: 'status_update', device_serial: '1234' });
    const answer = await send(svc.port, { body, headers: { 'Content-Type': 'application/json' } });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.text), { response: 'ok' });
    await until(() => main.messages.length > 0);
    const [message] = main.messages;
    assert.equal(message.type, 'push');
    assert.equal(message.from, '127.0.0.1');
    assert.equal(message.body, body);
    assert.ok(Number.isFinite(Date.parse(message.at)));
  } finally {
    main.channel.stop();
    await svc.stop();
  }
});

test('refused: another path or token (404), another method (405), too large (413)', async () => {
  const svc = await service();
  const main = client(svc.channel.port);
  try {
    await main.up;
    assert.equal((await send(svc.port, { path: `/nasweb/${'q'.repeat(40)}` })).status, 404);
    assert.equal((await send(svc.port, { path: '/' })).status, 404);
    assert.equal((await send(svc.port, { method: 'GET', body: undefined })).status, 405);
    assert.equal((await send(svc.port, { method: 'PUT' })).status, 405);
    const big = 'x'.repeat(33 * 1024);
    assert.equal((await send(svc.port, { body: big })).status, 413);
    // Chunked (no length announced): counted as it comes.
    const chunked = await send(svc.port, {
      body: big,
      headers: { 'Transfer-Encoding': 'chunked' },
    }).catch(() => ({ status: 413 }));
    assert.equal(chunked.status, 413);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(main.messages.length, 0, 'nothing refused reaches the main container');
  } finally {
    main.channel.stop();
    await svc.stop();
  }
});

test('over 60 a minute from one source: the latest post is kept and sent once the window frees', async () => {
  let time = 0;
  const svc = await service({ now: () => time });
  const main = client(svc.channel.port);
  try {
    await main.up;
    for (let i = 0; i < 60; i += 1) {
      assert.equal((await send(svc.port, { body: `{"n":${i}}` })).status, 200);
    }
    await until(() => main.messages.length === 60);
    time = 59_950; // the window frees in 50 ms
    assert.equal((await send(svc.port, { body: '{"n":61}' })).status, 200);
    assert.equal((await send(svc.port, { body: '{"n":62}' })).status, 200);
    assert.equal(main.messages.length, 60, 'held, not sent over the budget');
    await until(() => main.messages.length === 61);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      main.messages.slice(60).map((m) => JSON.parse(m.body).n),
      [62],
      'only the latest, with its own time',
    );
    assert.equal(main.messages[60].at, new Date(59_950).toISOString());
  } finally {
    main.channel.stop();
    await svc.stop();
  }
});

test('the address of the module has the whole budget (240 a minute)', async () => {
  const svc = await startPushService({
    env: {
      PUSH_TOKEN: PUSH,
      CHANNEL_TOKEN: CHANNEL,
      HTTP_PORT: '0',
      CHANNEL_PORT: '0',
      HTTP_HOST: '127.0.0.1',
      DEVICE_ADDRESS: '127.0.0.1',
    },
    now: () => 0,
  });
  try {
    for (let i = 0; i < 240; i += 1) {
      assert.equal((await send(svc.port)).status, 200);
    }
    assert.equal((await send(svc.port)).status, 429);
  } finally {
    await svc.stop();
  }
});

/** Silent connections from `sources`, opened again as soon as they are closed, until stopped. */
function silentAttack(port, sources, perSource) {
  const { connect } = netModule;
  let running = true;
  const open = (localAddress) => {
    if (!running) return;
    const socket = connect({ host: '127.0.0.1', port, localAddress });
    socket.on('error', () => {});
    socket.resume();
    socket.on('close', () => setTimeout(() => open(localAddress), 1));
  };
  for (const source of sources) {
    for (let i = 0; i < perSource; i += 1) open(source);
  }
  return () => {
    running = false;
  };
}

/** Posts from the module (127.0.0.1) every 200 ms for 3 s: the statuses answered. */
async function modulePosts(port) {
  const answers = [];
  for (let i = 0; i < 15; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    answers.push(
      await new Promise((resolve) => {
        const req = request(
          {
            host: '127.0.0.1',
            localAddress: '127.0.0.1',
            port,
            method: 'POST',
            path: `/nasweb/${PUSH}`,
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.setTimeout(1500, () => req.destroy());
        req.on('error', (err) => resolve(err.code ?? 'error'));
        req.end('{}');
      }),
    );
  }
  return answers;
}

test('(a) silent connections from the same apparent address: the module stays served', async () => {
  const svc = await service({ IDLE_MS: '400' });
  const stop = silentAttack(svc.port, ['127.0.0.1'], 8);
  try {
    await new Promise((r) => setTimeout(r, 300));
    const answers = await modulePosts(svc.port);
    assert.deepEqual(answers, Array(15).fill(200));
  } finally {
    stop();
    await svc.stop();
  }
});

test('(b) 8 addresses × 4 silent connections, sender checked: the module stays served', async () => {
  const svc = await startPushService({
    env: {
      PUSH_TOKEN: PUSH,
      CHANNEL_TOKEN: CHANNEL,
      HTTP_PORT: '0',
      CHANNEL_PORT: '0',
      HTTP_HOST: '127.0.0.1',
      DEVICE_ADDRESS: '127.0.0.1',
      IDLE_MS: '400',
    },
  });
  const sources = Array.from({ length: 8 }, (_, i) => `127.0.0.${i + 2}`);
  const stop = silentAttack(svc.port, sources, 5);
  try {
    await new Promise((r) => setTimeout(r, 300));
    const answers = await modulePosts(svc.port);
    assert.deepEqual(answers, Array(15).fill(200));
    const held = await new Promise((resolve) => svc.http.getConnections((_, n) => resolve(n)));
    assert.ok(held <= 33, `${held} connections held`);
  } finally {
    stop();
    await svc.stop();
  }
});

test('with DEVICE_ADDRESS, another sender gets 403 before any budget; the main container is told', async () => {
  const svc = await startPushService({
    env: {
      PUSH_TOKEN: PUSH,
      CHANNEL_TOKEN: CHANNEL,
      HTTP_PORT: '0',
      CHANNEL_PORT: '0',
      HTTP_HOST: '127.0.0.1',
      DEVICE_ADDRESS: '192.168.1.50',
    },
  });
  const main = client(svc.channel.port);
  try {
    await main.up;
    for (let i = 0; i < 100; i += 1) {
      assert.equal((await send(svc.port, { body: '{"x":1}' })).status, 403);
    }
    await until(() => main.messages.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(main.messages.length, 1, 'one notice per 10 s, never the body');
    assert.deepEqual(Object.keys(main.messages[0]).sort(), ['at', 'from', 'type']);
    assert.equal(main.messages[0].type, 'refused');
  } finally {
    main.channel.stop();
    await svc.stop();
  }
});

test('idle connections: closed from their acceptance; capped in all and per source', async () => {
  const { connect } = await import('node:net');
  const fast = await startPushService({
    env: {
      PUSH_TOKEN: PUSH,
      CHANNEL_TOKEN: CHANNEL,
      HTTP_PORT: '0',
      CHANNEL_PORT: '0',
      HTTP_HOST: '127.0.0.1',
      IDLE_MS: '300',
    },
  });
  try {
    const closed = [];
    for (let i = 0; i < 300; i += 1) {
      const socket = connect({ host: '127.0.0.1', port: fast.port });
      socket.on('error', () => {});
      socket.resume();
      socket.on('close', () => closed.push(i));
    }
    await until(() => closed.length >= 296);
    const held = await new Promise((resolve) => fast.http.getConnections((_, n) => resolve(n)));
    assert.ok(held <= 4, `${held} connections held for one source address`);
    for (let i = 0; i < 300 && closed.length < 300; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(closed.length, 300, 'the idle ones closed too');
    const started = Date.now();
    assert.equal((await send(fast.port)).status, 200);
    assert.ok(Date.now() - started < 1000);
  } finally {
    await fast.stop();
  }
});

test('while the main container is away, only the latest pushes are kept', async () => {
  const svc = await service();
  try {
    for (let i = 0; i < 8; i += 1) {
      await send(svc.port, { body: `{"n":${i}}` });
    }
    const main = client(svc.channel.port);
    await main.up;
    await until(() => main.messages.length >= 5);
    assert.deepEqual(
      main.messages.map((m) => JSON.parse(m.body).n),
      [3, 4, 5, 6, 7],
    );
    main.channel.stop();
  } finally {
    await svc.stop();
  }
});

test('the channel: a client without the secret gets nothing', async () => {
  const svc = await service();
  const intruder = client(svc.channel.port, 'w'.repeat(40));
  let up = false;
  intruder.channel.on('up', () => (up = true));
  try {
    await send(svc.port);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(up, false);
    assert.equal(intruder.messages.length, 0);
  } finally {
    intruder.channel.stop();
    await svc.stop();
  }
});

test('the channel: a line too long drops the connection; lines split anywhere are joined', async () => {
  const server = createChannelServer({ port: 0, host: '127.0.0.1', token: CHANNEL });
  await server.start();
  const main = client(server.port);
  try {
    await main.up;
    server.send({ type: 'push', body: 'y'.repeat(200 * 1024) });
    await until(() => main.messages.length === 1);
    assert.equal(main.messages[0].body.length, 200 * 1024);
    server.send({ type: 'push', body: 'z'.repeat(300 * 1024) });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(main.messages.length, 1, 'over 256 KB: dropped');
  } finally {
    main.channel.stop();
    await server.stop();
  }
});
