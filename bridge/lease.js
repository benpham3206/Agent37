import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const DEFAULT_LEASE_MS = 3000;

// R1's DriverLease, with identity retained until the browser connection closes.
export class DriverLease {
  constructor({
    ms = Number(process.env.A37_LEASE_MS) || DEFAULT_LEASE_MS,
    now = performance.now.bind(performance),
    setTimeout = globalThis.setTimeout,
    clearTimeout = globalThis.clearTimeout,
    onExpire = () => {},
  } = {}) {
    this.ms = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_LEASE_MS;
    this.now = now;
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
    this.onExpire = onExpire;
    this.controllerSequence = 0;
    this.controllerIds = new Map();
    this.current = null;
  }

  register(connectionId) {
    if (connectionId == null) throw new TypeError('connectionId is required');
    if (!this.controllerIds.has(connectionId)) {
      this.controllerIds.set(connectionId, `controller-${++this.controllerSequence}`);
    }
    return this.controllerIds.get(connectionId);
  }

  acquire(connectionId) {
    const controllerId = this.register(connectionId);
    this.#expireIfDue();
    if (this.current) {
      if (this.current.connectionId === connectionId) return { ok: true, token: this.current.token };
      return { ok: false, holder: this.current.controllerId };
    }
    this.current = { connectionId, controllerId, token: randomUUID(), expiresAt: this.now() + this.ms, timer: null };
    this.#scheduleExpiry(this.current);
    return { ok: true, token: this.current.token };
  }

  owns(connectionId, token) {
    this.#expireIfDue();
    return Boolean(this.current && this.current.connectionId === connectionId && this.current.token === token);
  }

  heartbeat(token) {
    this.#expireIfDue();
    if (!this.current || this.current.token !== token) return false;
    this.current.expiresAt = this.now() + this.ms;
    this.#scheduleExpiry(this.current);
    return true;
  }

  release(token) {
    this.#expireIfDue();
    if (!this.current || this.current.token !== token) return false;
    this.#clearExpiry(this.current);
    this.current = null;
    return true;
  }

  disconnect(connectionId) {
    this.#expireIfDue();
    const held = Boolean(this.current && this.current.connectionId === connectionId);
    if (held) this.release(this.current.token);
    this.controllerIds.delete(connectionId);
    return held;
  }

  holder() {
    this.#expireIfDue();
    return this.current?.controllerId ?? null;
  }

  #expireIfDue() {
    if (this.current && this.now() >= this.current.expiresAt) this.#expire(this.current);
  }

  #scheduleExpiry(current) {
    this.#clearExpiry(current);
    current.timer = this.setTimeout(() => {
      if (this.current !== current) return;
      if (this.now() < current.expiresAt) { this.#scheduleExpiry(current); return; }
      this.#expire(current);
    }, Math.max(0, current.expiresAt - this.now()));
  }

  #clearExpiry(current) {
    if (current.timer !== null) {
      this.clearTimeout(current.timer);
      current.timer = null;
    }
  }

  #expire(current) {
    if (this.current !== current) return;
    this.#clearExpiry(current);
    this.current = null;
    this.onExpire('lease_expired');
  }
}
