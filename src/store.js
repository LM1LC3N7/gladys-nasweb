// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in nasweb.json, readable by the container user only (0600):
//
//   target       the address of the module the values below belong to
//   serial, name the identity of the module read at that address (its
//                serial number keys the external ids; another serial at the
//                address is refused until the user trusts it)
//   pin          the SHA-256 fingerprint of the certificate of the module
//                (public: a certificate is no secret), pinned at the first
//                connection, before the login ever left
//   refusedPin, otherSerial   what answered instead, kept for "Trust the
//                device now answering" (two clicks)
//   subscribed   { host, port, tag } of the push URL given to the module: not
//                the token, only 8 hex characters of its hash (the token is
//                random, 32 characters: its hash tells nothing), to withdraw
//                the URL when the address of Gladys changes
//   subscribedAt the time of that subscription
//   auth         { blocked, tag, salt } after the module refused the login:
//                no request before the user changes the credentials or
//                tests the connection; `tag` is 8 bits of a salted hash of
//                the REFUSED credentials only (to notice new credentials
//                saved while the integration was stopped), never of
//                accepted ones, cleared at the first success
//   lastTry      the time of the last read of the module (never faster than
//                the interval, even across restarts)
//
// Never a credential, never a token. Read back bounded, only known keys of
// the expected shape (never an inherited or `__proto__` key).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { normalizeFingerprint } from './nasweb/http.js';
import { cleanName, normalizeSerial } from './nasweb/client.js';
import { parseGladysAddress } from './config.js';

export const STATE_FILE = '/data/nasweb.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 8192 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file; `failing` refuses every save. */
export function memoryStore(initial = null, { failing = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failing) {
        throw new Error('EROFS');
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

export const emptyMemory = () => ({
  target: null,
  serial: null,
  name: '',
  pin: null,
  refusedPin: null,
  otherSerial: null,
  subscribed: null,
  subscribedAt: 0,
  auth: { blocked: false, tag: null, salt: null },
  lastTry: 0,
});

const wallTime = (value, now) => (Number.isFinite(value) && value > 0 ? Math.min(value, now) : 0);

/** The persisted state, repaired and bounded against `now`. */
export function normalizeMemory(raw, now) {
  const memory = emptyMemory();
  const target = own(raw, 'target');
  if (typeof target !== 'string' || target.length > 80) {
    // No module known: nothing else belongs anywhere.
    return memory;
  }
  memory.target = target;
  memory.serial = normalizeSerial(own(raw, 'serial')) ?? null;
  memory.name = cleanName(own(raw, 'name'));
  memory.pin = normalizeFingerprint(own(raw, 'pin')) ?? null;
  memory.refusedPin = memory.pin ? (normalizeFingerprint(own(raw, 'refusedPin')) ?? null) : null;
  memory.otherSerial = memory.serial ? (normalizeSerial(own(raw, 'otherSerial')) ?? null) : null;
  const subscribed = own(raw, 'subscribed');
  const host = parseGladysAddress(own(subscribed, 'host')).host;
  const port = own(subscribed, 'port');
  const tag = own(subscribed, 'tag');
  if (
    host &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65536 &&
    typeof tag === 'string' &&
    /^[0-9a-f]{8}$/.test(tag)
  ) {
    memory.subscribed = { host, port, tag };
    memory.subscribedAt = wallTime(own(raw, 'subscribedAt'), now);
  }
  const auth = own(raw, 'auth');
  const authTag = own(auth, 'tag');
  const salt = own(auth, 'salt');
  if (own(auth, 'blocked') === true) {
    memory.auth = {
      blocked: true,
      tag: Number.isInteger(authTag) && authTag >= 0 && authTag < 256 ? authTag : null,
      salt: typeof salt === 'string' && /^[0-9a-f]{32}$/.test(salt) ? salt : null,
    };
  }
  memory.lastTry = wallTime(own(raw, 'lastTry'), now);
  return memory;
}

export const serializeMemory = (memory) => ({
  target: memory.target,
  serial: memory.serial,
  name: memory.name,
  pin: memory.pin,
  refusedPin: memory.refusedPin,
  otherSerial: memory.otherSerial,
  subscribed: memory.subscribed,
  subscribedAt: memory.subscribedAt,
  auth: memory.auth,
  lastTry: memory.lastTry,
});
