// -----------------------------------------------------------------------------
// The states sent to Gladys, within its 300 states per minute (as the
// sibling gladys-qbus, same author, Apache-2.0).
//
// The module pushes its whole status (every output, input and the probe)
// often. The publisher keeps the LAST value of each feature, sends the
// pending ones every second within a per-minute budget, skips the unchanged
// ones (publishChangedStates) and spaces the measurements of a same feature
// by the configured interval (the temperature). On/off states are never
// throttled, only budgeted. A command never waits for it.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({
    gladys,
    logger,
    now = Date.now,
    timers = globalThis,
    budget = LIMITS.statesPerMinute,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.budget = budget;
    /** featureId -> { state } */
    this.pending = new Map();
    /** featureId -> last send time */
    this.lastSent = new Map();
    /** send times of the last minute */
    this.window = [];
    this.interval = 0;
    this.throttled = new Set();
    this.timer = undefined;
    this.flushing = undefined;
  }

  configure({ intervalSeconds, throttled }) {
    this.interval = intervalSeconds * 1000;
    this.throttled = throttled ?? new Set();
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending the states failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  /** Forget a device (deleted): its pending values are dropped. */
  forget(deviceId) {
    for (const map of [this.pending, this.lastSent]) {
      for (const key of map.keys()) {
        if (key === deviceId || key.startsWith(`${deviceId}:`)) {
          map.delete(key);
        }
      }
    }
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async doFlush() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < 60_000);
    let room = this.budget - this.window.length;
    if (room <= 0 || this.pending.size === 0) {
      return 0;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (room <= 0) {
        break;
      }
      const last = this.lastSent.get(featureId);
      if (this.throttled.has(featureId) && last !== undefined && now - last < this.interval) {
        continue;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
      room -= 1;
    }
    if (batch.length === 0) {
      return 0;
    }
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      for (const entry of batch) {
        this.lastSent.set(entry.device_feature_external_id, now);
      }
      for (let i = 0; i < (result?.count ?? batch.length); i += 1) {
        this.window.push(now);
      }
      return result?.count ?? batch.length;
    } catch (err) {
      // Keep the values for the next round, unless a newer one arrived meanwhile.
      for (const entry of batch) {
        const { device_feature_external_id: id, ...value } = entry;
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
