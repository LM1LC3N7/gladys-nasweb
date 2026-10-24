// -----------------------------------------------------------------------------
// The local API of the NASweb module, ported from webio-api 0.1.12 (MIT,
// nasWebio, the library of Home Assistant's NASweb integration):
//
//   POST /rest/integration/hass/getDeviceInfo       { login, password }
//        -> { devSN, devName, ... }
//   POST /rest/integration/hass/setOutput           { login, password, index, status }
//        -> { Answer: "OK" }
//   POST /rest/integration/hass/statusSubscription  { login, password, address, subscribe }
//        -> { Answer: "OK" }; the module then posts its status to `address`
//
// `password` is the SHA-1 of the password, in upper-case hexadecimal, as
// webio-api sends it: it is as good as the password for the module, so it
// is treated as one (never logged, never stored). A 401, or the text "Not
// Authorized", is a refused login.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { ENDPOINTS, LIMITS, NOT_AUTHORIZED } from '../constants.js';
import { DeviceError, ERROR_KINDS, pinnedRequest } from './http.js';

/** The password as the module expects it (webio-api: sha1(password).hexdigest().upper()). */
export const passwordHash = (password) =>
  createHash('sha1').update(String(password), 'utf8').digest('hex').toUpperCase();

/** The serial number of the module, as webio-api keys it: without the dashes, upper case. */
export function normalizeSerial(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const serial = value.replace(/-/g, '').trim().toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(serial) ? serial : undefined;
}

/** A name for Gladys: printable, bounded. */
export const cleanName = (value) =>
  typeof value === 'string'
    ? [...value]
        .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch))
        .join('')
        .trim()
        .slice(0, LIMITS.nameLength)
    : '';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    if (isObject(value)) {
      return value;
    }
  } catch {
    // below
  }
  throw new DeviceError(ERROR_KINDS.PROTOCOL, 'Not the expected JSON');
}

export class NaswebClient {
  constructor({ request = pinnedRequest } = {}) {
    this.request = request;
  }

  /**
   * One call: the target, the credentials, the time left, the pin check
   * (`trust`) and the last check before the write (`beforeSend`).
   * @returns {Promise<string>} the body of a 200 answer
   */
  async call({ target, credentials, path, fields = {}, timeoutMs, trust, beforeSend }) {
    const body = JSON.stringify({
      login: credentials.username,
      password: passwordHash(credentials.password),
      ...fields,
    });
    const answer = await this.request({
      host: target.host,
      port: target.port,
      path,
      body,
      timeoutMs,
      trust,
      beforeSend,
    });
    if (answer.status === 401 || answer.body.trim() === NOT_AUTHORIZED) {
      throw new DeviceError(ERROR_KINDS.AUTH, 'Login refused', { status: answer.status });
    }
    if (answer.status !== 200) {
      throw new DeviceError(ERROR_KINDS.HTTP, `HTTP ${answer.status}`, { status: answer.status });
    }
    return answer.body;
  }

  /** The identity of the module: `{ serial, name }`. */
  async deviceInfo(options) {
    const info = parseJson(await this.call({ ...options, path: ENDPOINTS.DEVICE_INFO }));
    const serial = normalizeSerial(Object.hasOwn(info, 'devSN') ? info.devSN : undefined);
    if (!serial) {
      throw new DeviceError(ERROR_KINDS.PROTOCOL, 'No serial number');
    }
    return { serial, name: cleanName(Object.hasOwn(info, 'devName') ? info.devName : '') };
  }

  /** A regular request: true only for `{ "Answer": "OK" }`. */
  async regular(options) {
    const answer = parseJson(await this.call(options));
    return Object.hasOwn(answer, 'Answer') && answer.Answer === 'OK';
  }

  setOutput(options, index, state) {
    return this.regular({
      ...options,
      path: ENDPOINTS.SET_OUTPUT,
      fields: { index, status: state === true },
    });
  }

  subscription(options, address, subscribe) {
    return this.regular({
      ...options,
      path: ENDPOINTS.SUBSCRIPTION,
      fields: { address, subscribe: subscribe === true },
    });
  }
}
