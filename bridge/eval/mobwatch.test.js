import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobWatchdog } from './mobwatch.mjs';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const UUID2 = 'abcdefab-1234-4abc-8def-0123456789ab';
let nextId = 1;
const mob = (type, distance, extra = {}) => ({
  id: nextId++, type, distance, dx: distance, dy: 0, dz: 0, hostile: true, uuid: UUID, ...extra,
});
const EVENT_KEYS = ['step', 'at_ms', 'reason', 'mob_type', 'mob_id', 'uuid', 'distance', 'health', 'rcon_reply', 'confirmed'];

function rig(limits = {}, overrides = {}) {
  const r = { t: 0, position: { x: 0, y: 64, z: 0 }, hit: false, mobs: [], gone: new Set(),
    commands: [], logs: [], observes: 0, resolves: 0 };
  r.observation = () => ({
    self: { position: { ...r.position }, health: 20, incoming_attack: { hit_received: r.hit } },
    facts: { position: { ...r.position }, health: 20,
      nearby_mobs: r.mobs.filter((m) => !r.gone.has(m.id)).map((m) => ({ ...m })) },
  });
  r.w = createMobWatchdog({
    observe: () => { r.observes++; return overrides.observe ? overrides.observe(r) : r.observation(); },
    resolveUuid: (entry) => { r.resolves++; return overrides.resolveUuid ? overrides.resolveUuid(entry, r) : entry.uuid ?? null; },
    runCommand: async (command) => {
      r.commands.push(command);
      if (overrides.command) return overrides.command(command, r);
      const id = command.split(' ')[1];
      const m = r.mobs.find((x) => x.uuid === id);
      if (m) r.gone.add(m.id);
      return `Killed ${id}`;
    },
    username: 'SparPartner',
    isAllowedPosition: overrides.isAllowedPosition ?? (() => true),
    log: (s) => r.logs.push(s),
    now: () => r.t,
    sleep: async (ms) => { r.t += ms; },
    limits,
  });
  return r;
}
async function armTick(r, step = 's', mobEntry = mob('zombie', 4)) {
  r.mobs = [mobEntry];
  r.w.arm(step);
  await r.w.tick();
}

test('distance rules fire just inside and refuse just outside each threshold', async () => {
  for (const [type, inside, outside, reason] of [
    ['creeper', 7, 7.01, 'creeper'],
    ['skeleton', 12, 12.01, 'ranged'],
    ['zombie', 5, 5.01, 'close_hostile'],
  ]) {
    const hit = rig(); await armTick(hit, 's', mob(type, inside));
    assert.equal(hit.commands.length, 1, `${type}@${inside}`);
    assert.equal(hit.w.events[0].reason, reason);
    assert.equal(hit.w.events[0].confirmed, true);
    const miss = rig(); await armTick(miss, 's', mob(type, outside));
    assert.equal(miss.commands.length, 0, `${type}@${outside}`);
    assert.equal(miss.w.events.length, 0);
  }
});

test('every ranged type uses the 12-block rule and keeps it over close_hostile', async () => {
  for (const type of ['skeleton', 'stray', 'bogged', 'witch', 'pillager', 'blaze']) {
    const near = rig(); await armTick(near, 's', mob(type, 4));
    assert.equal(near.commands.length, 1, `${type}@4`);
    assert.equal(near.w.events[0].reason, 'ranged');
    const far = rig(); await armTick(far, 's', mob(type, 12.01));
    assert.equal(far.commands.length, 0, `${type}@12.01`);
    const edge = rig(); await armTick(edge, 's', mob(type, 12));
    assert.equal(edge.commands.length, 1, `${type}@12`);
  }
});

test('creeper and ranged never fall back to the 5-block rule', async () => {
  const creeper = rig(); await armTick(creeper, 's', mob('creeper', 6));
  assert.equal(creeper.commands.length, 1);
  assert.equal(creeper.w.events[0].reason, 'creeper');
  for (const type of ['skeleton', 'stray', 'bogged', 'witch', 'pillager', 'blaze']) {
    const r = rig(); await armTick(r, 's', mob(type, 12.5));
    assert.equal(r.commands.length, 0, type);
  }
});

test('enderman piglin and zombified_piglin are eligible only via hit_received as nearest hostile', async () => {
  for (const type of ['enderman', 'piglin', 'zombified_piglin']) {
    const calm = rig(); await armTick(calm, 's', mob(type, 1));
    assert.equal(calm.commands.length, 0, `${type} alone`);
    assert.equal(calm.w.events.length, 0);
    const hit = rig(); hit.hit = true; await armTick(hit, 's', mob(type, 10));
    assert.equal(hit.commands.length, 1, `${type} hit`);
    assert.equal(hit.w.events[0].reason, 'hit_received');
  }
});

test('hit_received qualifies the nearest hostile within 16 even without a distance rule', async () => {
  const r = rig(); r.hit = true; await armTick(r, 's', mob('zombie', 10));
  assert.equal(r.commands.length, 1);
  assert.equal(r.w.events[0].reason, 'hit_received');
  const far = rig(); far.hit = true; await armTick(far, 's', mob('zombie', 17));
  assert.equal(far.commands.length, 0);
  const edge = rig(); edge.hit = true; await armTick(edge, 's', mob('zombie', 16));
  assert.equal(edge.commands.length, 1);
  const passive = rig(); passive.hit = true;
  passive.mobs = [mob('cow', 2, { hostile: false }), mob('zombie', 10)];
  passive.w.arm('s'); await passive.w.tick();
  assert.equal(passive.commands.length, 1);
  assert.equal(passive.w.events[0].mob_type, 'zombie');
  assert.equal(passive.w.events[0].reason, 'hit_received');
});

test('the hit rule picks the nearest hostile, not a farther eligible-looking mob', async () => {
  const r = rig(); r.hit = true;
  const enderman = mob('enderman', 10), zombie = mob('zombie', 12);
  r.mobs = [enderman, zombie]; r.w.arm('s'); await r.w.tick();
  assert.equal(r.commands.length, 1);
  assert.equal(r.w.events[0].mob_id, enderman.id);
  assert.equal(r.w.events[0].reason, 'hit_received');
});

test('passive mobs are never eligible even adjacent with hit_received', async () => {
  for (const hostile of [false, undefined, 'yes']) {
    const r = rig(); r.hit = true;
    r.mobs = [mob('cow', 1, { hostile }), mob('pig', 1, { hostile: false })];
    r.w.arm('s'); await r.w.tick();
    assert.equal(r.commands.length, 0, String(hostile));
    assert.equal(r.w.events.length, 0);
  }
});

test('nearest eligible threat wins over a nearer passive mob and unordered facts', async () => {
  const r = rig();
  r.mobs = [mob('cow', 1, { hostile: false }), mob('zombie', 8), mob('creeper', 6)];
  r.w.arm('s'); await r.w.tick();
  assert.equal(r.commands.length, 1);
  assert.equal(r.w.events[0].mob_type, 'creeper');
  assert.equal(r.w.events[0].reason, 'creeper');
  const tie = rig();
  const first = mob('zombie', 4, { uuid: UUID }), second = mob('zombie', 4, { uuid: UUID2 });
  tie.mobs = [first, second]; tie.w.arm('s'); await tie.w.tick();
  assert.equal(tie.commands[0], `kill ${UUID}`);
});

test('the command is exactly kill <uuid> and only canonical UUIDs pass', async () => {
  const upper = rig();
  upper.mobs = [mob('zombie', 4, { uuid: UUID.toUpperCase() })];
  upper.w.arm('s'); await upper.w.tick();
  assert.equal(upper.commands[0], `kill ${UUID.toUpperCase()}`);
  assert.equal(upper.w.events[0].uuid, UUID.toUpperCase());
  assert.equal(upper.w.events[0].rcon_reply, `Killed ${UUID.toUpperCase()}`);
  for (const bad of ['not-a-uuid', 'Steve', '@e[type=zombie]', 'SparPartner',
    '123e4567e89b42d3a456426614174000', '123e4567-e89b-42d3-a456-42661417400',
    `${UUID}\nkill @e`, `${UUID} extra`, 12345, {}, '123e4567-e89b-42d3-a456-426614174000\n']) {
    const r = rig(); r.mobs = [mob('zombie', 4, { uuid: bad })]; r.w.arm('s'); await r.w.tick();
    assert.equal(r.commands.length, 0, JSON.stringify(bad));
    assert.equal(r.w.events[0]?.reason, 'invalid_uuid', JSON.stringify(bad));
  }
});

test('missing uuid is no_uuid and never reaches the command line', async () => {
  for (const value of [null, undefined, '']) {
    const r = rig({}, { resolveUuid: () => value });
    r.mobs = [mob('zombie', 4)]; r.w.arm('s'); await r.w.tick();
    assert.equal(r.commands.length, 0);
    assert.equal(r.w.events[0].reason, 'no_uuid');
    assert.equal(r.w.events[0].uuid, null);
    assert.equal(r.w.events[0].confirmed, false);
  }
  const absent = rig();
  absent.mobs = [{ id: nextId++, type: 'zombie', distance: 4, dx: 4, dy: 0, dz: 0, hostile: true }];
  absent.w.arm('s'); await absent.w.tick();
  assert.equal(absent.commands.length, 0);
  assert.equal(absent.w.events[0].reason, 'no_uuid');
});

test('bot and mob positions outside the region refuse with outside_region', async () => {
  const noBot = rig({}, { isAllowedPosition: () => false });
  await armTick(noBot); assert.equal(noBot.commands.length, 0);
  assert.equal(noBot.w.events[0].reason, 'outside_region');
  const mobFar = mob('zombie', 4, { dx: 500 });
  const noMob = rig({}, { isAllowedPosition: (p) => p.x < 100 });
  await armTick(noMob, 's', mobFar);
  assert.equal(noMob.commands.length, 0);
  assert.equal(noMob.w.events[0].reason, 'outside_region');
  const noSelf = rig();
  noSelf.observation = () => ({ self: { position: null, health: 20, incoming_attack: {} },
    facts: { nearby_mobs: [{ ...mob('zombie', 4) }] } });
  noSelf.w.arm('s'); await noSelf.w.tick();
  assert.equal(noSelf.commands.length, 0);
  assert.equal(noSelf.w.events[0].reason, 'outside_region');
});

test('missing or invalid mob coordinates refuse via outside_region; explicit position works', async () => {
  for (const entry of [
    { id: nextId++, type: 'zombie', distance: 4, hostile: true, uuid: UUID },
    { id: nextId++, type: 'zombie', distance: 4, dx: 'x', dy: 0, dz: 0, hostile: true, uuid: UUID },
    { id: nextId++, type: 'zombie', distance: 4, dx: 4, dy: 0, hostile: true, uuid: UUID },
    { id: nextId++, type: 'zombie', distance: 4, position: { x: NaN, y: 64, z: 0 }, hostile: true, uuid: UUID },
  ]) {
    const r = rig(); r.mobs = [entry]; r.w.arm('s'); await r.w.tick();
    assert.equal(r.commands.length, 0, JSON.stringify(entry));
    assert.equal(r.w.events[0].reason, 'outside_region');
  }
  const explicit = rig();
  explicit.mobs = [{ id: nextId++, type: 'zombie', distance: 4, position: { x: 2, y: 64, z: 2 }, hostile: true, uuid: UUID }];
  explicit.w.arm('s'); await explicit.w.tick();
  assert.equal(explicit.commands.length, 1);
  assert.equal(explicit.w.events[0].confirmed, true);
});

test('refusals record once per threat per cooldown and never consume kill limits', async () => {
  const r = rig({}, { resolveUuid: (m) => (m.id === bad.id ? null : m.uuid) });
  const bad = mob('zombie', 4);
  r.mobs = [bad]; r.w.arm('s'); await r.w.tick();
  assert.equal(r.w.events.length, 1);
  assert.equal(r.w.events[0].reason, 'no_uuid');
  r.t += 1000; await r.w.tick();
  assert.equal(r.w.events.length, 1);
  r.t += 1001; await r.w.tick();
  assert.equal(r.w.events.length, 2);
  r.mobs = [mob('creeper', 6)]; r.t += 2000; await r.w.tick();
  assert.equal(r.commands.length, 1);
  assert.equal(r.w.events.at(-1).reason, 'creeper');
});

test('disarmed ticks observe nothing, resolve nothing, command nothing and record once per period', async () => {
  let observed = 0, resolved = 0;
  const r = rig({}, {
    observe: (x) => { observed++; return x.observation(); },
    resolveUuid: (m) => { resolved++; return m.uuid; },
  });
  await r.w.tick(); await r.w.tick();
  assert.equal(observed, 0); assert.equal(resolved, 0); assert.equal(r.commands.length, 0);
  assert.equal(r.w.events.length, 1);
  assert.deepEqual(r.w.events[0], { step: null, at_ms: 0, reason: 'disarmed', mob_type: null,
    mob_id: null, uuid: null, distance: null, health: null, rcon_reply: null, confirmed: false });
  r.mobs = [mob('zombie', 4)]; r.w.arm('s'); await r.w.tick();
  assert.equal(r.commands.length, 1);
  r.w.disarm(); await r.w.tick(); await r.w.tick();
  assert.equal(r.w.events.filter((e) => e.reason === 'disarmed').length, 2);
  assert.equal(r.w.events.at(-1).step, 's');
  r.w.arm('t'); r.w.disarm(); await r.w.tick();
  assert.equal(r.w.events.filter((e) => e.reason === 'disarmed').length, 3);
  assert.equal(r.w.events.at(-1).step, 't');
});

test('default limits allow 4 per step and 10 per run; mob_limit records once across rearm', async () => {
  const r = rig(); r.w.arm('s');
  for (let i = 0; i < 6; i++) { r.mobs = [mob('zombie', 4)]; await r.w.tick(); r.t += 2000; }
  assert.equal(r.commands.length, 4);
  assert.equal(r.w.events.filter((e) => e.reason === 'mob_limit').length, 1);
  assert.equal(r.w.events.filter((e) => e.reason === 'close_hostile').length, 4);
  r.w.disarm(); r.w.arm('s'); r.mobs = [mob('zombie', 4)]; await r.w.tick();
  assert.equal(r.commands.length, 4);
  assert.equal(r.w.events.filter((e) => e.reason === 'mob_limit').length, 1);
});

test('run limit spans steps and overridden limits take effect', async () => {
  const r = rig({ perStep: 100, perRun: 10 });
  for (let s = 0; s < 12; s++) {
    r.mobs = [mob('zombie', 4)]; r.w.arm(`s${s}`); await r.w.tick(); r.t += 2000;
  }
  assert.equal(r.commands.length, 10);
  assert.equal(r.w.events.filter((e) => e.reason === 'mob_limit').length, 1);
  const small = rig({ perStep: 1, perRun: 2 });
  for (const step of ['a', 'b', 'c']) {
    small.mobs = [mob('zombie', 4)]; small.w.arm(step); await small.w.tick(); small.t += 2000;
    small.mobs = [mob('zombie', 4)]; await small.w.tick(); small.t += 2000;
  }
  assert.equal(small.commands.length, 2);
  assert.ok(small.w.events.some((e) => e.reason === 'mob_limit'));
});

test('kills are spaced at least 2000 ms across steps and disarm', async () => {
  const r = rig(); r.mobs = [mob('zombie', 4)]; r.w.arm('s'); await r.w.tick();
  assert.equal(r.commands.length, 1);
  r.t += 1999; r.mobs = [mob('zombie', 4)]; await r.w.tick();
  assert.equal(r.commands.length, 1);
  r.w.disarm(); r.w.arm('other'); r.t += 1; await r.w.tick();
  assert.equal(r.commands.length, 2);
  assert.equal(r.w.events[1].step, 'other');
});

test('overlapping ticks share one in-flight attempt', async () => {
  let finish;
  const r = rig({}, { command: () => new Promise((resolve) => { finish = resolve; }) });
  r.mobs = [mob('zombie', 4)]; r.w.arm('s');
  const a = r.w.tick(), b = r.w.tick();
  assert.equal(a, b);
  for (let i = 0; i < 50 && !r.commands.length; i++) await new Promise((res) => setImmediate(res));
  assert.equal(r.commands.length, 1);
  finish('Killed x'); await Promise.all([a, b]);
  assert.equal(r.commands.length, 1);
});

test('confirmation needs the id absent from real facts within two seconds', async () => {
  const stays = rig({}, { command: async () => 'no effect' });
  stays.mobs = [mob('zombie', 4)]; stays.w.arm('s'); await stays.w.tick();
  assert.equal(stays.w.events[0].confirmed, false);
  assert.equal(stays.w.events[0].reason, 'close_hostile');
  assert.equal(stays.t, 2000);
  let polls = 0;
  const missingFacts = rig({}, {
    command: async () => 'ok',
    observe: (x) => (++polls === 1 ? x.observation() : { facts: null }),
  });
  missingFacts.mobs = [mob('zombie', 4)]; missingFacts.w.arm('s'); await missingFacts.w.tick();
  assert.equal(missingFacts.commands.length, 1);
  assert.equal(missingFacts.w.events[0].confirmed, false);
});

test('a surviving second mob does not block confirmation of the killed id', async () => {
  const r = rig();
  const victim = mob('zombie', 4, { uuid: UUID }), bystander = mob('skeleton', 10, { uuid: UUID2 });
  r.mobs = [victim, bystander]; r.w.arm('s'); await r.w.tick();
  assert.equal(r.commands[0], `kill ${UUID}`);
  assert.equal(r.w.events[0].confirmed, true);
  assert.equal(r.w.events[0].mob_id, victim.id);
});

test('rcon and observation errors stay visible as attempted assistance', async () => {
  const failed = rig({}, { command: async () => { throw new Error('offline'); } });
  failed.mobs = [mob('zombie', 4)]; failed.w.arm('s'); await failed.w.tick();
  assert.equal(failed.commands.length, 1);
  assert.equal(failed.w.events[0].reason, 'close_hostile');
  assert.equal(failed.w.events[0].confirmed, false);
  assert.equal(failed.w.events[0].rcon_reply, 'rcon_or_observation_error');
  assert.equal(failed.logs[0], `MOBWATCH step=s mob=zombie distance=4 reason=close_hostile confirmed=false`);
});

test('disarm during the confirmation poll still records the attempt once', async () => {
  let pollResolve, calls = 0;
  const r = rig({}, {
    command: async () => 'sent',
    observe: (x) => (++calls === 1 ? x.observation() : new Promise((res) => { pollResolve = res; })),
  });
  r.mobs = [mob('zombie', 4)]; r.w.arm('s');
  const pending = r.w.tick();
  for (let i = 0; i < 50 && !pollResolve; i++) await new Promise((res) => setImmediate(res));
  assert.equal(r.commands.length, 1);
  assert.equal(typeof pollResolve, 'function');
  r.w.disarm();
  pollResolve(r.observation());
  await pending;
  assert.equal(r.w.events.length, 1);
  assert.equal(r.w.events[0].reason, 'close_hostile');
  assert.equal(r.w.events[0].confirmed, false);
  await r.w.tick();
  assert.equal(r.w.events.at(-1).reason, 'disarmed');
});

test('a stale observe after disarm and rearm of the same step cannot kill', async () => {
  let finishObserve;
  const r = rig({}, { observe: () => new Promise((resolve) => { finishObserve = resolve; }) });
  r.w.arm('s');
  const pending = r.w.tick();
  r.w.disarm(); r.w.arm('s');
  finishObserve(r.observation());
  await pending;
  assert.equal(r.commands.length, 0);
  assert.equal(r.w.events.length, 0);
});

test('events are readonly snapshots with exact fields and the log line is exact', async () => {
  const r = rig(); await armTick(r, 'my.step', mob('creeper', 6));
  assert.equal(r.logs.length, 1);
  assert.equal(r.logs[0], 'MOBWATCH step=my.step mob=creeper distance=6 reason=creeper confirmed=true');
  assert.equal(r.w.events.length, 1);
  const e = r.w.events[0];
  assert.deepEqual(Object.keys(e).sort(), [...EVENT_KEYS].sort());
  assert.deepEqual(e, { step: 'my.step', at_ms: 0, reason: 'creeper', mob_type: 'creeper',
    mob_id: e.mob_id, uuid: UUID, distance: 6, health: 20, rcon_reply: `Killed ${UUID}`, confirmed: true });
  assert.ok(Object.isFrozen(r.w.events) && Object.isFrozen(e));
  assert.throws(() => { r.w.events[0].confirmed = false; });
  assert.equal(r.w.events.length, 1);
});

test('constructor rejects bad dependencies and limits', () => {
  for (const username of ['@a', 'SparPartner\nstop', 'two names', '']) {
    assert.throws(() => createMobWatchdog({ username }), /invalid_bot_username/);
  }
  assert.throws(() => createMobWatchdog({ username: 'Bot', observe: () => {} }), /missing_watchdog_dependency/);
  for (const limits of [{ perStep: -1 }, { perRun: 1.5 }, { perStep: 'x' }]) {
    assert.throws(() => createMobWatchdog({ username: 'Bot', observe: () => {}, resolveUuid: () => {},
      runCommand: () => {}, isAllowedPosition: () => {}, limits }), /invalid_kill_limits/);
  }
  assert.doesNotThrow(() => createMobWatchdog({ username: 'Bot', observe: () => {}, resolveUuid: () => {},
    runCommand: () => {}, isAllowedPosition: () => {}, log: () => {}, now: () => 0,
    sleep: async () => {}, limits: {} }));
});
