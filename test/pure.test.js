// -----------------------------------------------------------------------------
// The pure parts: the configuration, the status pushed by the module, the
// devices built from it, the state kept in /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionKey,
  normalizeConfig,
  normalizeIp,
  parseDeviceAddress,
  parseGladysAddress,
  parseSafeOutputs,
} from '../src/config.js';
import { buildModel, onOff } from '../src/model.js';
import { parsePush, temperatureOf } from '../src/nasweb/status.js';
import { emptyMemory, normalizeMemory, serializeMemory } from '../src/store.js';

const externalIds = (type, key) => ({
  device: `ext:nasweb:${type}:${key}`,
  feature: (role) => `ext:nasweb:${type}:${key}:${role}`,
});

test('the address of the module: an IP, optionally a port; never a name', () => {
  assert.deepEqual(parseDeviceAddress('192.168.1.50'), { host: '192.168.1.50', port: 443 });
  assert.deepEqual(parseDeviceAddress(' https://192.168.1.50:8443/ '), {
    host: '192.168.1.50',
    port: 8443,
  });
  assert.deepEqual(parseDeviceAddress('[FD00::5]:443'), { host: 'fd00::5', port: 443 });
  for (const bad of [
    'nasweb.local',
    '192.168.1.50:0',
    '192.168.1.50:70000',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    'a b',
    'user@192.168.1.5',
  ]) {
    assert.ok(parseDeviceAddress(bad).error, bad);
  }
  assert.deepEqual(parseDeviceAddress(''), { error: 'empty' });
  assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
});

test('the address of Gladys: an IP or a host name, without a port', () => {
  assert.deepEqual(parseGladysAddress('192.168.1.10'), { host: '192.168.1.10' });
  assert.deepEqual(parseGladysAddress('Gladys.lan'), { host: 'gladys.lan' });
  assert.deepEqual(parseGladysAddress(''), { host: undefined });
  for (const bad of ['192.168.1.10:80', 'http://x', 'a b', '-x.lan']) {
    assert.ok(parseGladysAddress(bad).error, bad);
  }
});

test('outputs declared safe: numbers only; the rest counted, never shown', () => {
  const { safe, invalid } = parseSafeOutputs('1, 2;5\n7 x secret-key 1234');
  assert.deepEqual([...safe], [1, 2, 5, 7]);
  assert.equal(invalid, 3);
});

test('the configuration: safe defaults, credentials required, strict booleans', () => {
  const empty = normalizeConfig({});
  assert.equal(empty.problem, 'device:empty');
  assert.equal(empty.allowCommands, false);
  assert.equal(empty.checkPushSource, true);
  const c = normalizeConfig({
    device_address: '10.0.0.5',
    username: 'admin',
    password: 'p',
    allow_commands: 'yes',
  });
  assert.equal(c.problem, undefined);
  assert.equal(c.allowCommands, false, 'only true allows');
  assert.equal(
    normalizeConfig({ device_address: '10.0.0.5', username: 'admin', password: '' }).problem,
    'password',
  );
  assert.equal(
    normalizeConfig({ device_address: '10.0.0.5', username: 'a\nb', password: 'p' }).problem,
    'username',
  );
  assert.equal(
    normalizeConfig({
      device_address: '10.0.0.5',
      username: 'a',
      password: 'p',
      check_push_source: null,
    }).checkPushSource,
    true,
  );
  assert.equal(normalizeConfig({ __proto__: { allow_commands: true } }).allowCommands, false);
  const a = normalizeConfig({
    device_address: '10.0.0.5',
    username: 'a',
    password: 'p',
    safe_outputs: '1',
  });
  const b = normalizeConfig({
    device_address: '10.0.0.5',
    username: 'a',
    password: 'p',
    safe_outputs: '2',
  });
  assert.equal(connectionKey(a), connectionKey(b), 'options do not restart the session');
});

test('a command value: exactly 0 or 1', () => {
  assert.equal(onOff(1), 1);
  assert.equal(onOff('0'), 0);
  for (const bad of ['', null, undefined, 2, '1.0', true, ' 1']) {
    assert.equal(onOff(bad), undefined, String(bad));
  }
});

test('a pushed status: strict, bounded, unknown never read as off', () => {
  const parsed = parsePush(
    JSON.stringify({
      type: 'status_update',
      device_serial: 'ab-12-cd',
      outputs: [
        { index: 1, status: 'true' },
        { index: '2', status: 'false' },
        { index: 3, status: 'maybe' },
        { index: 1, status: 'false' },
        { index: -1, status: 'true' },
        { index: 1.5, status: 'true' },
        { status: 'true' },
      ],
      inputs: [
        { index: 0, status: 'active' },
        { index: 4, status: 'weird' },
      ],
      device_temp_env: 'N/A',
    }),
  );
  assert.equal(parsed.serial, 'AB12CD');
  assert.deepEqual(
    [...parsed.outputs],
    [
      [1, true],
      [2, false],
      [3, undefined],
    ],
  );
  assert.deepEqual(
    [...parsed.inputs],
    [
      [0, 'active'],
      [4, undefined],
    ],
  );
  assert.equal(parsed.temperature, null);
  assert.equal(parsed.dropped, 4);
  assert.deepEqual(parsePush('{"type":"other"}'), { error: 'type' });
  assert.deepEqual(parsePush('{"type":"status_update"}'), { error: 'serial' });
  assert.deepEqual(parsePush('[1]'), { error: 'json' });
  assert.deepEqual(parsePush('{'), { error: 'json' });
  const many = parsePush(
    JSON.stringify({
      type: 'status_update',
      device_serial: 'AB12',
      outputs: Array.from({ length: 1000 }, (_, i) => ({ index: i, status: 'true' })),
    }),
  );
  assert.equal(many.outputs.size, 64);
  assert.equal(many.inputs, undefined, 'no inputs listed: not "no inputs"');
  const proto = parsePush(
    '{"type":"status_update","device_serial":"AB12","__proto__":{"outputs":[{"index":1,"status":"true"}]}}',
  );
  assert.equal(proto.outputs, undefined);
});

test('the temperature: a number within the range of a probe', () => {
  assert.equal(temperatureOf('21'), 21);
  assert.equal(temperatureOf(' -5.5 '), -5.5);
  assert.equal(temperatureOf(22.25), 22.25);
  assert.equal(temperatureOf('N/A'), null);
  for (const bad of ['', '1e3', '300', 'abc', null, NaN]) {
    assert.equal(temperatureOf(bad), undefined, String(bad));
  }
});

test('the devices: switches for the outputs declared safe only, frozen external ids', () => {
  const model = buildModel({
    externalIds,
    serial: 'AB12',
    name: 'Box',
    outputs: [2, 1],
    inputs: [3],
    temperature: true,
    safeOutputs: new Set([2]),
    language: 'fr',
  });
  assert.deepEqual(
    model.devices.map((d) => [
      d.external_id,
      d.name,
      d.features.map((f) => `${f.category}/${f.type}`),
    ]),
    [
      ['ext:nasweb:module:AB12', 'Box', ['temperature-sensor/decimal']],
      ['ext:nasweb:output:AB12-1', 'Box - sortie 1', ['unknown/binary']],
      ['ext:nasweb:output:AB12-2', 'Box - sortie 2', ['switch/binary']],
      ['ext:nasweb:input:AB12-3', 'Box - entrée 3', ['unknown/binary', 'tamper/binary']],
    ],
  );
  const hidden = model.features.get('ext:nasweb:output:AB12-1:power');
  assert.equal(hidden.spec.hidden, true);
  assert.equal(hidden.spec.refusal, 'unsafeOutput');
  assert.ok(model.throttled.has('ext:nasweb:module:AB12:temperature'));
  assert.deepEqual(buildModel({ externalIds }).devices, [], 'no identity, no device');
});

test('/data: bounded, only known keys, never a secret', () => {
  const now = 1_000_000;
  const memory = normalizeMemory(
    {
      target: '192.168.1.50:443',
      serial: 'ab12',
      pin: 'aa:'.repeat(31) + 'aa',
      refusedPin: 'nope',
      subscribed: { host: '192.168.1.10', port: 41000, tag: '0123abcd' },
      subscribedAt: now + 10_000,
      auth: { blocked: true, tag: 300, salt: 'x' },
      lastTry: now + 99_999,
      password: 'secret',
      __proto__: { pin: 'x' },
    },
    now,
  );
  assert.equal(memory.serial, 'AB12');
  assert.equal(memory.pin, 'AA:'.repeat(31) + 'AA');
  assert.equal(memory.refusedPin, null);
  assert.deepEqual(memory.subscribed, { host: '192.168.1.10', port: 41000, tag: '0123abcd' });
  assert.equal(memory.subscribedAt, now, 'a time in the future is now');
  assert.equal(memory.lastTry, now);
  assert.deepEqual(memory.auth, { blocked: true, tag: null, salt: null });
  assert.ok(!('password' in serializeMemory(memory)));
  assert.deepEqual(
    normalizeMemory({ serial: 'AB12' }, now),
    emptyMemory(),
    'no target, nothing kept',
  );
  assert.deepEqual(normalizeMemory(null, now), emptyMemory());
});
