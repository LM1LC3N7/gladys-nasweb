// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The login and
// the password of the module are kept here and in the requests only: never
// logged, never in /data, never in a status or an error.
//
// Two values live in the Gladys configuration outside the `config_schema`
// (`push_token`, `channel_token`): the secrets the integration generates for
// its receiver, written with setConfig, never shown in the interface.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { LIMITS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  device_address: '',
  username: '',
  password: '',
  callback_address: '',
  check_push_source: true,
  safe_outputs: '',
  allow_commands: false,
  language: 'fr',
};

/** The keys the integration writes itself (setConfig), outside the config_schema. */
export const TOKEN_KEYS = { push: 'push_token', channel: 'channel_token' };

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
export const isToken = (value) => typeof value === 'string' && TOKEN.test(value);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';
/** Only `false` (or the text "false") turns off: a missing value keeps the safe default. */
const strictFalse = (value) => value === false || value === 'false';

/** "::ffff:192.168.1.5" -> "192.168.1.5"; an IPv6 in lower case; undefined if not an IP. */
export function normalizeIp(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  let text = value.trim();
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(text)) {
    text = text.slice(7);
  }
  const version = isIP(text);
  if (version === 4) {
    return text;
  }
  return version === 6 ? text.toLowerCase() : undefined;
}

/**
 * The address of the module: an IP address, optionally with a port
 * ("192.168.1.50", "192.168.1.50:8443", "[fd00::5]:443"). A name is refused:
 * the address the pushes come from is compared to it.
 * @returns {{ host: string, port: number } | { error: string }}
 */
export function parseDeviceAddress(raw) {
  const text =
    typeof raw === 'string'
      ? raw
          .trim()
          .replace(/^https:\/\//i, '')
          .replace(/\/$/, '')
      : '';
  if (text === '') {
    return { error: 'empty' };
  }
  if (text.length > 64 || /[\s/@?#]/.test(text)) {
    return { error: 'invalid' };
  }
  let host = text;
  let port = 443;
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(text);
  const withPort = /^([0-9.]+):(\d{1,5})$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2] === undefined ? 443 : Number(bracketed[2]);
  } else if (withPort) {
    host = withPort[1];
    port = Number(withPort[2]);
  }
  const ip = normalizeIp(host);
  if (!ip || port < 1 || port > 65535) {
    return { error: 'invalid' };
  }
  if (
    ip === '0.0.0.0' ||
    ip === '::' ||
    /^(22[4-9]|2[3-5]\d)\./.test(ip) ||
    ip === '255.255.255.255'
  ) {
    return { error: 'invalid' };
  }
  return { host: ip, port };
}

/**
 * The address of the Gladys machine as the module reaches it: an IP address
 * or a host name, without a port (Gladys chooses it).
 * @returns {{ host: string | undefined } | { error: string }}
 */
export function parseGladysAddress(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    return { host: undefined };
  }
  const ip = normalizeIp(text.replace(/^\[(.*)\]$/, '$1'));
  if (ip) {
    return { host: ip };
  }
  if (
    /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
      text,
    )
  ) {
    return { host: text.toLowerCase() };
  }
  return { error: 'invalid' };
}

/** The host part of a URL: an IPv6 address in brackets. */
export const urlHost = (host, port) =>
  `${isIP(host) === 6 ? `[${host}]` : host}${port === undefined ? '' : `:${port}`}`;

/**
 * The outputs declared safe to switch: their indexes (the NASWEB_OUTPUT
 * parameter of the Discovery tab), separated by commas, spaces or new
 * lines. Anything else is ignored and counted in `invalid` (never shown:
 * something pasted in the wrong field may be a secret).
 */
export function parseSafeOutputs(raw) {
  const safe = new Set();
  let invalid = 0;
  const text = typeof raw === 'string' ? raw.slice(0, 2000) : '';
  for (const entry of text.split(/[\s,;]+/)) {
    if (entry === '') {
      continue;
    }
    if (!/^\d{1,3}$/.test(entry) || safe.size >= LIMITS.safeOutputs) {
      invalid += 1;
      continue;
    }
    safe.add(Number(entry));
  }
  return { safe, invalid };
}

/** Whether a text holds a control character (C0 or DEL). */
export const hasControl = (text) =>
  [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/** A login or a password that may go into a JSON body: no control character, bounded. */
const credential = (value, max) =>
  typeof value === 'string' && value.length <= max && !hasControl(value);

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value !== null && value !== undefined) {
      c[key] = value;
    }
  }
  const device = parseDeviceAddress(c.device_address);
  const gladys = parseGladysAddress(c.callback_address);
  const outputs = parseSafeOutputs(c.safe_outputs);
  const username = typeof c.username === 'string' ? c.username.trim() : '';
  const password = typeof c.password === 'string' ? c.password : '';
  let problem;
  if (device.error) {
    problem = `device:${device.error}`;
  } else if (username === '' || !credential(username, 128)) {
    problem = 'username';
  } else if (password === '' || !credential(password, 256)) {
    problem = 'password';
  }
  return {
    /** Why the configuration cannot be used (shown in the status), else undefined. */
    problem,
    host: device.host,
    port: device.port,
    username: problem ? '' : username,
    password: problem ? '' : password,
    gladysHost: gladys.host,
    gladysHostError: Boolean(gladys.error),
    checkPushSource: !strictFalse(c.check_push_source),
    safeOutputs: outputs.safe,
    invalidOutputs: outputs.invalid,
    allowCommands: strictTrue(c.allow_commands),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** The module the configuration points at (the pin and the identity belong to it). */
export const targetOf = (config) =>
  config.host === undefined ? null : urlHost(config.host, config.port);

/** What a new session depends on (compared in memory only, never stored). */
export const connectionKey = (config) =>
  JSON.stringify([config.problem ?? null, targetOf(config), config.username, config.password]);

/** The credentials only: other credentials lift the stop on refused credentials. */
export const credentialsKey = (config) => JSON.stringify([config.username, config.password]);
