// -----------------------------------------------------------------------------
// What the module reported -> Gladys devices and routing tables. Pure: same
// input, same devices.
//
//   module   the temperature probe of the module (once a value was seen)
//   output   a relay output. The load behind it is unknown (a lamp, but
//            also a pump, a boiler demand, a heater, a gate pulse...), and a
//            "turn everything off / on" of a voice assistant or a scene
//            reaches every switch. So only an output declared safe in the
//            configuration is a switch (switch/binary, role `power`); any
//            other is its state, read only (unknown/binary, role `state`).
//            Both sets are built, the other one `hidden` (not published,
//            still read, so a feature the user created before the list
//            changed keeps its state; a command on a hidden switch is
//            refused).
//   input    active (1) / normal (0), read only (role `input`), and
//            problem or tamper (1) / fine (0) (tamper/binary, role `fault`)
//
// External ids (frozen: never change one):
//   device   ext:<selector>:module:<serial>
//            ext:<selector>:output:<serial>-<index>
//            ext:<selector>:input:<serial>-<index>
//            <serial> being the serial number of the module without its
//            dashes (as webio-api and Home Assistant key it), <index> the
//            index the module gives the output or input
//   feature  <device>:<role> (src/constants.js FEATURES)
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { FEATURES as F, ID_TYPES } from './constants.js';
import { NAMES, featureName, word } from './i18n.js';

/** A command value sent by Gladys: exactly 0 or 1 (a number or a plain text), else undefined. */
export function onOff(value) {
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  return undefined;
}

const feature = (role, spec) => ({ role, readOnly: true, measurement: false, ...spec });

export const outputSpecs = (safe) => {
  const power = feature(F.POWER, {
    category: C.SWITCH,
    type: T.SWITCH.BINARY,
    min: 0,
    max: 1,
    readOnly: false,
    command: true,
    read: (s) => (s === undefined ? undefined : s ? 1 : 0),
  });
  const state = feature(F.STATE, {
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read: (s) => (s === undefined ? undefined : s ? 1 : 0),
  });
  return safe
    ? [power, { ...state, hidden: true }]
    : [state, { ...power, hidden: true, refusal: 'unsafeOutput' }];
};

export const inputSpecs = () => [
  feature(F.INPUT, {
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read: (s) => (s === 'active' ? 1 : s === 'normal' ? 0 : undefined),
  }),
  feature(F.FAULT, {
    category: C.TAMPER,
    type: T.TAMPER.BINARY,
    min: 0,
    max: 1,
    read: (s) =>
      s === 'problem' || s === 'tamper' ? 1 : s === 'active' || s === 'normal' ? 0 : undefined,
  }),
];

export const temperatureSpec = () =>
  feature(F.TEMPERATURE, {
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: 'celsius',
    min: -55,
    max: 125,
    measurement: true,
    read: (v) => (typeof v === 'number' ? v : undefined),
  });

/**
 * @param {{ externalIds: Function, serial: string, name: string, outputs: number[],
 *   inputs: number[], temperature: boolean, safeOutputs: Set<number>, language: string }} input
 * @returns {{ devices, features, deviceOf, throttled }}
 *   features: featureId -> { kind, index, spec, deviceId } (hidden features included)
 *   deviceOf: deviceId -> { kind, index }
 */
export function buildModel({
  externalIds,
  serial,
  name = '',
  outputs = [],
  inputs = [],
  temperature = false,
  safeOutputs = new Set(),
  language = 'fr',
}) {
  const model = { devices: [], features: new Map(), deviceOf: new Map(), throttled: new Set() };
  if (!serial) {
    return model;
  }
  const base = name || word(NAMES.module, language);
  const add = (kind, index, deviceName, specs, params) => {
    const ids = externalIds(kind, index === undefined ? serial : `${serial}-${index}`);
    const features = [];
    for (const spec of specs) {
      const featureId = ids.feature(spec.role);
      model.features.set(featureId, { kind, index, spec, deviceId: ids.device });
      if (spec.measurement) {
        model.throttled.add(featureId);
      }
      if (spec.hidden) {
        continue;
      }
      features.push({
        name: featureName(spec.role, language),
        external_id: featureId,
        category: spec.category,
        type: spec.type,
        ...(spec.unit ? { unit: spec.unit } : {}),
        min: spec.min,
        max: spec.max,
        read_only: spec.readOnly,
        has_feedback: true,
        keep_history: true,
      });
    }
    model.devices.push({
      name: deviceName.slice(0, 80),
      external_id: ids.device,
      params: [{ name: 'NASWEB_SERIAL', value: serial }, ...params],
      features,
    });
    model.deviceOf.set(ids.device, { kind, index });
  };
  if (temperature) {
    add(ID_TYPES.MODULE, undefined, base, [temperatureSpec()], []);
  }
  for (const index of [...outputs].sort((a, b) => a - b)) {
    add(
      ID_TYPES.OUTPUT,
      index,
      `${base} - ${word(NAMES.output(index), language)}`,
      outputSpecs(safeOutputs.has(index)),
      [{ name: 'NASWEB_OUTPUT', value: String(index) }],
    );
  }
  for (const index of [...inputs].sort((a, b) => a - b)) {
    add(ID_TYPES.INPUT, index, `${base} - ${word(NAMES.input(index), language)}`, inputSpecs(), [
      { name: 'NASWEB_INPUT', value: String(index) },
    ]);
  }
  return model;
}
