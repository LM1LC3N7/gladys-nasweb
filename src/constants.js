// -----------------------------------------------------------------------------
// Fixed values: the local API of the NASweb modules (webio-api 0.1.12, MIT,
// nasWebio), manifest keys (frozen: users store them), the push receiver
// sub-container, feature roles, limits and timings.
// -----------------------------------------------------------------------------

/**
 * The endpoints of the module (HTTPS, POST, JSON bodies), as webio-api 0.1.12
 * names them. Every one but `hello` carries the login and the SHA-1 of the
 * password in its body.
 */
export const ENDPOINTS = {
  HELLO: '/rest/hello/world',
  DEVICE_INFO: '/rest/integration/hass/getDeviceInfo',
  SET_OUTPUT: '/rest/integration/hass/setOutput',
  SUBSCRIPTION: '/rest/integration/hass/statusSubscription',
};

/** What the module answers when the login or the password is wrong (besides a 401). */
export const NOT_AUTHORIZED = 'Not Authorized';

/** The push message type of a status (webio-api TYPE_STATUS_UPDATE). */
export const STATUS_UPDATE = 'status_update';

/** The states of an input (webio-api 0.1.12 STATE_INPUT_*). */
export const INPUT_STATES = ['active', 'normal', 'problem', 'tamper', 'undefined'];

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  /** A relay output declared safe: a switch. */
  POWER: 'power',
  /** A relay output not declared safe: its state, read only. */
  STATE: 'state',
  /** An input: active (1) or normal (0). */
  INPUT: 'input',
  /** An input in "problem" or "tamper" (1), or fine (0). */
  FAULT: 'fault',
  /** The temperature probe of the module. */
  TEMPERATURE: 'temperature',
};

/** External id types (the middle part of the device external ids): frozen. */
export const ID_TYPES = {
  MODULE: 'module',
  OUTPUT: 'output',
  INPUT: 'input',
};

/** Manifest `actions` keys: frozen. */
export const ACTIONS = {
  TEST: 'test_connection',
  TRUST: 'trust_device',
};

/** The push receiver of the manifest `containers` (same image, `node src/receiver.js`). */
export const RECEIVER = {
  name: 'nasweb-push',
  /** HTTP port the module calls, published by Gladys on a host port it chooses. */
  httpPort: 8080,
  httpPortName: 'nasweb_push',
  /** Channel to the main container, on the private network of the integration only. */
  channelPort: 7778,
  /** The path the module posts to: /nasweb/<push token>. */
  pathPrefix: '/nasweb/',
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

export const LIMITS = {
  /** Gladys accepts 300 states per minute: a margin is kept. */
  statesPerMinute: 250,
  /** A push body: a status of a few dozen outputs and inputs is a few KB. */
  pushBytes: 32 * 1024,
  /** Pushes accepted per minute by the receiver, in all and per source address. */
  pushesPerMinute: 240,
  pushesPerSource: 60,
  /**
   * Connections of the receiver: in all, per source address (also the places
   * kept for the module), idle time before closing. Over a limit the oldest
   * silent connection is closed, never the newcomer from the module.
   */
  receiverConnections: 32,
  receiverConnectionsPerSource: 4,
  receiverIdleMs: 10_000,
  /** Sources whose latest post over budget may wait for their window (32 KB each). */
  deferredSources: 8,
  /** Pushes kept by the receiver while the main container is away (only the latest matter). */
  pushQueue: 5,
  /** An answer of the module (device info, OK): a few hundred bytes. */
  responseBytes: 64 * 1024,
  headerBytes: 8 * 1024,
  /** Outputs and inputs taken from a push; indexes 0..maxIndex. */
  outputs: 64,
  inputs: 64,
  maxIndex: 999,
  /** Names are cut to this length. */
  nameLength: 60,
  /** Entries of "Outputs declared safe". */
  safeOutputs: 64,
  /** The secrets the integration generates (base64url characters). */
  tokenLength: 32,
};

export const TIMINGS = {
  /** A request to the module (connection, TLS, answer). */
  requestTimeout: 5 * SECOND,
  /** A push older than this: the module is no longer reporting (webio-api: 60 s). */
  pushFresh: 90 * SECOND,
  /** A pushed temperature is sent to Gladys at most this often. */
  temperatureEvery: 30 * SECOND,
  /** While no push arrives, the module is read (identity, subscription) at most this often. */
  checkInterval: 60 * SECOND,
  /** The subscription is renewed at most this often while no push arrives. */
  resubscribe: 10 * MINUTE,
  /** The background round. */
  tick: 15 * SECOND,
  /** The pending states are sent at this pace. */
  flushInterval: SECOND,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * MINUTE,
  /** The new devices of a push are published together. */
  rebuildDebounce: SECOND,
  /** The status after refused pushes is updated at most this often. */
  refusedStatusEvery: 10 * SECOND,
  /** "Test the connection" reads at most this often. */
  testCooldown: 10 * SECOND,
  /** The second click of "Trust the device now answering" within this time. */
  trustConfirm: 60 * SECOND,
  /** The receiver is started again at most this often when it is not running. */
  receiverRetry: MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the identity read and the write
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the push showing the new state is awaited until 4.3 s, after which the
   * command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The identity read of a command: 2.5 s at most, and 0.3 s left to send after it. */
  commandReadMax: 2_500,
  commandMinRead: 300,
  commandMinSend: 300,
};
