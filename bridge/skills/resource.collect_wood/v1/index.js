import { setTimeout as delay } from 'node:timers/promises';
import { aimDelta, angularError, wrapRadians } from '../../../geometry.js';

export const countLogs = (inventory) => Object.entries(inventory ?? {})
  .reduce((count, [name, amount]) => count + (name.endsWith('_log') && Number.isFinite(amount) ? amount : 0), 0);
export const COUNT_MAX = 64;
// 30 s of base time plus 30 s per log: 180000 ms for the default of 5.
export const timeLimitFor = (count) => 30000 + 30000 * count;
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const key = (p) => `${p.x},${p.y},${p.z}`;
const center = (p) => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });

function logsIn(observation) {
  const p = observation.facts.position;
  return Object.entries(observation.facts.nearest_blocks)
    .filter(([name, block]) => name.endsWith('_log') && block &&
      [block.dx, block.dy, block.dz].every(Number.isFinite))
    .map(([type, b]) => ({ type, x: Math.round(p.x + b.dx), y: Math.round(p.y + b.dy), z: Math.round(p.z + b.dz) }));
}

// Close enough to dig from where the bot stands: within 2.25 blocks sideways and 4.35 from the eye.
function canDig(p, block) {
  const c = center(block);
  return horizontal(p, c) <= 2.25 && Math.hypot(c.x - p.x, c.y - p.y - 1.62, c.z - p.z) <= 4.35;
}

function passage(terrain, direction = 'forward') {
  if (!terrain) return { unsafe: false, step: false, wall: false };
  const indices = { forward: [2, 1], back: [0, 1], left: [1, 0], right: [1, 2] };
  const [row, col] = indices[direction];
  const support = terrain.support_grid?.[row]?.[col];
  const clearance = terrain.clearance?.[direction];
  const unsafe = support && (support.available === false || support.drop_depth == null ||
    support.drop_depth >= 4 || /air|water|lava|fire/.test(support.support ?? ''));
  return {
    unsafe: Boolean(unsafe || /water|lava|fire/.test(clearance?.body ?? '')),
    step: clearance?.body_clear === false && clearance?.head_clear === true,
    wall: clearance?.head_clear === false,
  };
}

export function createRun({ tickMs = 50, now = () => performance.now(), timeLimitMs = null } = {}) {
  return async function run(bot, input = {}, { signal }) {
    const started = now();
    let before;
    try {
      signal.throwIfAborted();
      before = bot.observe();
      const goal = input.count ?? 5;
      const finish = (outcome, reason) => ({ outcome, reason, elapsed_ms: Math.max(0, now() - started), before, after: bot.observe() });
      if (!Number.isSafeInteger(goal) || goal < 1 || goal > COUNT_MAX) return finish('failure', 'requirement_unmet:count');
      const limit = timeLimitMs ?? timeLimitFor(goal);
      let state = { kind: 'explore' }, heading = before.self?.yaw ?? 0;
      let lastProgress = started, lastLogs = countLogs(before.inventory), lastRenew = started;
      let anchor = before.self?.position, anchorAt = started, detourUntil = 0, turns = 0;
      const ignored = new Map(), visited = new Map();
      for (;;) {
        signal.throwIfAborted();
        const time = now(), o = bot.observe(), p = o.self?.position;
        if (o.self?.health != null && o.self.health <= 0) return finish('failure', 'bot_death');
        if (!p || !o.facts?.position || !o.facts.nearest_blocks || o.inventory == null) {
          return finish('failure', 'requirement_unmet:observations');
        }
        const count = countLogs(o.inventory);
        if (count >= goal) return finish('success', 'wood_collected');
        if (time - started >= limit) return finish('timeout', 'explore_timeout');
        if (count > lastLogs) { lastProgress = time; lastLogs = count; }
        if (time - lastRenew >= 115000) { bot.releaseControls(); lastRenew = time; }
        const candidates = logsIn(o);
        const terrain = passage(o.terrain);
        if (anchor && horizontal(p, anchor) > 1.2) { anchor = p; anchorAt = time; }
        const stalled = time - anchorAt > 1600;
        const cell = `${Math.floor(p.x / 6)},${Math.floor(p.z / 6)}`;
        if (!visited.has(cell)) { visited.set(cell, time); lastProgress = time; }
        if (time - lastProgress > 45000) return finish('failure', 'stuck');

        if (state.kind === 'dig') {
          const point = center(state.target);
          if (Math.hypot(point.x - p.x, point.y - p.y - 1.62, point.z - p.z) > 4.35) {
            state = { kind: 'approach', target: state.target, since: time };
          }
        }
        if (state.kind === 'dig') {
          const present = candidates.some((b) => key(b) === key(state.target));
          if (!present && time - state.since > 500) {
            state = { kind: 'pickup', target: state.target, since: time };
          } else if (time - state.since > 10000) {
            ignored.set(key(state.target), time + 30000);
            state = { kind: 'explore' };
          }
        }
        if (state.kind === 'pickup' && (time - state.since > 4000 ||
          (horizontal(p, center(state.target)) < 0.75 && time - state.since > 1000))) {
          state = { kind: 'explore' };
        }
        if (state.kind === 'approach' && time - state.since > 16000) {
          ignored.set(key(state.target), time + 30000);
          state = { kind: 'explore' };
          detourUntil = time + 3000;
          heading = wrapRadians(heading + 1.7);
        }
        if (state.kind === 'explore' && time >= detourUntil) {
          const open = candidates.filter((b) => (ignored.get(key(b)) ?? 0) <= time);
          // Finish the tree it started: a log it can already dig from here comes before any walk to another one.
          const reachable = open.filter((b) => canDig(p, b)).sort((a, b) => a.y - b.y || horizontal(p, center(a)) - horizontal(p, center(b)))[0];
          const target = reachable ?? open.filter((b) => b.y >= p.y - 3 && b.y <= p.y + 4)
            .sort((a, b) => horizontal(p, a) - horizontal(p, b) || a.y - b.y)[0];
          if (reachable) {
            state = { kind: 'dig', target: reachable, since: time };
          } else if (target) state = { kind: 'approach', target, since: time };
        }

        let action;
        if (state.kind === 'dig') {
          const eye = { ...p, y: p.y + 1.62 };
          const aim = aimDelta(angularError(eye, o.self.yaw ?? 0, o.self.pitch ?? 0, center(state.target)));
          action = { dig: { x: state.target.x, y: state.target.y, z: state.target.z }, yaw_delta: aim.yaw, pitch_delta: aim.pitch };
        } else {
          const target = state.target && center(state.target);
          const desired = time < detourUntil ? heading : target
            ? Math.atan2(-(target.x - p.x), -(target.z - p.z)) : heading;
          const error = wrapRadians(desired - (o.self.yaw ?? 0));
          const aligned = Math.abs(error) < 0.32;
          if (aligned && (terrain.unsafe || terrain.wall || stalled)) {
            const right = passage(o.terrain, 'right'), left = passage(o.terrain, 'left');
            const sign = right.unsafe || right.wall ? 1 : left.unsafe || left.wall ? -1 : turns % 3 === 2 ? 1 : -1;
            heading = wrapRadians((o.self.yaw ?? 0) + sign * (1.05 + (turns % 3) * 0.35));
            turns++;
            detourUntil = time + 2200 + (turns % 3) * 500;
            anchor = p; anchorAt = time;
          }
          const steering = wrapRadians((time < detourUntil ? heading : desired) - (o.self.yaw ?? 0));
          action = { forward: Math.abs(steering) < 0.32 && !terrain.unsafe && !terrain.wall,
            jump: terrain.step && !terrain.unsafe, yaw_delta: Math.max(-0.18, Math.min(0.18, steering * 0.65)),
            pitch_delta: Math.max(-0.14, Math.min(0.14, -(o.self.pitch ?? 0) * 0.65)) };
          if (state.kind === 'approach' && time >= detourUntil) {
            if (canDig(p, state.target)) {
              state = { kind: 'dig', target: state.target, since: time };
              action = { dig: { x: state.target.x, y: state.target.y, z: state.target.z } };
            }
          }
        }
        bot.requestAction(action);
        await delay(tickMs, undefined, { signal });
      }
    } finally { bot.releaseControls(); }
  };
}

export const run = createRun();
