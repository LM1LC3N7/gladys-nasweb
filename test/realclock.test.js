// -----------------------------------------------------------------------------
// The app with the REAL clocks and timers, the real client and a real local
// TLS server playing the module (test certificates of test/fixtures): a read
// leaves at start, the module is subscribed, and a command is confirmed by a
// push posted after its write (lesson of lot 15: one clock reading per
// decision, proven against real time).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NaswebApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

class FakeChannel extends EventEmitter {
  start() {}
  stop() {}
}

test('real time: a read leaves at start, a command is confirmed by a later push', async () => {
  const outputs = { 1: false };
  const paths = [];
  let onSet = () => {};
  const server = tls.createServer(
    { cert: fixture('module-cert.pem'), key: fixture('module-key.pem') },
    (socket) => {
      let text = '';
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        text += chunk;
        const end = text.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/content-length: (\d+)/i.exec(text)?.[1] ?? 0);
        if (text.length < end + 4 + length) return;
        const path = text.split(' ')[1];
        const body = JSON.parse(text.slice(end + 4, end + 4 + length) || '{}');
        paths.push(path.split('/').at(-1));
        let answer = '{"Answer":"OK"}';
        if (path.endsWith('getDeviceInfo')) answer = '{"devSN":"AB-12","devName":"Real"}';
        if (path.endsWith('setOutput')) {
          outputs[body.index] = body.status;
          setTimeout(() => onSet(), 50);
        }
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${answer.length}\r\n\r\n${answer}`);
      });
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const channels = [];
  const gladys = createFakeGladys({
    selector: 'nasweb',
    config: {
      device_address: `127.0.0.1:${server.address().port}`,
      username: 'admin',
      password: 'pass',
      callback_address: '127.0.0.1',
      safe_outputs: '1',
      allow_commands: true,
      language: 'en',
    },
    containers: [
      {
        name: 'nasweb-push',
        status: 'running',
        ports: [{ name: 'nasweb_push', host_port: 41000, container_port: 8080 }],
      },
    ],
  });
  const app = new NaswebApp({
    gladys,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    store: memoryStore(),
    createChannel: () => {
      const channel = new FakeChannel();
      channels.push(channel);
      return channel;
    },
  });
  registerHandlers(gladys, app);
  const push = () =>
    channels[0].emit('message', {
      type: 'push',
      from: '127.0.0.1',
      at: new Date().toISOString(),
      body: JSON.stringify({
        type: 'status_update',
        device_serial: 'AB12',
        outputs: [{ index: 1, status: String(outputs[1]) }],
        inputs: [],
        device_temp_env: 'N/A',
      }),
    });
  try {
    await gladys.connect();
    for (let i = 0; i < 100 && !paths.includes('statusSubscription'); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(
      paths.slice(0, 2),
      ['getDeviceInfo', 'statusSubscription'],
      'a read left at start',
    );
    push();
    await new Promise((r) => setTimeout(r, 1200));
    const device = gladys.fake.discoveredDevices.find(
      (d) => d.external_id === 'ext:nasweb:output:AB12-1',
    );
    assert.ok(device, 'discovered from the push');
    onSet = push;
    const ack = await gladys.fake.setValue(device, device.features[0], 1);
    assert.equal(ack.success, true, ack.error);
    assert.equal(outputs[1], true);
  } finally {
    app.stop();
    await new Promise((r) => server.close(r));
  }
});
