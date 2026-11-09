import { setTimeout as delay, setImmediate as yieldTick } from 'node:timers/promises';
import { aimDelta, angularError } from '../../../geometry.js';

const pickaxes = new Set(['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']);
const oreTypes = ['iron_ore', 'deepslate_iron_ore'];
const sameCell = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z;

function nearestOre(observation) {
  const position = observation.facts.position;
  const nearest = oreTypes.map((type) => observation.facts.nearest_blocks[type])
    .filter(Boolean).sort((a, b) => a.distance - b.distance)[0];
  return nearest ? { type: nearest.type, x: Math.round(position.x + nearest.dx),
    y: Math.round(position.y + nearest.dy), z: Math.round(position.z + nearest.dz) } : null;
}

export function createRun({ tickMs = 100, reach = 4, now = () => performance.now() } = {}) {
  return async function run(bot, input = {}, { signal }) {
    const started = now();
    let before;
    try {
      signal.throwIfAborted();
      before = bot.observe();
      const startIron = before?.inventory?.raw_iron ?? 0;
      const finish = (outcome, reason) => ({ outcome, reason, elapsed_ms: Math.max(0, now() - started), before, after: bot.observe() });
      const held = before?.self?.held_item;
      const hotbar = before?.self?.hotbar_slot ?? 0;
      if (!pickaxes.has(held)) return finish('failure', 'requirement_unmet:no_pickaxe');
      let state = { phase: 'seek' };
      for (;;) {
        signal.throwIfAborted();
        const o = bot.observe();
        if (o?.self?.health != null && o.self.health <= 0) return finish('failure', 'bot_death');
        if ((o?.inventory?.raw_iron ?? 0) > startIron) return finish('success', 'raw_iron_collected');
        if (o?.self?.on_ground === false) {
          bot.requestAction({ hotbar, forward: false });
          await delay(tickMs, undefined, { signal });
          continue;
        }
        if (!o?.facts?.nearest_blocks || !o.facts.position || !o.self?.position) return finish('failure', 'requirement_unmet:no_block_facts');
        const nearest = nearestOre(o);
        if (state.phase === 'seek') {
          if (!nearest) return finish('failure', 'no_ore_in_range');
          state = { phase: 'mine', target: nearest };
        }
        if (state.phase === 'mine') {
          const fact = o.facts.nearest_blocks[state.target.type];
          const current = fact && { x: Math.round(o.facts.position.x + fact.dx),
            y: Math.round(o.facts.position.y + fact.dy), z: Math.round(o.facts.position.z + fact.dz) };
          if (!sameCell(current, state.target)) state = { phase: 'pickup', target: state.target, since: now() };
        }
        const target = state.target;
        const self = o.self.position;
        const point = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 };
        const eye = { x: self.x, y: self.y + 1.62, z: self.z };
        const error = angularError(eye, o.self.yaw ?? 0, o.self.pitch ?? 0, point);
        const delta = aimDelta(error);
        const action = { hotbar, forward: false, yaw_delta: delta.yaw, pitch_delta: delta.pitch };
        const distance = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
        if (state.phase === 'mine' && distance <= reach) {
          action.dig = { x: target.x, y: target.y, z: target.z };
        } else {
          action.forward = Math.hypot(point.x - self.x, point.z - self.z) > 0.2 && Math.abs(error.yaw) < 0.25;
        }
        if (state.phase === 'pickup' && now() - state.since > 8000) return finish('failure', 'drop_not_collected');
        bot.requestAction(action);
        await delay(tickMs, undefined, { signal });
      }
    } finally {
      bot.releaseControls();
    }
  };
}

const air = new Set(['air', 'cave_air', 'void_air']);
const directions = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }, { x: -1, z: 0 }];
const cellKey = (p) => `${p.x},${p.y},${p.z}`;
const cellAt = (p) => ({ x: Math.floor(p.x), y: Math.round(p.y), z: Math.floor(p.z) });

export function createDescentRun({ tickMs = 100, now = () => performance.now(), phaseLimitMs = 30000 } = {}) {
  const wait = (signal) => tickMs === 0 ? yieldTick(undefined, { signal }) : delay(tickMs, undefined, { signal });
  return async function runDescent(bot, input = {}, { signal }) {
    const started = now(), route = [], transitions = [], rejected = [];
    let before, state = { phase: 'plan', since: started }, lease = started, renewals = 0;
    const enter = (phase, details = {}) => {
      state = { ...state, ...details, phase, since: now() };
      transitions.push({ phase, at_ms: now() - started, from: state.from, to: state.to });
    };
    const finish = (outcome, reason) => ({ outcome, reason, elapsed_ms: Math.max(0, now() - started), before,
      after: bot.observe(), navigation: { route, transitions, rejected_steps: rejected, lease_renewals: renewals } });
    try {
      signal.throwIfAborted();
      before = bot.observe();
      if (!pickaxes.has(before?.self?.held_item)) return finish('failure', 'requirement_unmet:no_pickaxe');
      const hotbar = before.self.hotbar_slot ?? 0, initialIron = before.inventory?.raw_iron ?? 0;
      for (;;) {
        signal.throwIfAborted();
        const o = bot.observe(), p = o?.self?.position;
        if (o?.self?.health <= 0) return finish('failure', 'bot_death');
        if (!p || !o.facts?.nearest_blocks || !o.terrain?.clearance || !o.terrain.support_grid) return finish('failure', 'requirement_unmet:no_terrain');
        if (!pickaxes.has(o.self.held_item)) return finish('failure', 'requirement_unmet:pickaxe_lost');
        if (o.terrain.hazards?.lava || o.terrain.hazards?.fire || o.facts.nearest_blocks.lava?.distance < 3) return finish('failure', 'hazard:lava_or_fire');
        if (o.self.health <= 6) return finish('failure', 'hazard:low_health');
        if (state.to && p.y < state.to.y - 0.6) return finish('failure', 'unexpected_drop');
        if (now() - state.since > phaseLimitMs) return finish('failure', `descent_stuck:${state.phase}`);
        if (now() - lease >= 90000) { bot.releaseControls(); lease = now(); renewals++; }
        let action = { hotbar, forward: false };
        if (o.self.on_ground === false && state.phase !== 'move') {
          bot.requestAction(action);
          await wait(signal);
          continue;
        }
        if (state.phase === 'plan') {
          if (o.self.on_ground !== true) {
            bot.requestAction(action);
            await wait(signal);
            continue;
          }
          const current = cellAt(p);
          if (Math.abs(p.y - current.y) > 0.15) return finish('failure', 'unsupported_start_height');
          if (!route.length) route.push(current);
          if ((o.inventory?.raw_iron ?? 0) > initialIron) return finish('success', 'raw_iron_collected');
          if (route.length >= (input.max_steps ?? 120) || current.y <= (input.min_y ?? -48)) return finish('failure', 'search_limit');
          const floors = new Set(route.map((cell) => cellKey({ ...cell, y: cell.y - 1 })));
          let target = nearestOre(o);
          if (target && (target.y > current.y + 1 || floors.has(cellKey(target)))) target = null;
          const descending = !target || target.y < current.y;
          const ranked = [...directions].sort((a, b) => {
            if (!target) return 0;
            return Math.abs(target.x - current.x - a.x) + Math.abs(target.z - current.z - a.z) -
              Math.abs(target.x - current.x - b.x) - Math.abs(target.z - current.z - b.z);
          });
          let to;
          for (const direction of ranked) {
            const candidate = { x: current.x + direction.x, y: current.y - Number(descending), z: current.z + direction.z };
            if (rejected.some((step) => sameCell(step.from, current) && sameCell(step.to, candidate))) continue;
            if (target && candidate.x === target.x && candidate.z === target.z && candidate.y > target.y) continue;
            if (route.some((cell) => cell.x === candidate.x && cell.z === candidate.z)) continue;
            if ([candidate.y, current.y, current.y + 1].some((y) => floors.has(cellKey({ ...candidate, y })))) continue;
            const bounds = input.bounds;
            if (bounds && Math.hypot(candidate.x + 0.5 - bounds.x, candidate.z + 0.5 - bounds.z) > bounds.radius) continue;
            to = candidate;
            break;
          }
          if (!to) return finish('failure', 'no_safe_stair_route');
          enter('align', { from: current, to, descending, target });
        }
        const point = { x: state.to.x + 0.5, y: p.y + 1.62, z: state.to.z + 0.5 };
        const eye = { x: p.x, y: p.y + 1.62, z: p.z };
        const error = angularError(eye, o.self.yaw ?? 0, o.self.pitch ?? 0, point);
        const delta = aimDelta(error);
        action.yaw_delta = delta.yaw;
        action.pitch_delta = delta.pitch;
        if (state.phase === 'align') {
          if (Math.abs(error.yaw) < 0.04) enter('head');
        } else if (state.phase === 'move') {
          const distance = Math.hypot(point.x - p.x, point.z - p.z);
          if (distance < 0.18 && Math.abs(p.y - state.to.y) < 0.15 && o.self.on_ground === true) {
            route.push(state.to);
            enter('plan', { to: null });
          } else action.forward = distance >= 0.12 && Math.abs(error.yaw) < 0.12;
        } else {
          const forward = o.terrain.clearance.forward, support = o.terrain.support_grid[2]?.[1];
          if (!forward?.available || !support?.available) return finish('failure', 'terrain_unavailable');
          if ([forward.head, forward.body, support.support].some((name) => ['lava', 'water', 'fire'].includes(name))) return finish('failure', 'hazard:fluid_or_fire');
          if (o.terrain.drop_forward >= 4) return finish('failure', 'hazard:deep_drop');
          let dig;
          if (state.phase === 'head') {
            if (air.has(forward.head)) enter('body');
            else dig = { x: state.to.x, y: state.from.y + 1, z: state.to.z };
          } else if (state.phase === 'body') {
            if (air.has(forward.body)) {
              if (state.descending) {
                if (!support.solid) {
                  rejected.push({ from: state.from, to: state.to, reason: 'unsafe_descent_open_floor' });
                  enter('plan', { to: null });
                } else enter('cut_floor');
              } else {
                if (!support.solid) {
                  rejected.push({ from: state.from, to: state.to, reason: 'unsafe_level_floor' });
                  enter('plan', { to: null });
                } else enter('move');
              }
            } else dig = { x: state.to.x, y: state.from.y, z: state.to.z };
          } else if (state.phase === 'cut_floor') {
            if (air.has(support.support)) enter('move');
            else if (support.solid) dig = { x: state.to.x, y: state.from.y - 1, z: state.to.z };
            else return finish('failure', 'unsafe_descent_open_floor');
          }
          if (dig) {
            if (dig.x === Math.floor(p.x) && dig.z === Math.floor(p.z) && dig.y < p.y) return finish('failure', 'position_changed_during_dig');
            const aim = aimDelta(angularError(eye, o.self.yaw ?? 0, o.self.pitch ?? 0, { x: dig.x + 0.5, y: dig.y + 0.5, z: dig.z + 0.5 }));
            action = { ...action, yaw_delta: aim.yaw, pitch_delta: aim.pitch, dig };
          }
        }
        bot.requestAction(action);
        await wait(signal);
      }
    } finally { bot.releaseControls(); }
  };
}

const surfaceRun = createRun(), descentRun = createDescentRun();
export const run = (bot, input, context) => input?.descent ? descentRun(bot, input, context) : surfaceRun(bot, input, context);
