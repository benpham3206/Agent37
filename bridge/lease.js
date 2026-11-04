import { randomUUID } from 'node:crypto';

const DEFAULT_LEASE_MS = 3000;

export class DriverLease {
  constructor({
    ms = Number(process.env.A37_LEASE_MS) || DEFAULT_LEASE_MS,
    now = Date.now,
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

  acquire(connectionId) {
    if (connectionId == null) throw new TypeError('connectionId is required');
    this.#expireIfDue();

    if (this.current) {
      if (this.current.connectionId === connectionId) {
        return { ok: true, token: this.current.token };
      }
      return { ok: false, holder: this.current.controllerId };
    }

    if (!this.controllerIds.has(connectionId)) {
      this.controllerIds.set(connectionId, `controller-${++this.controllerSequence}`);
    }
    const current = {
      connectionId,
      controllerId: this.controllerIds.get(connectionId),
      token: randomUUID(),
      expiresAt: this.now() + this.ms,
      timer: null,
    };
    this.current = current;
    this.#scheduleExpiry(current);
    return { ok: true, token: current.token };
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

  holder() {
    this.#expireIfDue();
    return this.current?.controllerId ?? null;
  }

  #expireIfDue() {
    if (this.current && this.now() >= this.current.expiresAt) {
      this.#expire(this.current);
    }
  }

  #scheduleExpiry(current) {
    this.#clearExpiry(current);
    const delay = Math.max(0, current.expiresAt - this.now());
    current.timer = this.setTimeout(() => {
      if (this.current !== current) return;
      if (this.now() < current.expiresAt) {
        this.#scheduleExpiry(current);
        return;
      }
      this.#expire(current);
    }, delay);
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
    this.onExpire();
  }
}
