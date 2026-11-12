import test from 'node:test';
import assert from 'node:assert/strict';
import { DriverLease } from './lease.js';

function fakeClock() {
  let time = 0;
  let nextTimerId = 0;
  const timers = new Map();

  return {
    now: () => time,
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(milliseconds) {
      const end = time + milliseconds;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        time = timer.at;
        timer.callback();
      }
      time = end;
    },
  };
}

function makeLease(options = {}) {
  const clock = fakeClock();
  return {
    clock,
    lease: new DriverLease({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      ...options,
    }),
  };
}

test('the first driver receives a lease token', () => {
  const { lease } = makeLease();

  const result = lease.acquire('connection-a');

  assert.equal(result.ok, true);
  assert.match(result.token, /^[0-9a-f-]{36}$/i);
});

test('a second driver is refused and can see the holder controller id', () => {
  const { lease } = makeLease();
  lease.acquire('connection-a');

  const result = lease.acquire('connection-b');

  assert.deepEqual(result, { ok: false, holder: 'controller-1' });
});

test('a wrong token cannot heartbeat or release the current lease', () => {
  const { clock, lease } = makeLease({ ms: 3000 });
  const { token } = lease.acquire('connection-a');
  clock.advance(2999);

  assert.equal(lease.heartbeat('wrong-token'), false);
  assert.equal(lease.release('wrong-token'), false);
  assert.equal(lease.holder(), 'controller-1');
  clock.advance(1);
  assert.equal(lease.holder(), null);
  assert.equal(lease.heartbeat(token), false);
});

test('the lease expires after three seconds without a heartbeat', () => {
  const { clock, lease } = makeLease({ ms: 3000 });
  lease.acquire('connection-a');
  const firstControllerId = lease.holder();

  clock.advance(2999);
  assert.equal(lease.holder(), firstControllerId);
  clock.advance(1);
  assert.equal(lease.holder(), null);
  lease.acquire('connection-a');
  assert.equal(lease.holder(), firstControllerId);
});

test('a valid heartbeat extends the lease and release frees it immediately', () => {
  const { clock, lease } = makeLease({ ms: 3000 });
  const first = lease.acquire('connection-a');
  clock.advance(2500);

  assert.equal(lease.heartbeat(first.token), true);
  clock.advance(2500);
  assert.equal(lease.holder(), 'controller-1');
  assert.equal(lease.release(first.token), true);
  assert.equal(lease.holder(), null);
  assert.equal(lease.acquire('connection-b').ok, true);
});

test('expiry invokes the callback once', () => {
  const clock = fakeClock();
  const releases = [];
  const arbiter = { release: (reason) => releases.push(reason) };
  const lease = new DriverLease({
    ms: 3000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onExpire: (reason) => arbiter.release(reason),
  });
  lease.acquire('connection-a');

  clock.advance(3000);
  assert.deepEqual(releases, ['lease_expired']);
  assert.equal(lease.holder(), null);
  assert.deepEqual(releases, ['lease_expired']);
});

test('holder keeps its connection identity across release and reconnects get a new id', () => {
  const { lease } = makeLease();
  const { token } = lease.acquire('connection-a');

  const firstControllerId = lease.holder();
  assert.match(firstControllerId, /^controller-\d+$/);
  assert.notEqual(firstControllerId, token);

  assert.equal(lease.release(token), true);
  const renewed = lease.acquire('connection-a');
  assert.equal(lease.holder(), firstControllerId);
  assert.equal(lease.release(renewed.token), true);
  lease.acquire('connection-a-reconnected');
  const secondControllerId = lease.holder();
  assert.match(secondControllerId, /^controller-\d+$/);
  assert.notEqual(secondControllerId, firstControllerId);
});

function setup(options = {}) {
  let time = 0, nextId = 0;
  const timers = new Map(), expired = [];
  const lease = new DriverLease({
    now: () => time,
    setTimeout: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    onExpire: reason => expired.push(reason),
    ...options,
  });
  const advance = ms => {
    const end = time + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due; timers.delete(id); time = timer.at; timer.callback();
    }
    time = end;
  };
  return { lease, advance, expired, timers };
}

test('one driver owns the lease, and its public identity is separate from the secret token', () => {
  const { lease } = setup();
  const a = lease.register('a'), b = lease.register('b');
  assert.notEqual(a, b);
  const first = lease.acquire('a');
  assert.equal(first.ok, true);
  assert.match(first.token, /^[0-9a-f-]{36}$/i);
  assert.equal(lease.holder(), a);
  assert.notEqual(first.token, a);
  assert.deepEqual(lease.acquire('b'), { ok: false, holder: a });
  assert.deepEqual(lease.acquire('a'), first);
  assert.equal(lease.owns('a', first.token), true);
  assert.equal(lease.owns('b', first.token), false);
  assert.equal(lease.owns('a', 'wrong'), false);
  assert.equal(lease.heartbeat('wrong'), false);
  assert.equal(lease.release('wrong'), false);
});

test('default expiry is three seconds and only a valid heartbeat extends it', () => {
  const { lease, advance, expired } = setup({ ms: 3000 });
  const { token } = lease.acquire('a');
  const holder = lease.holder();
  advance(2999); assert.equal(lease.holder(), holder);
  assert.equal(lease.heartbeat(token), true);
  advance(2999); assert.equal(lease.holder(), holder);
  advance(1); assert.equal(lease.holder(), null);
  assert.equal(lease.heartbeat(token), false);
  assert.deepEqual(expired, ['lease_expired']);
  advance(3000); assert.deepEqual(expired, ['lease_expired']);
});

test('IDs belong to connections across release and expiry; reconnects get fresh IDs', () => {
  const { lease, advance, timers } = setup({ ms: 3000 });
  const id = lease.register('a');
  const first = lease.acquire('a');
  assert.equal(lease.release(first.token), true);
  assert.equal(timers.size, 0);
  const second = lease.acquire('a');
  assert.notEqual(second.token, first.token);
  assert.equal(lease.holder(), id);
  advance(3000);
  lease.acquire('a'); assert.equal(lease.holder(), id);
  assert.equal(lease.disconnect('spectator'), false);
  assert.equal(lease.holder(), id);
  assert.equal(lease.disconnect('a'), true);
  assert.equal(lease.holder(), null); assert.equal(timers.size, 0);
  assert.notEqual(lease.register('a-reconnected'), id);
});
