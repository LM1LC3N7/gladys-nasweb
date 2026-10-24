// -----------------------------------------------------------------------------
// The status the module posts to the receiver (pure), as webio-api 0.1.12
// reads it (WebioAPI.update_device_status):
//
//   { "type": "status_update", "device_serial": "...",
//     "outputs": [{ "index": 1, "status": "true" | "false" }, ...],
//     "inputs":  [{ "index": 1, "status": "active" | "normal" | "problem"
//                                        | "tamper" | "undefined" }, ...],
//     "device_temp_env": "21" | "N/A", "zones": [...], "thermostat": {...} }
//
// Strict: only own keys, indexes 0..999 (a number or plain digits), at most
// 64 outputs and 64 inputs, the first of a duplicated index kept. A value
// that cannot be read is unknown (undefined), never false or 0. Zones and the
// thermostat are not read (alarm and heating are left out of this module).
// -----------------------------------------------------------------------------

import { INPUT_STATES, LIMITS, STATUS_UPDATE } from '../constants.js';
import { normalizeSerial } from './client.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

export function parseIndex(value) {
  if (Number.isInteger(value) && value >= 0 && value <= LIMITS.maxIndex) {
    return value;
  }
  if (typeof value === 'string' && /^\d{1,3}$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

export function outputState(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

export const inputState = (value) =>
  typeof value === 'string' && INPUT_STATES.includes(value) ? value : undefined;

/** °C: a number or a plain decimal text within the range of a probe; "N/A" is null. */
export function temperatureOf(value) {
  if (value === 'N/A') {
    return null;
  }
  let number;
  if (typeof value === 'number') {
    number = value;
  } else if (typeof value === 'string' && /^-?\d{1,3}(\.\d{1,2})?$/.test(value.trim())) {
    number = Number(value.trim());
  }
  return Number.isFinite(number) && number >= -55 && number <= 125 ? number : undefined;
}

/** A list of `{ index, status }`: Map index -> parsed status, bounded. */
function entries(list, max, read) {
  if (!Array.isArray(list)) {
    return { map: undefined, dropped: 0 };
  }
  const map = new Map();
  let dropped = 0;
  for (const entry of list.slice(0, max * 4)) {
    const index = parseIndex(own(entry, 'index'));
    if (index === undefined || map.has(index) || map.size >= max) {
      dropped += 1;
      continue;
    }
    map.set(index, read(own(entry, 'status')));
  }
  dropped += Math.max(0, list.length - max * 4);
  return { map, dropped };
}

/**
 * @param {string} text the body of the push
 * @returns {{ error: string } | { serial, outputs?: Map, inputs?: Map, temperature, dropped }}
 */
export function parsePush(text) {
  let value;
  try {
    value = JSON.parse(String(text ?? ''));
  } catch {
    return { error: 'json' };
  }
  if (!isObject(value)) {
    return { error: 'json' };
  }
  if (own(value, 'type') !== STATUS_UPDATE) {
    return { error: 'type' };
  }
  const serial = normalizeSerial(own(value, 'device_serial'));
  if (!serial) {
    return { error: 'serial' };
  }
  const outputs = entries(own(value, 'outputs'), LIMITS.outputs, outputState);
  const inputs = entries(own(value, 'inputs'), LIMITS.inputs, inputState);
  return {
    serial,
    outputs: outputs.map,
    inputs: inputs.map,
    temperature: temperatureOf(own(value, 'device_temp_env')),
    dropped: outputs.dropped + inputs.dropped,
  };
}
