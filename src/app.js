// -----------------------------------------------------------------------------
// The integration: one NASweb module, read through its local HTTPS API and
// through the status it pushes to the `nasweb-push` sub-container.
//
//   - Identity: the module is identified by its serial number (devSN), read
//     with getDeviceInfo; the certificate of the module is pinned at the
//     first connection (kept in /data before the login ever leaves); another
//     certificate or another serial at the address is refused (nothing sent)
//     until the user trusts it in two clicks.
//   - States: the module posts them to http://<Gladys>:<port>/nasweb/<token>
//     once subscribed (statusSubscription). The receiver checks the method,
//     the path, the token and the size; this container checks the source
//     address (the module's, unless the user turned it off), the serial
//     number and the shape, then sends the states within the Gladys rate
//     limit. The main container cannot publish a port: this is why the
//     receiver is a sub-container (manifest `containers`). There is no
//     endpoint to read the states otherwise: without pushes, the devices
//     are shown unreachable and the module is read (identity, subscription)
//     at most once a minute.
//   - Commands: only on relay outputs declared safe (switches), only when
//     "Allow the commands" is on (off by default), only with a recent push
//     (the result must be confirmable), decided after a fresh read of the
//     identity of the module, checked again right before the write
//     (beforeSend), sent within 3.5 s of the click or refused unsent,
//     confirmed only by a push showing the requested state by 4.3 s,
//     otherwise "sent, without confirmation". One command at a time per
//     output; other outputs are never held. The ack never waits for a
//     publication to Gladys.
//   - Login refused: everything stops (persisted), no automatic retry;
//     saving other credentials or "Test the connection" tries again.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { ChannelClient } from './channel.js';
import {
  TOKEN_KEYS,
  connectionKey,
  credentialsKey,
  isToken,
  normalizeConfig,
  targetOf,
  urlHost,
} from './config.js';
import { RECEIVER, TIMINGS } from './constants.js';
import { ERRORS, T, TEST, TRUST, age, word } from './i18n.js';
import { buildModel, onOff } from './model.js';
import { NaswebClient } from './nasweb/client.js';
import { DeviceError, ERROR_KINDS, notSent } from './nasweb/http.js';
import { parsePush } from './nasweb/status.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, normalizeMemory, serializeMemory } from './store.js';

const newToken = () => randomBytes(24).toString('base64url');

/** 8 bits of a salted hash: enough to notice other credentials, useless to find them. */
const credentialsTag = (salt, config) =>
  createHash('sha256')
    .update(`${salt}|${credentialsKey(config)}`)
    .digest()[0];

/** 8 hex characters of the hash of the push token: tells a subscription with another token. */
const tokenTag = (token) => createHash('sha256').update(String(token)).digest('hex').slice(0, 8);

export class NaswebApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'nasweb' }),
    client = new NaswebClient(),
    store = fileStore(),
    now = Date.now,
    clock = () => performance.now(),
    timers = globalThis,
    createChannel = (options) => new ChannelClient(options),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.client = client;
    this.store = store;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.createChannel = createChannel;
    this.config = normalizeConfig();
    this.rawConfig = {};
    this.connKey = undefined;
    this.credKey = undefined;
    this.memory = undefined;
    this.generation = 0;
    this.started = false;
    this.tokens = { push: undefined, channel: undefined };
    this.receiver = { status: 'not started', port: null };
    this.lastReceiverTry = -Infinity;
    /** The env given to the last startContainer of the receiver (in memory only: it holds secrets). */
    this.lastReceiverEnv = undefined;
    this.channel = undefined;
    this.timersById = {};
    this.tickTimer = undefined;
    this.reading = undefined;
    this.waiters = new Set();
    /** index -> the write of the latest command on that output (the next one waits for it only) */
    this.writes = new Map();
    this.lastRefusedStatus = -Infinity;
    this.unreadable = false;
    this.warned = new Set();
    this.lastTest = -Infinity;
    this.pendingTrust = undefined;
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    this.transports = new Map();
    this.lastValues = new Map();
    this.created = new Set();
    this.resetModule();
    this.model = buildModel({ externalIds: this.ids() });
    this.publisher = new StatePublisher({ gladys, logger, now: clock, timers });
  }

  ids() {
    return (type, id) => this.gladys.externalIds(type, id);
  }

  /** What the module reported (forgotten when the module or its address changes). */
  resetModule() {
    this.outputs = new Map();
    this.inputs = new Map();
    this.temperature = undefined;
    this.seenTemperature = false;
    this.lastPush = undefined;
    /** The receiver time (`at`, wall clock) of the last push applied. */
    this.lastPushAt = undefined;
    this.lastError = undefined;
    this.subscribeRefused = false;
    this.refusedPushes = { source: 0, serial: 0, from: '', at: -Infinity };
  }

  // --- Memory (/data) ----------------------------------------------------------

  async loadMemory() {
    if (!this.memory) {
      let raw = null;
      try {
        raw = await this.store.load();
      } catch (err) {
        // A file that exists but cannot be read is not "nothing known": the pin and
        // a login stop may be in it. Nothing is sent until the user tests the connection.
        this.unreadable = true;
        this.logger.error(
          `/data/nasweb.json cannot be read (${err?.code ?? 'invalid'}): nothing is sent to the module`,
        );
      }
      this.memory = normalizeMemory(raw, this.now());
    }
    return this.memory;
  }

  /** Resolves true once written. */
  async saveMemory() {
    if (this.unreadable) {
      // Never written over a file that could not be read.
      return false;
    }
    try {
      await this.store.save(serializeMemory(this.memory));
      return true;
    } catch (err) {
      this.logger.warn(`Saving the state in /data failed: ${err.message}`);
      return false;
    }
  }

  // --- Timers ------------------------------------------------------------------

  later(name, delay, fn) {
    this.timers.clearTimeout(this.timersById[name]);
    const generation = this.generation;
    this.timersById[name] = this.timers.setTimeout(() => {
      this.timersById[name] = undefined;
      if (generation === this.generation) {
        Promise.resolve()
          .then(fn)
          .catch((err) => this.logger.error(`${name} failed: ${err.message}`));
      }
    }, delay);
  }

  clearTimers() {
    for (const id of Object.values(this.timersById)) {
      this.timers.clearTimeout(id);
    }
    this.timersById = {};
    if (this.tickTimer) {
      this.timers.clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  warnOnce(key, message) {
    if (this.warned.size < 200 && !this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  // --- Lifecycle -----------------------------------------------------------------

  /** Gladys (re)connected: the status, the Discovery and the badges again; nothing read sooner. */
  async gladysConnected(raw) {
    const next = normalizeConfig(raw);
    if (this.started && connectionKey(next) === this.connKey) {
      await this.applySoft(next, raw);
      this.lastStatus = undefined;
      this.publishedDevices = undefined;
      this.transports.clear();
      this.refreshCreated();
      await this.rebuild({ force: true });
      return;
    }
    await this.start(raw);
  }

  /** Saved by the user: options apply at once; another module or other credentials restart. */
  async configUpdated(raw) {
    const next = normalizeConfig(raw);
    if (this.started && connectionKey(next) === this.connKey) {
      const before = this.config;
      await this.applySoft(next, raw);
      if (
        before.language !== next.language ||
        [...before.safeOutputs].sort().join() !== [...next.safeOutputs].sort().join()
      ) {
        // Which outputs are switches, or the names: the devices are built again.
        await this.rebuild();
      } else {
        await this.updateStatus();
      }
      if (before.gladysHost !== next.gladysHost && next.gladysHost) {
        // A new push address: the module is told now (a real change, not a re-read).
        await this.read({ force: true });
      }
      return;
    }
    await this.start(raw);
  }

  async applySoft(next, raw) {
    this.rawConfig = raw ?? {};
    this.config = next;
    if (await this.ensureTokens(raw)) {
      // New secrets (the configuration lost them): the receiver and the channel take them.
      this.channel?.stop();
      this.channel = undefined;
      if (!next.problem) {
        await this.ensureReceiver();
      }
    } else if (
      !next.problem &&
      this.lastReceiverEnv !== undefined &&
      JSON.stringify(this.receiverEnv()) !== this.lastReceiverEnv
    ) {
      // The receiver runs with another env (the sender check changed, maybe while
      // Gladys was away): started again with the current one.
      await this.ensureReceiver();
    }
  }

  async start(raw = {}) {
    await this.loadMemory();
    this.stop();
    this.started = true;
    this.rawConfig = raw ?? {};
    this.config = normalizeConfig(raw);
    this.connKey = connectionKey(this.config);
    const credentials = credentialsKey(this.config);
    const auth = this.memory.auth;
    if (
      auth.blocked &&
      ((this.credKey !== undefined && credentials !== this.credKey) ||
        (auth.salt && auth.tag !== null && credentialsTag(auth.salt, this.config) !== auth.tag))
    ) {
      // Other credentials: the stop on the refused ones is lifted.
      this.memory.auth = emptyMemory().auth;
      await this.saveMemory();
      this.logger.info('NASweb: new credentials, the module is read again');
    }
    this.credKey = credentials;
    const target = targetOf(this.config);
    if (target !== null && target !== this.memory.target) {
      // Another address: what was known (identity, pin, subscription) belonged to the old one.
      const { auth: kept, lastTry } = this.memory;
      this.memory = { ...emptyMemory(), target, auth: kept, lastTry };
      await this.saveMemory();
    }
    this.resetModule();
    this.model = buildModel({ externalIds: this.ids() });
    this.publishedDevices = undefined;
    this.lastStatus = undefined;
    this.transports.clear();
    this.lastValues.clear();
    this.refreshCreated();
    await this.ensureTokens(raw);
    this.publisher.configure({
      intervalSeconds: TIMINGS.temperatureEvery / 1000,
      throttled: this.model.throttled,
    });
    this.publisher.start();
    this.tickTimer = this.timers.setInterval(() => {
      this.tick().catch((err) => this.logger.warn(`Background round failed: ${err.message}`));
    }, TIMINGS.tick);
    if (this.config.problem) {
      await this.updateStatus();
      return;
    }
    await this.rebuild({ force: true });
    await this.ensureReceiver();
    // Never a read faster than the interval, even across restarts.
    const wait = Math.min(
      TIMINGS.checkInterval,
      Math.max(0, this.memory.lastTry + TIMINGS.checkInterval - this.now()),
    );
    if (wait > 0) {
      await this.updateStatus();
      this.later('read', wait, () => this.read());
      return;
    }
    await this.read();
  }

  stop() {
    this.generation += 1;
    this.clearTimers();
    this.publisher.stop();
    this.channel?.stop();
    this.channel = undefined;
    this.failWaiters();
  }

  /**
   * The secrets of the receiver: generated once, kept in the Gladys
   * configuration. Resolves true when they changed.
   */
  async ensureTokens(raw) {
    const missing = {};
    const before = JSON.stringify(this.tokens);
    const had = isToken(this.tokens.push) && isToken(this.tokens.channel);
    for (const [name, key] of Object.entries(TOKEN_KEYS)) {
      const value = raw?.[key];
      if (isToken(value)) {
        this.tokens[name] = value;
      } else if (!isToken(this.tokens[name])) {
        this.tokens[name] = newToken();
        missing[key] = this.tokens[name];
      } else {
        // Not in this configuration (saved without it): written back, the same.
        missing[key] = this.tokens[name];
      }
    }
    if (Object.keys(missing).length > 0) {
      await this.gladys
        .setConfig(missing)
        .catch((err) => this.logger.warn(`Keeping the receiver secrets failed: ${err.message}`));
    }
    return had && before !== JSON.stringify(this.tokens);
  }

  // --- Background round ----------------------------------------------------------

  pushFresh(mono = this.clock()) {
    return this.lastPush !== undefined && mono - this.lastPush < TIMINGS.pushFresh;
  }

  trusted() {
    return !this.memory?.auth.blocked && !this.memory?.refusedPin && !this.memory?.otherSerial;
  }

  async tick() {
    if (!this.started || this.config.problem) {
      return;
    }
    if (
      this.receiver.status !== 'running' &&
      this.clock() - this.lastReceiverTry >= TIMINGS.receiverRetry
    ) {
      await this.ensureReceiver();
    }
    await this.publishAllTransports();
    await this.updateStatus();
    if (this.needsRead()) {
      await this.read();
    }
  }

  /** Read while no push arrives (identity, subscription), at most once per interval. */
  needsRead() {
    if (
      this.config.problem ||
      this.unreadable ||
      this.memory.auth.blocked ||
      this.memory.otherSerial
    ) {
      // Another module answers: the login is not sent to it again unless the user asks.
      return false;
    }
    if (this.now() - this.memory.lastTry < TIMINGS.checkInterval) {
      return false;
    }
    return !this.pushFresh() || !this.memory.serial || !this.subscriptionCurrent();
  }

  // --- Receiver --------------------------------------------------------------------

  receiverEnv() {
    return {
      PUSH_TOKEN: this.tokens.push,
      CHANNEL_TOKEN: this.tokens.channel,
      HTTP_PORT: String(RECEIVER.httpPort),
      CHANNEL_PORT: String(RECEIVER.channelPort),
      // The receiver refuses other senders before spending its budget on them.
      ...(this.config.checkPushSource && this.config.host
        ? { DEVICE_ADDRESS: this.config.host }
        : {}),
    };
  }

  /** Starts the receiver with the current secrets (Gladys recreates it when they changed). */
  async ensureReceiver() {
    this.lastReceiverTry = this.clock();
    const generation = this.generation;
    try {
      const env = this.receiverEnv();
      await this.gladys.startContainer(RECEIVER.name, { env });
      this.lastReceiverEnv = JSON.stringify(env);
      const containers = await this.gladys.getContainers();
      if (generation !== this.generation) return;
      const container = (containers ?? []).find((c) => c?.name === RECEIVER.name);
      const port = container?.ports?.find((p) => p?.name === RECEIVER.httpPortName)?.host_port;
      this.receiver = {
        status: typeof container?.status === 'string' ? container.status.slice(0, 40) : 'unknown',
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
      };
    } catch (err) {
      if (generation !== this.generation) return;
      this.receiver = { status: 'error', port: null };
      this.warnOnce(`receiver:${err.message}`, `Could not start the push receiver: ${err.message}`);
      return;
    }
    if (this.receiver.status === 'running') {
      this.startChannel();
    }
  }

  startChannel() {
    if (this.channel) {
      return;
    }
    const generation = this.generation;
    const channel = this.createChannel({
      host: RECEIVER.name,
      port: RECEIVER.channelPort,
      token: this.tokens.channel,
      logger: this.logger,
    });
    this.channel = channel;
    channel.on('up', () => this.logger.info('Connected to the push receiver'));
    channel.on('down', () => this.logger.warn('Lost the push receiver, reconnecting'));
    channel.on('message', (message) => {
      if (
        generation === this.generation &&
        (message?.type === 'push' || message?.type === 'refused')
      ) {
        this.onPush(message);
      }
    });
    channel.start();
  }

  // --- Pushes -----------------------------------------------------------------------

  /** A refused push or notice: counted, the status updated at most every 10 s. */
  noteRefused(kind, from, mono) {
    this.refusedPushes = {
      ...this.refusedPushes,
      [kind]: this.refusedPushes[kind] + 1,
      ...(kind === 'source' ? { from } : {}),
      at: mono,
    };
    const wait = this.lastRefusedStatus + TIMINGS.refusedStatusEvery - mono;
    if (wait <= 0) {
      this.lastRefusedStatus = mono;
      this.updateStatus().catch(() => {});
    } else if (!this.timersById.refusedStatus) {
      this.later('refusedStatus', wait, () => {
        this.lastRefusedStatus = this.clock();
        return this.updateStatus();
      });
    }
  }

  onPush(message) {
    const { from, at, body } = message;
    if (typeof from !== 'string' || typeof at !== 'string') {
      return;
    }
    // One reading of each clock for the whole decision.
    const now = this.now();
    const mono = this.clock();
    const sent = Date.parse(at);
    if (!Number.isFinite(sent)) {
      return;
    }
    // Dated by the receiver when the module posted it, not when it reached this container.
    const ageMs = Math.max(0, now - sent);
    if (ageMs >= TIMINGS.pushFresh) {
      // Kept by the receiver while this container was away: no longer the state.
      return;
    }
    if (!this.memory?.serial || !this.trusted() || this.config.problem || this.unreadable) {
      return;
    }
    if (message.type === 'refused') {
      // The receiver refused a post from another address than the module's.
      this.noteRefused('source', from, mono);
      return;
    }
    if (typeof body !== 'string') {
      return;
    }
    if (this.config.checkPushSource && from !== this.config.host) {
      this.warnOnce(
        `source:${from}`,
        `A status from ${from || 'an unknown address'} was refused (not the module)`,
      );
      this.noteRefused('source', from, mono);
      return;
    }
    const parsed = parsePush(body);
    if (parsed.error) {
      this.warnOnce(`push:${parsed.error}`, `A status of the module was ignored: ${parsed.error}`);
      return;
    }
    if (parsed.serial !== this.memory.serial) {
      this.warnOnce(`serial:${parsed.serial}`, 'A status with another serial number was refused');
      this.noteRefused('serial', from, mono);
      return;
    }
    if (this.lastPushAt !== undefined && sent < this.lastPushAt) {
      // Older than the status already applied: never written over it.
      return;
    }
    if (parsed.dropped > 0) {
      this.warnOnce(
        `dropped:${parsed.dropped}`,
        `${parsed.dropped} output(s) or input(s) ignored (invalid, duplicated or too many)`,
      );
    }
    const wasFresh = this.pushFresh(mono);
    this.lastPushAt = sent;
    this.lastPush = Math.max(this.lastPush ?? -Infinity, mono - ageMs);
    let grew = false;
    for (const [list, map] of [
      [parsed.outputs, this.outputs],
      [parsed.inputs, this.inputs],
    ]) {
      for (const [index, state] of list ?? []) {
        grew ||= !map.has(index);
        map.set(index, state);
      }
    }
    if (parsed.temperature !== undefined) {
      this.temperature = parsed.temperature;
      if (typeof parsed.temperature === 'number' && !this.seenTemperature) {
        this.seenTemperature = true;
        grew = true;
      }
    }
    for (const waiter of [...this.waiters]) {
      // Only a status posted after the bytes of the command left confirms it.
      if (
        waiter.sentAt !== undefined &&
        sent >= waiter.sentAt &&
        parsed.outputs?.get(waiter.index) === waiter.wanted
      ) {
        this.settleWaiter(waiter, true);
      }
    }
    if (grew) {
      this.later('rebuild', TIMINGS.rebuildDebounce, () => this.rebuild());
    }
    this.recordAll(mono);
    // At the exact end of the freshness: badges, status, and nothing old left to send.
    this.later('stale', Math.max(0, this.lastPush + TIMINGS.pushFresh - mono), () =>
      this.onStale(),
    );
    if (!wasFresh) {
      this.publishAllTransports().catch(() => {});
      this.updateStatus().catch(() => {});
    }
  }

  async onStale() {
    if (this.pushFresh()) {
      return;
    }
    this.publisher.clear();
    await this.publishAllTransports();
    await this.updateStatus();
  }

  /** The value of a feature from what the module reported. */
  valueOf(entry) {
    if (entry.kind === 'output') return entry.spec.read(this.outputs.get(entry.index));
    if (entry.kind === 'input') return entry.spec.read(this.inputs.get(entry.index));
    return entry.spec.read(this.temperature);
  }

  /** Sends the values of the last push, only while it is recent (never an old value as new). */
  recordAll(mono = this.clock()) {
    if (!this.pushFresh(mono)) {
      return;
    }
    for (const [featureId, entry] of this.model.features) {
      const value = this.valueOf(entry);
      if (typeof value === 'number' && Number.isFinite(value)) {
        this.record(featureId, { state: value });
      }
    }
  }

  record(featureId, value) {
    this.lastValues.set(featureId, value);
    if (this.created.has(featureId)) {
      this.publisher.push(featureId, value);
    }
  }

  // --- Reads of the module ---------------------------------------------------------

  options(generation, { timeoutMs = TIMINGS.requestTimeout, beforeSend } = {}) {
    const target = targetOf(this.config);
    return {
      target: { host: this.config.host, port: this.config.port },
      credentials: { username: this.config.username, password: this.config.password },
      timeoutMs,
      trust: (fingerprint) => this.trust(fingerprint, { target, generation }),
      beforeSend,
    };
  }

  /**
   * The certificate of a new connection, checked BEFORE anything is written:
   * the pin of the address, or, at the first connection, pinned now (kept in
   * /data before the login leaves). Another one is refused, and kept for
   * "Trust the device now answering".
   */
  async trust(fingerprint, { target, generation }) {
    const stale = () => new DeviceError(ERROR_KINDS.STALE, 'The configuration changed');
    if (generation !== this.generation || this.memory.target !== target) {
      throw stale();
    }
    const pin = this.memory.pin;
    if (pin && pin !== fingerprint) {
      if (this.memory.refusedPin !== fingerprint) {
        this.memory.refusedPin = fingerprint;
        this.logger.warn('NASweb: the certificate of the module changed, nothing sent to it');
        await this.saveMemory();
      }
      throw new DeviceError(ERROR_KINDS.CERTIFICATE, 'The certificate changed', { fingerprint });
    }
    if (this.memory.refusedPin) {
      // The pinned certificate is back: nothing to trust any more.
      this.memory.refusedPin = null;
      this.pendingTrust = undefined;
      await this.saveMemory();
    }
    if (!pin) {
      this.memory.pin = fingerprint;
      // The first pin must be in /data before the login leaves: otherwise a
      // restart would trust whatever answers next.
      if (!(await this.saveMemory())) {
        if (this.memory.pin === fingerprint) this.memory.pin = null;
        throw new DeviceError(ERROR_KINDS.STORAGE, '/data not writable');
      }
      this.logger.info('NASweb: certificate of the module pinned (first connection)');
    }
    if (generation !== this.generation || this.memory.target !== target) {
      throw stale();
    }
  }

  /** One read at a time (a read in progress is joined). */
  read(options = {}) {
    if (!this.reading) {
      this.reading = this.doRead(options).finally(() => {
        this.reading = undefined;
      });
    }
    return this.reading;
  }

  /**
   * Identity, then the subscription when needed. `force`: a choice of the
   * user (test button, trust, a new address of Gladys), even when the login
   * was refused for the test button. Resolves the identity, or the error.
   */
  async doRead({ force = false, test = false } = {}) {
    const generation = this.generation;
    if (this.config.problem || this.unreadable || (this.memory.auth.blocked && !test)) {
      return { error: this.memory.auth.blocked ? ERROR_KINDS.AUTH : 'problem' };
    }
    const now = this.now();
    if (!force && now - this.memory.lastTry < TIMINGS.checkInterval) {
      return { error: 'notDue' };
    }
    // The time of the attempt goes to /data BEFORE the read (once a minute at most).
    const previous = this.memory.lastTry;
    this.memory.lastTry = now;
    if (now - previous >= TIMINGS.checkInterval) {
      await this.saveMemory();
    }
    let info;
    try {
      info = await this.client.deviceInfo(this.options(generation));
    } catch (err) {
      if (generation === this.generation) {
        await this.failed(err);
      }
      return { error: err?.kind ?? 'unreachable' };
    }
    if (generation !== this.generation) {
      return { error: ERROR_KINDS.STALE };
    }
    await this.loginAccepted();
    if (!this.identify(info)) {
      await this.saveMemory();
      await this.updateStatus();
      return { error: ERROR_KINDS.OTHER_DEVICE, info };
    }
    this.lastError = undefined;
    await this.saveMemory();
    await this.subscribe(generation, { force: test });
    if (generation !== this.generation) {
      return { error: ERROR_KINDS.STALE };
    }
    await this.rebuild();
    return { info };
  }

  /** The identity read: the known module, or the first one; false for another one. */
  identify(info) {
    if (this.memory.serial && info.serial !== this.memory.serial) {
      if (this.memory.otherSerial !== info.serial) {
        this.logger.warn('NASweb: another module answers at the address, nothing more sent to it');
      }
      this.memory.otherSerial = info.serial;
      return false;
    }
    if (this.memory.otherSerial) {
      this.memory.otherSerial = null;
      this.pendingTrust = undefined;
    }
    if (!this.memory.serial) {
      this.logger.info(`NASweb module identified: serial ${info.serial}`);
    }
    this.memory.serial = info.serial;
    this.memory.name = info.name;
    return true;
  }

  async loginAccepted() {
    if (this.memory.auth.blocked) {
      this.memory.auth = emptyMemory().auth;
      await this.saveMemory();
      this.logger.info('NASweb: login accepted, the stop is lifted');
    }
  }

  async failed(err) {
    const kind = err?.kind ?? ERROR_KINDS.UNREACHABLE;
    if (kind === ERROR_KINDS.AUTH) {
      const salt = randomBytes(16).toString('hex');
      this.memory.auth = { blocked: true, salt, tag: credentialsTag(salt, this.config) };
      await this.saveMemory();
      this.logger.warn(
        'NASweb: the module refused the login; nothing more is sent before new credentials or a test',
      );
    } else if (kind !== ERROR_KINDS.CERTIFICATE && kind !== ERROR_KINDS.STALE) {
      this.lastError = kind;
      this.warnOnce(`read:${kind}`, `NASweb module: ${err?.message ?? kind}`);
    }
    await this.updateStatus();
  }

  /** The push URL for a subscription (`{ host, port }`); the token is never logged. */
  pushUrl({ host, port }) {
    return `http://${urlHost(host, port)}${RECEIVER.pathPrefix}${this.tokens.push}`;
  }

  /** The push address Gladys should give the module now, or undefined. */
  pushTarget() {
    if (!this.config.gladysHost || !this.receiver.port || !isToken(this.tokens.push)) {
      return undefined;
    }
    return {
      host: this.config.gladysHost,
      port: this.receiver.port,
      tag: tokenTag(this.tokens.push),
    };
  }

  subscriptionCurrent() {
    const wanted = this.pushTarget();
    const done = this.memory.subscribed;
    return (
      wanted !== undefined &&
      done !== null &&
      done.host === wanted.host &&
      done.port === wanted.port &&
      done.tag === wanted.tag
    );
  }

  /** Subscribes the module to the push URL when it changed, or renews it while nothing arrives. */
  async subscribe(generation, { force = false } = {}) {
    const wanted = this.pushTarget();
    if (!wanted) {
      return;
    }
    const current = this.subscriptionCurrent();
    if (
      !force &&
      current &&
      (this.pushFresh() || this.now() - this.memory.subscribedAt < TIMINGS.resubscribe)
    ) {
      return;
    }
    const old = this.memory.subscribed;
    try {
      if (old && !current && old.tag === wanted.tag) {
        // The old address of Gladys is withdrawn (best effort: it may be gone already).
        await this.client
          .subscription(this.options(generation), this.pushUrl(old), false)
          .catch((err) => {
            if (err?.kind === ERROR_KINDS.AUTH || err?.kind === ERROR_KINDS.CERTIFICATE) throw err;
            return false;
          });
      }
      const ok = await this.client.subscription(
        this.options(generation),
        this.pushUrl(wanted),
        true,
      );
      if (generation !== this.generation) return;
      this.subscribeRefused = !ok;
      if (ok) {
        this.memory.subscribed = { host: wanted.host, port: wanted.port, tag: wanted.tag };
        this.memory.subscribedAt = this.now();
        await this.saveMemory();
        this.logger.info(
          `NASweb: the module sends its states to ${urlHost(wanted.host, wanted.port)}`,
        );
      } else {
        this.warnOnce('subscribe', 'The module refused the subscription to its states');
      }
    } catch (err) {
      if (generation === this.generation) {
        await this.failed(err);
      }
    }
  }

  // --- Devices -----------------------------------------------------------------------

  async rebuild({ force = false } = {}) {
    this.model = buildModel({
      externalIds: this.ids(),
      serial: this.memory?.serial ?? undefined,
      name: this.memory?.name ?? '',
      outputs: [...this.outputs.keys()],
      inputs: [...this.inputs.keys()],
      temperature: this.seenTemperature,
      safeOutputs: this.config.safeOutputs,
      language: this.config.language,
    });
    this.publisher.configure({
      intervalSeconds: TIMINGS.temperatureEvery / 1000,
      throttled: this.model.throttled,
    });
    const devices = this.keepCreatedFeatures(this.model.devices);
    this.recordAll();
    const json = JSON.stringify(devices);
    if (force || json !== this.publishedDevices) {
      this.publishedDevices = json;
      await this.gladys
        .publishDiscoveredDevices(devices)
        .catch((err) => this.logger.warn(`Publishing the devices failed: ${err.message}`));
    }
    await this.updateStatus();
    await this.publishAllTransports();
  }

  /**
   * A device the user created never loses a feature (the core would mark it
   * changed and "Update" would drop the history): the features of the created
   * device that the new build lacks are kept as they are.
   */
  keepCreatedFeatures(devices) {
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    return devices.map((device) => {
      const old = created.get(device.external_id);
      if (!old) {
        return device;
      }
      const ids = new Set(device.features.map((f) => f.external_id));
      const kept = (old.features ?? [])
        .filter((f) => typeof f.external_id === 'string' && !ids.has(f.external_id))
        .map((f) => {
          const copy = {};
          for (const key of [
            'name',
            'external_id',
            'category',
            'type',
            'unit',
            'min',
            'max',
            'read_only',
            'has_feedback',
            'keep_history',
          ]) {
            if (f[key] !== undefined && f[key] !== null) {
              copy[key] = f[key];
            }
          }
          return copy;
        });
      return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
    });
  }

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  async deviceCreated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    const fresh = this.pushFresh();
    for (const f of device?.features ?? []) {
      const value = fresh ? this.lastValues.get(f.external_id) : undefined;
      if (value) {
        this.publisher.push(f.external_id, value);
      }
    }
    await this.publishAllTransports().catch(() => {});
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  /** Gladys asks for the devices: what is known now (the module is not read sooner). */
  async scan() {
    await this.rebuild({ force: true });
  }

  transportOf(deviceId) {
    const reachable = this.model.deviceOf.has(deviceId) && this.pushFresh() && this.trusted();
    return reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
  }

  async publishAllTransports() {
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const transport = this.transportOf(device.external_id);
      if (this.transports.get(device.external_id) !== transport) {
        this.transports.set(device.external_id, transport);
        entries.push({ external_id: device.external_id, transport });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      await this.gladys
        .publishTransports(entries.slice(i, i + 100))
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  // --- Status ------------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The status from what is known now: the most pressing situation first. */
  statusNow() {
    const m = this.memory ?? emptyMemory();
    const c = this.config;
    if (c.problem) return [false, T.problem(c.problem)];
    if (this.unreadable) return [false, T.unreadable];
    if (m.auth.blocked) return [false, T.refused];
    if (m.refusedPin) return [false, T.certificate(m.refusedPin)];
    if (m.otherSerial) return [false, T.otherDevice(m.otherSerial, m.serial)];
    if (this.lastError && !this.pushFresh()) return [false, T.unreachable(this.lastError)];
    if (!m.serial) return [false, T.connecting];
    if (c.gladysHostError) return [false, T.badGladysAddress];
    if (!c.gladysHost) return [false, T.noGladysAddress];
    if (this.receiver.status !== 'running') return [false, T.noReceiver(this.receiver.status)];
    const refused = [];
    if (this.clock() - this.refusedPushes.at < 10 * 60_000) {
      if (this.refusedPushes.source > 0) {
        refused.push(T.wrongSource(this.refusedPushes.source, this.refusedPushes.from));
      }
      if (this.refusedPushes.serial > 0) {
        refused.push(T.wrongSerial(this.refusedPushes.serial));
      }
    }
    if (this.lastPush === undefined) {
      const address = this.receiver.port ? urlHost(c.gladysHost, this.receiver.port) : c.gladysHost;
      return [
        false,
        T.join(this.subscribeRefused ? T.subscribeRefused : T.waiting(address), ...refused),
      ];
    }
    if (!this.pushFresh()) {
      return [false, T.join(T.silent(age(this.clock() - this.lastPush)), ...refused)];
    }
    return [
      true,
      T.join(
        T.connected({
          name: m.name,
          serial: m.serial,
          outputs: this.outputs.size,
          inputs: this.inputs.size,
          safe: [...this.outputs.keys()].filter((i) => c.safeOutputs.has(i)).length,
          commands: c.allowCommands,
          invalid: c.invalidOutputs,
        }),
        ...refused,
      ),
    ];
  }

  updateStatus() {
    return this.setStatus(...this.statusNow());
  }

  // --- Commands ------------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  waitFor(index, wanted, deadline, mono) {
    let waiter;
    const promise = new Promise((resolve) => {
      waiter = { index, wanted, sentAt: undefined, resolve };
      waiter.timer = this.timers.setTimeout(
        () => this.settleWaiter(waiter, false),
        Math.max(0, deadline - mono),
      );
    });
    this.waiters.add(waiter);
    return {
      promise,
      cancel: () => this.settleWaiter(waiter, false),
      /** The bytes leave now: only a status posted from now confirms; older commands are replaced. */
      sent: () => {
        waiter.sentAt = this.now();
        for (const other of [...this.waiters]) {
          if (other !== waiter && other.index === index) {
            this.settleWaiter(other, 'replaced');
          }
        }
      },
    };
  }

  settleWaiter(waiter, result) {
    if (this.waiters.delete(waiter)) {
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
  }

  failWaiters() {
    for (const waiter of [...this.waiters]) {
      this.settleWaiter(waiter, false);
    }
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.clock();
    const entry = this.model.features.get(feature?.external_id);
    if (!entry) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const { spec, index } = entry;
    if (spec.refusal) {
      // A switch kept from before, of an output no longer declared safe.
      throw this.refusal(ERRORS[spec.refusal]);
    }
    if (!spec.command) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = onOff(value);
    if (wanted === undefined) {
      throw this.refusal(ERRORS.badValue);
    }
    this.checkCommand(index);
    if (!this.pushFresh(received)) {
      throw this.refusal(ERRORS.noFreshState);
    }
    if (!this.outputs.has(index)) {
      throw this.refusal(ERRORS.unknownOutput);
    }
    // One write at a time per output: a newer command waits for the WRITE of the
    // previous one only (not for its confirmation), then replaces it.
    const prior = this.writes.get(index);
    let release;
    const mine = new Promise((resolve) => {
      release = resolve;
    });
    this.writes.set(index, mine);
    try {
      if (prior) {
        await prior;
      }
      await this.command(index, wanted === 1, received, release);
    } finally {
      release();
      if (this.writes.get(index) === mine) {
        this.writes.delete(index);
      }
    }
  }

  /** What a command needs, on the latest configuration and memory. */
  checkCommand(index) {
    if (this.config.problem || !this.started) {
      throw this.refusal(ERRORS.notConfigured);
    }
    if (this.unreadable) {
      throw this.refusal(ERRORS.unreadable);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.commandsDisabled);
    }
    if (!this.config.safeOutputs.has(index)) {
      throw this.refusal(ERRORS.unsafeOutput);
    }
    if (this.memory.auth.blocked) {
      throw this.refusal(ERRORS.refusedLogin);
    }
    if (this.memory.refusedPin || this.memory.otherSerial) {
      throw this.refusal(ERRORS.untrusted);
    }
    if (!this.memory.serial || !this.memory.pin) {
      throw this.refusal(ERRORS.noIdentity);
    }
  }

  /** The refusal of a request that did not leave. */
  async refusalOf(err, generation) {
    if (err?.kind === ERROR_KINDS.REFUSED && err.cause instanceof Error) {
      return err.cause;
    }
    if (
      generation === this.generation &&
      (err?.kind === ERROR_KINDS.AUTH || err?.kind === ERROR_KINDS.CERTIFICATE)
    ) {
      await this.failed(err);
    }
    switch (err?.kind) {
      case ERROR_KINDS.AUTH:
        return this.refusal(ERRORS.refusedLogin);
      case ERROR_KINDS.CERTIFICATE:
      case ERROR_KINDS.OTHER_DEVICE:
        return this.refusal(ERRORS.untrusted);
      case ERROR_KINDS.LATE:
        return this.refusal(ERRORS.tooSlow);
      case ERROR_KINDS.STALE:
        return this.refusal(ERRORS.configChanged);
      default:
        return this.refusal(ERRORS.unreachable(err?.kind));
    }
  }

  /** The answer to a write that may have reached the module. */
  async afterSent(err, generation, index) {
    if (err?.kind === ERROR_KINDS.AUTH) {
      if (generation === this.generation) {
        await this.failed(err);
      }
      return this.refusal(ERRORS.loginRefusedSent);
    }
    this.logger.warn(`NASweb output ${index}: ${err?.message ?? 'no answer'}`);
    if (err?.kind === ERROR_KINDS.HTTP) {
      return this.refusal(ERRORS.errorAnswer(err.status));
    }
    if (err?.kind === ERROR_KINDS.PROTOCOL) {
      return this.refusal(ERRORS.unreadableAnswer);
    }
    return this.refusal(ERRORS.noAnswer);
  }

  async command(index, state, received, written = () => {}) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const start = this.clock();
    const readBy = Math.min(start + TIMINGS.commandReadMax, sendBy - TIMINGS.commandMinSend);
    if (readBy - start < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    // The identity of the module now (never the one in memory): nothing is written by this read.
    let info;
    try {
      info = await this.client.deviceInfo(this.options(generation, { timeoutMs: readBy - start }));
    } catch (err) {
      throw await this.refusalOf(err, generation);
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.configChanged);
    }
    if (info.serial !== this.memory.serial) {
      this.identify(info);
      await this.saveMemory();
      await this.updateStatus();
      throw this.refusal(ERRORS.untrusted);
    }
    const check = (mono) => {
      if (generation !== this.generation) {
        throw this.refusal(ERRORS.configChanged);
      }
      this.checkCommand(index);
      if (mono > sendBy) {
        throw this.refusal(ERRORS.tooSlow);
      }
    };
    const before = this.clock();
    check(before);
    // The confirmation is awaited from before the write (a fast module).
    const confirmation = this.waitFor(index, state, answerBy, before);
    let ok;
    try {
      ok = await this.client.setOutput(
        this.options(generation, {
          timeoutMs: Math.max(1, answerBy - before),
          // beforeSend: the very last check, right before the bytes leave.
          beforeSend: () => {
            check(this.clock());
            confirmation.sent();
          },
        }),
        index,
        state,
      );
    } catch (err) {
      confirmation.cancel();
      written();
      if (notSent(err)) {
        throw await this.refusalOf(err, generation);
      }
      // The request may have reached the module: never "not sent".
      throw await this.afterSent(err, generation, index);
    }
    // The next command on this output may leave now: it does not wait for this confirmation.
    written();
    this.logger.info(`NASweb output ${index}: ${state ? 'on' : 'off'} sent`);
    if (!ok) {
      confirmation.cancel();
      throw this.refusal(ERRORS.rejected);
    }
    const result = await confirmation.promise;
    if (result === 'replaced') {
      throw this.refusal(ERRORS.replaced);
    }
    if (!result) {
      throw this.refusal(ERRORS.sentUnconfirmed);
    }
  }

  // --- Configuration screen buttons ---------------------------------------------------

  /**
   * Reads the module with the saved configuration (even after a refused
   * login: the user asked), at most every 10 s, and says what answered.
   */
  async testConnection() {
    if (this.clock() - this.lastTest < TIMINGS.testCooldown) {
      return TEST.tooSoon;
    }
    this.lastTest = this.clock();
    const raw = await this.gladys.getConfig().catch(() => this.rawConfig ?? {});
    const next = normalizeConfig(raw);
    if (next.problem) {
      return T.problem(next.problem);
    }
    if (this.unreadable) {
      // The user's gesture: start again from scratch (the certificate is pinned again).
      this.unreadable = false;
      this.memory = { ...emptyMemory(), target: targetOf(next) };
      this.logger.warn(
        "NASweb: /data could not be read; starting again from scratch at the user's request",
      );
      if (!(await this.saveMemory())) {
        this.unreadable = true;
        return T.unreadable;
      }
    }
    if (!this.started || connectionKey(next) !== this.connKey) {
      await this.start(raw);
    } else {
      await this.applySoft(next, raw);
    }
    if (this.receiver.status !== 'running') {
      await this.ensureReceiver();
    }
    await this.reading?.catch(() => {});
    const result = await this.read({ force: true, test: true });
    await this.updateStatus();
    if (result.info && this.trusted()) {
      const wanted = this.pushTarget();
      return TEST.ok({
        name: result.info.name,
        serial: result.info.serial,
        port: this.receiver.port,
        address: wanted ? urlHost(wanted.host, wanted.port) : undefined,
      });
    }
    return this.statusNow()[1];
  }

  /**
   * "Trust the device now answering", in two clicks: the first one shows the
   * fingerprint and the serial refused and trusts nothing; a second one
   * within 60 s trusts exactly those, if they are still the ones refused
   * (otherwise they are shown again), then reads the module.
   */
  async trustDevice() {
    const refused = {
      fingerprint: this.memory?.refusedPin ?? null,
      serial: this.memory?.otherSerial ?? null,
    };
    if (!refused.fingerprint && !refused.serial) {
      this.pendingTrust = undefined;
      return TRUST.nothing;
    }
    const pending = this.pendingTrust;
    const now = this.clock();
    if (
      !pending ||
      pending.fingerprint !== refused.fingerprint ||
      pending.serial !== refused.serial ||
      now - pending.at > TIMINGS.trustConfirm ||
      now < pending.at
    ) {
      this.pendingTrust = { ...refused, at: now };
      return TRUST.confirm(refused);
    }
    this.pendingTrust = undefined;
    if (refused.fingerprint) {
      this.memory.pin = refused.fingerprint;
      this.memory.refusedPin = null;
    }
    if (refused.serial) {
      // Another module: what was known of the old one is forgotten (new devices).
      this.memory.serial = refused.serial;
      this.memory.otherSerial = null;
      this.memory.name = '';
      this.memory.subscribed = null;
      this.resetModule();
    }
    this.lastError = undefined;
    await this.saveMemory();
    this.logger.info('NASweb: the device now answering was trusted by the user');
    await this.reading?.catch(() => {});
    await this.read({ force: true });
    await this.rebuild({ force: true });
    return T.join(TRUST.done, this.statusNow()[1]);
  }
}
