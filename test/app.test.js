// -----------------------------------------------------------------------------
// NaswebApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a fake module behind the client interface (it calls
// trust() and beforeSend() like the real TLS client), a memory store, a fake
// channel to the receiver and timers driven by the tests.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NaswebApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { DeviceError, ERROR_KINDS } from '../src/nasweb/http.js';
import { memoryStore } from '../src/store.js';

const SELECTOR = 'nasweb';
const SERIAL = 'AB12CD34';
const PIN = Array.from({ length: 32 }, () => 'AA').join(':');
const OTHER_PIN = Array.from({ length: 32 }, () => 'BB').join(':');
const PORT = 41234;
const id = (type, key, role) => `ext:${SELECTOR}:${type}:${key}${role ? `:${role}` : ''}`;

const CONFIG = {
  device_address: '192.168.1.50',
  username: 'admin',
  password: 'secret-pass',
  callback_address: '192.168.1.10',
  safe_outputs: '1',
  allow_commands: false,
  language: 'en',
};

/** Timers driven by the tests: `fire()` runs the timeouts due at the current time. */
function fakeTimers(clock) {
  let next = 0;
  const list = new Map();
  return {
    setTimeout(fn, ms) {
      next += 1;
      list.set(next, { fn, at: clock.t + ms });
      return next;
    },
    clearTimeout(handle) {
      list.delete(handle);
    },
    setInterval: () => 0,
    clearInterval: () => {},
    fire() {
      for (const [handle, entry] of [...list]) {
        if (entry.at <= clock.t) {
          list.delete(handle);
          entry.fn();
        }
      }
    },
    get size() {
      return list.size;
    },
  };
}

/** The module behind the client interface: trust() first, beforeSend() right before "writing". */
class FakeModule {
  constructor() {
    this.fingerprint = PIN;
    this.serial = SERIAL;
    this.name = 'Garage';
    this.loginOk = true;
    this.answerOk = true;
    this.fail = undefined;
    this.written = [];
    this.subscriptions = [];
    this.onSet = undefined;
  }

  async run(options, kind, fn) {
    try {
      await options.trust(this.fingerprint);
    } catch (err) {
      throw Object.assign(
        err instanceof DeviceError ? err : new DeviceError(ERROR_KINDS.REFUSED, 'x'),
        {
          notSent: true,
        },
      );
    }
    if (this.fail) {
      throw this.fail;
    }
    try {
      options.beforeSend?.();
    } catch (err) {
      throw new DeviceError(ERROR_KINDS.REFUSED, 'Refused', { notSent: true, cause: err });
    }
    this.written.push(kind);
    if (!this.loginOk) {
      throw new DeviceError(ERROR_KINDS.AUTH, 'Login refused');
    }
    return fn();
  }

  deviceInfo(options) {
    return this.run(options, 'info', () => ({ serial: this.serial, name: this.name }));
  }

  setOutput(options, index, state) {
    return this.run(options, 'set', () => {
      this.onSet?.(index, state);
      return this.answerOk;
    });
  }

  subscription(options, address, subscribe) {
    return this.run(options, 'subscription', () => {
      this.subscriptions.push([address, subscribe]);
      return true;
    });
  }
}

class FakeChannel extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
};

const status = (
  outputs = { 1: true, 2: false },
  inputs = { 1: 'normal', 2: 'tamper' },
  temp = '21',
) =>
  JSON.stringify({
    type: 'status_update',
    device_serial: SERIAL,
    outputs: Object.entries(outputs).map(([index, s]) => ({
      index: Number(index),
      status: String(s),
    })),
    inputs: Object.entries(inputs).map(([index, s]) => ({ index: Number(index), status: s })),
    device_temp_env: temp,
  });

async function setup({
  config = CONFIG,
  store = memoryStore(),
  module = new FakeModule(),
  connect = true,
} = {}) {
  const clock = { t: 10_000_000 };
  const timers = fakeTimers(clock);
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...config },
    containers: [
      {
        name: 'nasweb-push',
        status: 'running',
        ports: [
          {
            container_port: 8080,
            protocol: 'tcp',
            host_port: PORT,
            name: 'nasweb_push',
            browsable: false,
          },
        ],
      },
    ],
  });
  const channels = [];
  const app = new NaswebApp({
    gladys,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    client: module,
    store,
    now: () => clock.t,
    clock: () => clock.t,
    timers,
    createChannel: (options) => {
      const channel = new FakeChannel(options);
      channels.push(channel);
      return channel;
    },
  });
  registerHandlers(gladys, app);
  const env = {
    gladys,
    app,
    module,
    store,
    clock,
    timers,
    channels,
    /** A push from `from`, as the receiver relays it. */
    push(body = status(), from = '192.168.1.50') {
      channels
        .at(-1)
        .emit('message', { type: 'push', from, at: new Date(clock.t).toISOString(), body });
    },
    async advance(ms) {
      clock.t += ms;
      timers.fire();
      await settle();
    },
    async createAll() {
      for (const device of gladys.fake.discoveredDevices) {
        await gladys.fake.deviceCreated(device);
      }
      await app.publisher.flush();
    },
    device(externalId) {
      return gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
    },
  };
  if (connect) {
    await gladys.connect();
    await settle();
    await app.reading;
    await settle();
  }
  return env;
}

test('first start: pinned, identified, the receiver started, the module subscribed', async () => {
  const { gladys, app, module, store, channels } = await setup();
  assert.equal(store.data.pin, PIN, 'pinned at the first connection');
  assert.equal(store.data.serial, SERIAL);
  const tokens = gladys.fake.config;
  assert.match(tokens.push_token, /^[A-Za-z0-9_-]{32}$/);
  assert.match(tokens.channel_token, /^[A-Za-z0-9_-]{32}$/);
  const start = gladys.fake.bodies('POST', '/container/nasweb-push/start')[0];
  assert.deepEqual(start.env, {
    PUSH_TOKEN: tokens.push_token,
    CHANNEL_TOKEN: tokens.channel_token,
    HTTP_PORT: '8080',
    CHANNEL_PORT: '7778',
  });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].options.token, tokens.channel_token);
  assert.equal(channels[0].options.host, 'nasweb-push');
  assert.deepEqual(module.subscriptions, [
    [`http://192.168.1.10:${PORT}/nasweb/${tokens.push_token}`, true],
  ]);
  const saved = JSON.stringify(store.data);
  for (const secret of [tokens.push_token, tokens.channel_token, 'secret-pass', 'admin']) {
    assert.ok(!saved.includes(secret), 'no secret nor credential in /data');
  }
  assert.equal(gladys.fake.connectionStatus.connected, false, 'waiting for the first status');
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /waiting for its first status at 192\.168\.1\.10:41234/,
  );
  assert.ok(!JSON.stringify(gladys.fake.connectionStatuses).includes(tokens.push_token));
  app.stop();
});

test('a push: devices discovered, states published, connected', async () => {
  const env = await setup();
  const { gladys, app } = env;
  env.push();
  await env.advance(1500);
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [
      id('module', SERIAL),
      id('output', `${SERIAL}-1`),
      id('output', `${SERIAL}-2`),
      id('input', `${SERIAL}-1`),
      id('input', `${SERIAL}-2`),
    ],
  );
  const safe = env.device(id('output', `${SERIAL}-1`));
  assert.deepEqual(
    safe.features.map((f) => [f.external_id.split(':').at(-1), f.category, f.type, f.read_only]),
    [['power', 'switch', 'binary', false]],
  );
  const unsafe = env.device(id('output', `${SERIAL}-2`));
  assert.deepEqual(
    unsafe.features.map((f) => [f.external_id.split(':').at(-1), f.category, f.type, f.read_only]),
    [['state', 'unknown', 'binary', true]],
    'an output not declared safe: read only, never a switch',
  );
  const input = env.device(id('input', `${SERIAL}-2`));
  assert.deepEqual(
    input.features.map((f) => [f.category, f.type]),
    [
      ['unknown', 'binary'],
      ['tamper', 'binary'],
    ],
  );
  assert.equal(env.device(id('module', SERIAL)).features[0].unit, 'celsius');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  await env.createAll();
  assert.equal(gladys.fake.lastState(id('output', `${SERIAL}-1`, 'power')), 1);
  assert.equal(gladys.fake.lastState(id('output', `${SERIAL}-2`, 'state')), 0);
  assert.equal(gladys.fake.lastState(id('input', `${SERIAL}-1`, 'input')), 0);
  assert.equal(gladys.fake.lastState(id('input', `${SERIAL}-2`, 'fault')), 1);
  assert.equal(
    gladys.fake.lastState(id('input', `${SERIAL}-2`, 'input')),
    undefined,
    'tamper: no active state',
  );
  assert.equal(gladys.fake.lastState(id('module', SERIAL, 'temperature')), 21);
  app.stop();
});

test('pushes refused: another source address, another serial, a stale one', async () => {
  const env = await setup();
  const { gladys, app } = env;
  env.push(status(), '192.168.1.99');
  await env.advance(1500);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /refused: they came from 192\.168\.1\.99/);
  env.push(status().replace(SERIAL, 'FFFF0000'));
  await env.advance(1500);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /another serial number/);
  env.channels[0].emit('message', {
    type: 'push',
    from: '192.168.1.50',
    at: new Date(env.clock.t - 120_000).toISOString(),
    body: status(),
  });
  await env.advance(1500);
  assert.equal(gladys.fake.discoveredDevices.length, 0, 'kept too long by the receiver');
  // "Check the sender" off: the address is no longer compared (the serial still is).
  await gladys.fake.configUpdated({ ...gladys.fake.config, check_push_source: false });
  env.push(status(), '172.30.0.1');
  await env.advance(1500);
  assert.equal(gladys.fake.discoveredDevices.length, 5);
  app.stop();
});

test('commands: off by default, never on an output not declared safe', async () => {
  const env = await setup();
  const { gladys, app, module } = env;
  env.push();
  await env.advance(1500);
  await env.createAll();
  const safe = env.device(id('output', `${SERIAL}-1`));
  const ack = await gladys.fake.setValue(safe, safe.features[0], 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Commands are off/);
  const unsafe = env.device(id('output', `${SERIAL}-2`));
  const refused = await gladys.fake.setValue(unsafe, unsafe.features[0], 1);
  assert.equal(refused.success, false);
  assert.match(refused.error, /read only/);
  // Even a hand-made command on the hidden switch of output 2 is refused.
  const hidden = await gladys.fake.setValue(
    unsafe,
    { external_id: id('output', `${SERIAL}-2`, 'power') },
    1,
  );
  assert.match(hidden.error, /not declared safe/);
  assert.ok(!module.written.includes('set'), 'nothing sent');
  app.stop();
});

test('a command: identity read first, then the write, confirmed by a push', async () => {
  const env = await setup({ config: { ...CONFIG, allow_commands: true } });
  const { gladys, app, module } = env;
  env.push();
  await env.advance(1500);
  await env.createAll();
  module.written = [];
  module.onSet = (index, state) => {
    setImmediate(() => env.push(status({ 1: state, 2: false })));
  };
  const safe = env.device(id('output', `${SERIAL}-1`));
  const ack = await gladys.fake.setValue(safe, safe.features[0], 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(module.written, ['info', 'set'], 'identity read before the write');
  await app.publisher.flush();
  assert.equal(gladys.fake.lastState(id('output', `${SERIAL}-1`, 'power')), 0);
  app.stop();
});

test('a command: not confirmed in time is "sent, without confirmation"; an error answer is said', async () => {
  const env = await setup({ config: { ...CONFIG, allow_commands: true } });
  const { gladys, app, module } = env;
  env.push();
  await env.advance(1500);
  const safe = env.device(id('output', `${SERIAL}-1`));
  const pending = gladys.fake.setValue(safe, safe.features[0], 0);
  await settle();
  await env.advance(5000);
  const ack = await pending;
  assert.match(ack.error, /Sent, without confirmation/);
  env.push();
  module.answerOk = false;
  const rejected = await gladys.fake.setValue(safe, safe.features[0], 0);
  assert.match(rejected.error, /answered that the command failed/);
  app.stop();
});

test('a command: refused without a recent push, with another module, or too late', async () => {
  const env = await setup({ config: { ...CONFIG, allow_commands: true } });
  const { gladys, app, module } = env;
  env.push();
  await env.advance(1500);
  const safe = env.device(id('output', `${SERIAL}-1`));
  await env.advance(95_000);
  const stale = await gladys.fake.setValue(safe, safe.features[0], 1);
  assert.match(stale.error, /No recent status/);
  env.push();
  module.written = [];
  module.serial = 'FFFF0000';
  const other = await gladys.fake.setValue(safe, safe.features[0], 1);
  assert.match(other.error, /not the known one/);
  assert.deepEqual(module.written, ['info'], 'only the identity read, never the write');
  assert.equal(env.store.data.otherSerial, 'FFFF0000');
  assert.match(gladys.fake.connectionStatus.message.en, /Another module answers/);
  app.stop();
});

test('a command: the option turned off during the identity read stops it before the write', async () => {
  const env = await setup({ config: { ...CONFIG, allow_commands: true } });
  const { gladys, app, module } = env;
  env.push();
  await env.advance(1500);
  const safe = env.device(id('output', `${SERIAL}-1`));
  const info = module.deviceInfo.bind(module);
  module.deviceInfo = async (options) => {
    const result = await info(options);
    await gladys.fake.configUpdated({ ...gladys.fake.config, allow_commands: false });
    return result;
  };
  module.written = [];
  const ack = await gladys.fake.setValue(safe, safe.features[0], 1);
  assert.match(ack.error, /Commands are off/);
  assert.deepEqual(module.written, ['info']);
  app.stop();
});

test('the certificate changed: nothing sent; trusted again in two clicks only', async () => {
  const env = await setup();
  const { gladys, app, module, store } = env;
  module.fingerprint = OTHER_PIN;
  module.written = [];
  await env.advance(60_000);
  await app.tick();
  await settle();
  assert.deepEqual(module.written, [], 'the login never left');
  assert.equal(store.data.pin, PIN);
  assert.equal(store.data.refusedPin, OTHER_PIN);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /certificate of the module changed \(now BB:BB/,
  );
  const first = await gladys.fake.action('trust_device');
  assert.match(first.data.message.en, /certificate BB:BB/);
  assert.equal(store.data.pin, PIN, 'the first click trusts nothing');
  await env.advance(61_000);
  const late = await gladys.fake.action('trust_device');
  assert.match(late.data.message.en, /Press again within 60 s/, 'too late: a first click again');
  await gladys.fake.action('trust_device');
  assert.equal(store.data.pin, OTHER_PIN);
  assert.equal(store.data.refusedPin, null);
  assert.ok(module.written.includes('info'));
  app.stop();
});

test('a refused login: stop persisted, no automatic retry; other credentials lift it', async () => {
  const module = new FakeModule();
  module.loginOk = false;
  const store = memoryStore();
  const env = await setup({ module, store });
  const { gladys, app } = env;
  assert.equal(store.data.auth.blocked, true);
  assert.ok(Number.isInteger(store.data.auth.tag) && store.data.auth.tag < 256);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the login/);
  const count = module.written.length;
  for (let i = 0; i < 5; i += 1) {
    await env.advance(120_000);
    await app.tick();
  }
  assert.equal(module.written.length, count, 'never tried again by itself');
  // A restart with the same credentials: still stopped.
  app.stop();
  const again = await setup({ module, store });
  assert.equal(module.written.length, count);
  again.app.stop();
  // New credentials saved: tried again.
  module.loginOk = true;
  await again.gladys.connect();
  await again.gladys.fake.configUpdated({ ...again.gladys.fake.config, password: 'new-pass' });
  await settle();
  await again.app.reading;
  assert.equal(store.data.auth.blocked, false);
  again.app.stop();
});

test('never read faster than the interval: restart, connected, scan, unchanged save', async () => {
  const store = memoryStore();
  const first = await setup({ store });
  const reads = () => first.module.written.filter((w) => w === 'info').length;
  assert.equal(reads(), 1);
  first.app.stop();
  const env = await setup({ store, module: first.module });
  assert.equal(reads(), 1, 'restarted within the minute: no read');
  await env.gladys.fake.scanRequest();
  await env.gladys.fake.configUpdated({ ...env.gladys.fake.config });
  await env.app.gladysConnected(env.gladys.fake.config);
  await settle();
  assert.equal(reads(), 1);
  env.app.stop();
});

test('connected again: the status and the Discovery are sent again', async () => {
  const env = await setup();
  const { gladys, app } = env;
  env.push();
  await env.advance(1500);
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  await app.gladysConnected(gladys.fake.config);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
  app.stop();
});

test('a switch created before the output left "Outputs declared safe" keeps its feature and refuses', async () => {
  const env = await setup({ config: { ...CONFIG, allow_commands: true } });
  const { gladys, app } = env;
  env.push();
  await env.advance(1500);
  await env.createAll();
  await gladys.fake.configUpdated({ ...gladys.fake.config, safe_outputs: '' });
  await settle();
  const device = env.device(id('output', `${SERIAL}-1`));
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)).sort(),
    ['power', 'state'],
    'the created switch is kept (never a lost feature), the state added',
  );
  const ack = await gladys.fake.setValue(
    device,
    { external_id: id('output', `${SERIAL}-1`, 'power') },
    1,
  );
  assert.match(ack.error, /not declared safe/);
  app.stop();
});

test('300 states a minute at most, whatever the pushes', async () => {
  const env = await setup();
  const { gladys, app } = env;
  const outputs = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [i, false]));
  const inputs = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [i, 'normal']));
  env.push(status(outputs, inputs));
  await env.advance(1500);
  await env.createAll();
  for (let round = 0; round < 6; round += 1) {
    const flip = round % 2 === 0;
    env.push(
      status(
        Object.fromEntries(Object.keys(outputs).map((k) => [k, flip])),
        Object.fromEntries(Object.keys(inputs).map((k) => [k, flip ? 'active' : 'normal'])),
      ),
    );
    await app.publisher.flush();
    env.clock.t += 1000;
  }
  const counts = gladys.fake
    .bodies('POST', '/state')
    .reduce((n, body) => n + body.states.length, 0);
  assert.ok(counts > 200 && counts <= 300, `${counts} states`);
  app.stop();
});

test('the push URL moves with the address of Gladys: the old one withdrawn', async () => {
  const env = await setup();
  const { gladys, app, module } = env;
  const token = gladys.fake.config.push_token;
  await gladys.fake.configUpdated({ ...gladys.fake.config, callback_address: '192.168.1.11' });
  await settle();
  await app.reading;
  assert.deepEqual(module.subscriptions.slice(1), [
    [`http://192.168.1.10:${PORT}/nasweb/${token}`, false],
    [`http://192.168.1.11:${PORT}/nasweb/${token}`, true],
  ]);
  app.stop();
});

test('without the address of Gladys: no subscription, the status says what to type', async () => {
  const env = await setup({ config: { ...CONFIG, callback_address: '' } });
  assert.deepEqual(env.module.subscriptions, []);
  assert.match(
    env.gladys.fake.connectionStatus.message.en,
    /Type the IP address of the Gladys machine/,
  );
  env.app.stop();
});

test('test button: reads now (even after a refused login), at most every 10 s', async () => {
  const module = new FakeModule();
  module.loginOk = false;
  const env = await setup({ module });
  const { gladys, app } = env;
  module.loginOk = true;
  const answer = await gladys.fake.action('test_connection');
  assert.match(answer.data.message.en, /The module answers: Garage, serial AB12CD34/);
  assert.equal(env.store.data.auth.blocked, false);
  const again = await gladys.fake.action('test_connection');
  assert.match(again.data.message.en, /Wait a few seconds/);
  app.stop();
});
