// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, never
// mojibake (UTF-8 bytes read as Latin-1 / Windows-1252 and saved again), and
// never describe a secret field as "encrypted": Gladys keeps it in its
// database as it is, and only masks it in the interface.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const MOJIBAKE = /[ÂÃ][\u0080-¿€]|â€/;
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'index.js',
  ...readdirSync(new URL('../src', import.meta.url), { recursive: true })
    .filter((name) => String(name).endsWith('.js'))
    .map((name) => `src/${name}`),
];

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake, no control byte, never "encrypted"`, () => {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, 'control byte');
    assert.doesNotMatch(text, /chiffr[ée]|encrypt/i, 'a secret field is not encrypted by Gladys');
  });
}

test('the mojibake pattern catches what it should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app…', MOJIBAKE);
});
