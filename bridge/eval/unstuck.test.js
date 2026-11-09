import test from 'node:test';
import assert from 'node:assert/strict';
import { createStuckDetector, findSafeSpot, createUnstuckWatchdog } from './unstuck.mjs';

const air = { name: 'air', boundingBox: 'empty' };
const stone = { name: 'stone', boundingBox: 'block' };
const position = { x: 0, y: 64, z: 0 };
const flat = (_x, y) => y < 64 ? stone : air;
const sample = (now, overrides = {}) => ({ now, position, dimension: 'overworld', inventoryKey: '', ...overrides });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('moving progresses; still waits the full 25000 ms; reset starts a fresh wait', () => {
  const moving = createStuckDetector();
  for (let t = 0; t <= 180000; t += 1000) assert.equal(moving.update(sample(t, { position: { ...position, x: t / 500 } })), null);
  const d = createStuckDetector();
  assert.equal(d.update(sample(0)), null);
  assert.equal(d.update(sample(24999)), null);
  assert.deepEqual(d.update(sample(25000)), { reason: 'no_movement' });
  d.reset(25000);
  assert.equal(d.update(sample(25000)), null);
  assert.equal(d.update(sample(49999)), null);
  assert.equal(d.update(sample(50000)).reason, 'no_movement');
});

test('inventory and dimension progress each restart the still clock', () => {
  for (const change of [{ inventoryKey: 'one_log' }, { dimension: 'the_nether' }]) {
    const d = createStuckDetector();
    d.update(sample(0));
    assert.equal(d.update(sample(24000, change)), null);
    assert.equal(d.update(sample(48999, change)), null);
    assert.equal(d.update(sample(49000, change)).reason, 'no_movement');
  }
});

test('rocking within the anchor radius remains stuck', () => {
  const d = createStuckDetector(); d.update(sample(0));
  for (let t = 1000; t < 25000; t += 1000) assert.equal(d.update(sample(t, { position: { ...position, x: t % 2000 ? 1.5 : -1.5 } })), null);
  assert.equal(d.update(sample(25000)).reason, 'no_movement');
});

test('circling reports wandering and inventory or dimension progress restarts its window', () => {
  const points = [{ x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }, { x: 3, y: 64, z: 3 }, { x: 0, y: 64, z: 3 }];
  const d = createStuckDetector();
  for (let i = 0; i < 12; i++) assert.equal(d.update(sample(i * 5000, { position: points[i % 4] })), null);
  assert.equal(d.update(sample(60000)).reason, 'wandering');
  for (const change of [{ inventoryKey: 'changed' }, { dimension: 'the_end' }]) {
    const next = createStuckDetector();
    for (let i = 0; i <= 18; i++) {
      assert.equal(next.update(sample(i * 5000, { position: points[i % 4], ...(i >= 11 ? change : {}) })), null);
    }
  }
});

test('hazards are immediate and a missing position never reports stuck', () => {
  const d = createStuckDetector();
  assert.deepEqual(d.update(sample(0, { hazard: 'lava' })), { reason: 'hazard:lava' });
  assert.equal(d.update(sample(90000, { position: null, hazard: 'fire' })), null);
  assert.equal(createStuckDetector().update(sample(90000, { position: undefined })), null);
});

test('open ground picks the nearest cell with repeatable ties', () => {
  const options = { blockAt: flat, origin: position };
  const p = findSafeSpot(options);
  assert.deepEqual({ x: p.x, y: p.y, z: p.z, distance: p.distance }, { x: -3, y: 64, z: 0, distance: 3 });
  assert.ok(p.reachable >= 40);
  assert.deepEqual(findSafeSpot(options), p);
});

test('a sealed five-deep pit rejects its nearest floor and returns the surface', () => {
  const pit = (x, y, z) => x === 0 && z === 0 && y >= 59 && y <= 63 ? air : flat(x, y, z);
  const p = findSafeSpot({ blockAt: pit, origin: { x: 0, y: 59, z: 0 }, minDistance: 0, maxRadius: 8 });
  assert.equal(p.y, 64);
  assert.ok(p.reachable >= 40);
  assert.notEqual(p.x === 0 && p.z === 0, true);
});

test('pit bottom escape lands at least minDistance away horizontally', () => {
  const pit = (x, y, z) => x === 0 && z === 0 && y >= 59 && y <= 63 ? air : flat(x, y, z);
  const origin = { x: 0, y: 59, z: 0 };
  const p = findSafeSpot({ blockAt: pit, origin, minDistance: 4, maxRadius: 8 });
  assert.ok(p);
  assert.ok(Math.hypot(p.x - origin.x, p.z - origin.z) >= 4);
});

test('a candidate beside a deep drop is rejected for the next-nearest good cell', () => {
  const cliff = (x, y, z) => x <= 5 && z <= 5 && y < 64 ? stone : air;
  const p = findSafeSpot({ blockAt: cliff, origin: { x: 5, y: 64, z: 5 }, minDistance: 0, maxRadius: 8 });
  assert.deepEqual({ x: p.x, y: p.y, z: p.z }, { x: 4, y: 64, z: 4 });
});

test('a candidate beside a two- or three-deep step is still allowed', () => {
  for (const depth of [2, 3]) {
    const step = (x, y, z) => x === 1 && z === 0 && y >= 64 - depth && y < 64 ? air : flat(x, y, z);
    const p = findSafeSpot({ blockAt: step, origin: position, minDistance: 0, maxRadius: 4 });
    assert.deepEqual({ x: p.x, y: p.y, z: p.z }, { x: 0, y: 64, z: 0 });
  }
});

test('a candidate beside an unloaded column is rejected', () => {
  const unloaded = (x, y, z) => x === 1 && z === 0 ? (y > 60 ? air : null) : flat(x, y, z);
  const p = findSafeSpot({ blockAt: unloaded, origin: position, minDistance: 0, maxRadius: 6 });
  assert.deepEqual({ x: p.x, y: p.y, z: p.z }, { x: -1, y: 64, z: 0 });
});

const oneCell = (change = () => undefined) => (x, y, z) => {
  const changed = change(x, y, z);
  return changed !== undefined ? changed : x === 0 && z === 0 && (y === 64 || y === 65) ? air : stone;
};
const singleSearch = (blockAt) => findSafeSpot({ blockAt, origin: position, minDistance: 0, maxRadius: 1, minReachable: 0 });

test('each forbidden floor, including leaves and logs, is rejected', () => {
  assert.equal(singleSearch(oneCell()).y, 64);
  for (const name of ['oak_leaves', 'birch_log', 'stripped_oak_log', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose', 'powder_snow', 'pointed_dripstone', 'water', 'lava', 'fire', 'soul_fire']) {
    assert.equal(singleSearch(oneCell((x, y, z) => x === 0 && y === 63 && z === 0 ? { name, boundingBox: 'block' } : undefined)), null, name);
  }
  assert.notEqual(singleSearch(oneCell((x, y, z) => x === 0 && y === 63 && z === 0 ? air : undefined))?.y, 64);
});

test('feet and head reject liquids, portals, cobweb and powder snow', () => {
  for (const name of ['water', 'lava', 'fire', 'soul_fire', 'nether_portal', 'cobweb', 'powder_snow']) for (const y0 of [64, 65]) {
    assert.equal(singleSearch(oneCell((x, y, z) => x === 0 && z === 0 && y === y0 ? { name, boundingBox: 'empty' } : undefined)), null, `${name} at ${y0}`);
  }
  assert.equal(singleSearch(oneCell((x, y, z) => x === 0 && z === 0 && y === 65 ? stone : undefined)), null);
  const feetBlocked = singleSearch(oneCell((x, y, z) => x === 0 && z === 0 && y === 64 ? stone : undefined));
  assert.notEqual(feetBlocked?.y, 64);
});

test('all 26 adjacent cells reject lava, fire, soul fire and unloaded blocks', () => {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dy === 0 && dz === 0) continue;
    for (const name of ['lava', 'fire', 'soul_fire', null]) {
      const world = oneCell((x, y, z) => x === dx && y === 64 + dy && z === dz ? name === null ? null : { name, boundingBox: 'empty' } : undefined);
      assert.equal(singleSearch(world), null, `${name} at ${dx},${dy},${dz}`);
    }
  }
  assert.equal(findSafeSpot({ blockAt: () => null, origin: position }), null);
});

test('a short ledge has too few other reachable cells; no floor returns null', () => {
  const ledge = (x, y, z) => x >= 0 && x < 5 && z >= 0 && z < 5 && y === 63 ? stone : air;
  assert.equal(findSafeSpot({ blockAt: ledge, origin: position, minDistance: 0, maxRadius: 6 }), null);
  const fortyCells = (x, y, z) => x >= 0 && x < 8 && z >= 0 && z < 5 && y === 63 ? stone : air;
  assert.equal(findSafeSpot({ blockAt: fortyCells, origin: position, minDistance: 0, maxRadius: 10 }), null);
  assert.equal(findSafeSpot({ blockAt: () => air, origin: position }), null);
});

test('reachability permits one-block steps and three-block drops, with jump clearance', () => {
  const options = { origin: position, minDistance: 0, maxRadius: 2, minReachable: 1 };
  // Neighbor columns get floors and blocked heads: no deep drops, yet nothing beside the step can be stood on.
  const pocket = (x, y, z) => {
    if (x === 0 && z === 0 && y === 63) return stone;
    if ((x === -1 && z === 0 || x === 0 && z === 1 || x === 0 && z === -1) && (y === 63 || y === 65)) return stone;
    if (x === 1 && z === 0 && y === 64) return stone;
    return air;
  };
  assert.equal(findSafeSpot({ ...options, blockAt: pocket }).x, 0);
  const lowCeiling = (x, y, z) => x === 0 && y === 66 && z === 0 ? stone : pocket(x, y, z);
  assert.equal(findSafeSpot({ ...options, blockAt: lowCeiling }), null);
  for (const drop of [3, 4]) {
    const world = (x, y, z) => (x === 0 && z === 0 && y === 63 + drop) ||
      (Math.abs(x) + Math.abs(z) === 1 && y === 63) ? stone : air;
    const found = findSafeSpot({ blockAt: world, origin: { x: 0, y: 64 + drop, z: 0 }, minDistance: 0, maxRadius: 5, minReachable: 1 });
    if (drop === 3) assert.equal(found.x, 0);
    else assert.equal(found, null);
  }
});

function rig(limits = {}, overrides = {}) {
  const r = { t: 0, position: { ...position }, dimension: 'overworld', inventory: {}, commands: [], logs: [] };
  r.observation = () => ({ self: { position: { ...r.position } }, dimension: r.dimension, inventory: r.inventory });
  r.w = createUnstuckWatchdog({
    observe: () => overrides.observe ? overrides.observe(r) : r.observation(),
    blockAt: overrides.blockAt ?? flat, username: 'SparPartner',
    isAllowedPosition: overrides.isAllowedPosition ?? (() => true), log: (s) => r.logs.push(s),
    now: () => r.t, sleep: async (ms) => { r.t += ms; }, limits,
    runCommand: async (command) => {
      r.commands.push(command);
      if (overrides.command) return overrides.command(command, r);
      if (overrides.confirm !== false) {
        const [x, y, z] = command.split(' ').slice(2).map(Number); r.position = { x, y, z };
      }
      return 'Teleported SparPartner';
    },
  });
  return r;
}
async function firstReset(r, step = 'step') { r.w.arm(step); await r.w.tick(); r.t += 25000; await r.w.tick(); }
async function nextReset(r) { r.t += 10000; await r.w.tick(); r.t += 25000; await r.w.tick(); }
const cellDistance = (e) => dist(e.from, { x: e.to.x - 0.5, y: e.to.y, z: e.to.z - 0.5 });

test('reset distances escalate 3, 6, 12; exact command, event evidence and cooldown', async () => {
  const r = rig({ perStep: 3, perRun: 10 }); await firstReset(r);
  assert.equal(r.commands[0], 'tp SparPartner -2.5 64 0.5');
  assert.equal(r.w.events[0].confirmed, true);
  assert.equal(r.w.events[0].reason, 'no_movement');
  assert.equal(r.w.events[0].attempt, 1);
  assert.equal(r.w.events[0].at_ms, 25000);
  assert.equal(r.w.events[0].rcon_reply, 'Teleported SparPartner');
  assert.equal(r.logs[0], 'UNSTUCK step=step reason=no_movement from=0,64,0 to=-2.5,64,0.5 confirmed=true');
  r.t += 9999; await r.w.tick(); assert.equal(r.commands.length, 1);
  await nextReset(r); await nextReset(r);
  const resets = r.w.events.filter((e) => e.to && e.reason === 'no_movement');
  assert.equal(resets.length, 3);
  for (const [i, min] of [3, 6, 12].entries()) assert.ok(cellDistance(resets[i]) >= min && cellDistance(resets[i]) < min + 1);
  assert.equal(r.commands.some((c) => c.includes('@')), false);
  assert.deepEqual(Object.keys(resets[0]).sort(), ['step', 'at_ms', 'reason', 'from', 'to', 'distance', 'attempt', 'rcon_reply', 'confirmed'].sort());
  assert.ok(Object.isFrozen(r.w.events) && Object.isFrozen(resets[0]) && Object.isFrozen(resets[0].to));
});

test('default two-per-step limit persists across rearming and records once', async () => {
  const r = rig(); await firstReset(r); await nextReset(r);
  for (let i = 0; i < 3; i++) { r.t += 100000; await r.w.tick(); }
  r.w.disarm(); r.w.arm('step'); await r.w.tick();
  assert.equal(r.commands.length, 2);
  assert.equal(r.w.events.filter((e) => e.reason === 'reset_limit').length, 1);
});

test('default five-per-run limit holds across steps and records once', async () => {
  const r = rig();
  for (let i = 0; i < 7; i++) { r.t += 10000; await firstReset(r, `s${i}`); }
  assert.equal(r.commands.length, 5);
  assert.equal(r.w.events.filter((e) => e.reason === 'reset_limit').length, 1);
  const one = rig({ perStep: 5, perRun: 1 }); await firstReset(one); await nextReset(one);
  assert.equal(one.commands.length, 1);
});

test('disarmed does nothing; region refusal and no safe spot send no command', async () => {
  let observations = 0;
  const off = rig({}, { observe: () => { observations++; throw new Error('disarmed observed'); } });
  await off.w.tick(); off.w.arm('unused'); off.w.disarm(); off.t = 100000; await off.w.tick();
  assert.equal(observations, 0); assert.equal(off.commands.length, 0);
  for (const [reason, overrides] of [['outside_region', { isAllowedPosition: () => false }], ['no_safe_spot', { blockAt: () => null }]]) {
    const r = rig({}, overrides); await firstReset(r);
    assert.equal(r.commands.length, 0); assert.equal(r.w.events[0].reason, reason);
    assert.equal(r.w.events[0].confirmed, false);
  }
});

test('ticks do not overlap while a command is pending', async () => {
  let finish;
  const r = rig({}, { command: () => new Promise((resolve) => { finish = resolve; }) });
  r.w.arm('step'); await r.w.tick(); r.t = 25000;
  const a = r.w.tick(), b = r.w.tick(); await Promise.resolve();
  assert.equal(a, b); assert.equal(r.commands.length, 1);
  finish('Teleported SparPartner'); await Promise.all([a, b]);
  assert.equal(r.commands.length, 1);
});

test('unconfirmed teleport times out at three seconds; command errors remain assistance', async () => {
  const r = rig({}, { confirm: false }); await firstReset(r);
  assert.equal(r.w.events[0].confirmed, false); assert.equal(r.t, 28000);
  assert.equal(r.commands.length, 1); assert.equal(r.logs.length, 1);
  const failed = rig({}, { command: async () => { throw new Error('offline failure'); } }); await firstReset(failed);
  assert.equal(failed.w.events[0].confirmed, false);
  assert.equal(failed.w.events[0].reason, 'no_movement'); assert.ok(failed.w.events[0].to);
});

test('disarm and rearm of the same step invalidates an awaiting observation', async () => {
  let finish;
  const r = rig({}, { observe: () => new Promise((resolve) => { finish = resolve; }), blockAt: (x, y, z) => x === 0 && y === 64 && z === 0 ? { name: 'lava', boundingBox: 'empty' } : flat(x, y, z) });
  r.w.arm('step'); const pending = r.w.tick(); r.w.disarm(); r.w.arm('step'); finish(r.observation()); await pending;
  assert.equal(r.commands.length, 0); assert.equal(r.w.events.length, 0);
});

test('watchdog fires on feet/head heat immediately and on eight seconds of head submersion', async () => {
  for (const name of ['lava', 'fire', 'soul_fire']) for (const y0 of [64, 65]) {
    const r = rig({}, { blockAt: (x, y, z) => x === 0 && z === 0 && y === y0 ? { name, boundingBox: 'empty' } : flat(x, y, z) });
    r.w.arm('hazard'); await r.w.tick(); assert.equal(r.commands.length, 1); assert.equal(r.w.events[0].reason, `hazard:${name}`);
  }
  let submerged = true;
  const r = rig({}, { blockAt: (x, y, z) => submerged && x === 0 && z === 0 && y === 65 ? { name: 'water', boundingBox: 'empty' } : flat(x, y, z) });
  r.w.arm('water'); await r.w.tick(); r.t = 4000; submerged = false; await r.w.tick();
  r.t = 5000; submerged = true; await r.w.tick(); r.t = 12999; await r.w.tick();
  assert.equal(r.commands.length, 0); r.t = 13000; await r.w.tick();
  assert.equal(r.commands.length, 1); assert.equal(r.w.events[0].reason, 'hazard:water');
});

test('unsafe usernames cannot become command text', () => {
  for (const username of ['@a', 'SparPartner\nstop', 'two names', '']) {
    assert.throws(() => createUnstuckWatchdog({ username }), /invalid_bot_username/);
  }
});
