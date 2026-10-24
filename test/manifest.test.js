// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. No version is
// written here: the versions must only agree (the Release workflow bumps them).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, TOKEN_KEYS } from '../src/config.js';
import { ACTIONS, RECEIVER } from '../src/constants.js';
import { CHANNEL_PORT } from '../src/channel.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics; the versions agree (semver, never a fixed one)', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-nasweb:${manifest.version}`);
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+nasWebio|sans\s+lien\s+avec\s+nasWebio/i);
    assert.match(docs, /never\s+tested\s+with\s+a\s+real|jamais\s+testé\s+avec\s+un\s+vrai/i);
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the push receiver sub-container: same image, its command, one HTTP port', () => {
  assert.equal(manifest.containers.length, 1);
  const [receiver] = manifest.containers;
  assert.equal(receiver.name, RECEIVER.name);
  assert.equal(receiver.docker_image, manifest.docker_image, 'released with the main image');
  assert.deepEqual(receiver.command, ['node', 'src/receiver.js']);
  assert.equal(receiver.start, 'manual', 'started by the app, with its secrets in env');
  assert.equal(receiver.read_only, true);
  assert.equal(receiver.env, undefined, 'the manifest is public: no secret here');
  assert.equal(receiver.devices, undefined);
  assert.equal(receiver.volumes, undefined);
  assert.deepEqual(
    receiver.ports.map((port) => [port.container_port, port.protocol, port.name, port.browsable]),
    [[RECEIVER.httpPort, 'tcp', RECEIVER.httpPortName, false]],
  );
  assert.equal(RECEIVER.channelPort, CHANNEL_PORT, 'the channel port is never published');
  const names = receiver.ports.map((port) => port.name);
  for (const [, text] of texts(manifest.config_schema)) {
    for (const lang of ['en', 'fr']) {
      for (const [, name] of (text[lang] ?? '').matchAll(/\{\{port:([^}]+)\}\}/g)) {
        assert.ok(names.includes(name), `{{port:${name}}}`);
      }
    }
  }
});

test('the configuration matches the code; safe defaults; no default on a secret', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    if (fields[key].type !== 'secret') {
      assert.deepEqual(fields[key].default, value, key);
    }
  }
  for (const field of manifest.config_schema) {
    if (field.type === 'secret') {
      assert.equal(field.default, undefined, `${field.key}: never a default on a secret`);
    } else if (field.default !== undefined) {
      assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
    }
  }
  assert.equal(fields.password.type, 'secret', 'the password is never sent back to the browser');
  assert.equal(fields.allow_commands.default, false, 'commands off by default');
  assert.equal(fields.safe_outputs.default, '', 'no output safe by default');
  assert.equal(fields.check_push_source.default, true);
  for (const key of Object.values(TOKEN_KEYS)) {
    assert.ok(!(key in fields), `${key} stays out of the config_schema (never shown)`);
  }
  // Gladys stores the keys upper-cased and hands GLADYS_* back as is (reserved
  // namespace): a "gladys_..." key would never reach the integration.
  for (const key of [...Object.keys(fields), ...Object.values(TOKEN_KEYS)]) {
    assert.match(key, /^[a-z0-9_]+$/, key);
    assert.ok(!key.toUpperCase().startsWith('GLADYS_'), `${key}: reserved prefix`);
  }
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(
      section.required ?? section.default ?? section.placeholder,
      undefined,
      section.key,
    );
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the actions are the ones the code handles; nothing else declared', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  for (const key of [
    'scene_actions',
    'scene_triggers',
    'widgets',
    'webhooks',
    'network_discovery',
  ]) {
    assert.equal(manifest[key], undefined, key);
  }
});

test('the image ships the license and the third-party notices', () => {
  const dockerfile = read('Dockerfile');
  const copies = dockerfile
    .split('\n')
    .filter((line) => line.startsWith('COPY '))
    .join(' ');
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'gladys-assistant-integration.json']) {
    assert.match(copies, new RegExp(`\\b${file.replace('.', '\\.')}\\b`), file);
    assert.ok(read(file).length > 100, file);
  }
  assert.ok(
    !read('.dockerignore')
      .split('\n')
      .some((l) => /^(LICENSE|THIRD_PARTY)/.test(l.trim())),
  );
});
