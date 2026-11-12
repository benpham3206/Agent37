import { setTimeout as delay } from 'node:timers/promises';
import { recipeChain } from './recipe.js';

const COUNTED = ['oak_log', 'crafting_table', 'wooden_pickaxe'];
const UP = { x: 0, y: 1, z: 0 };
// Cells next to the feet in the terrain grid's own frame (rx, rz relative to where the bot faces).
const SIDES = [['forward', 0, 1], ['right', 1, 0], ['left', -1, 0], ['back', 0, -1]];

const count = (o, item) => (Number.isFinite(o?.inventory?.[item]) ? o.inventory[item] : 0);
const counts = (o) => Object.fromEntries(COUNTED.map((item) => [item, o?.inventory ? count(o, item) : null]));
const feet = (o) => { const p = o.self.position; return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }; };
const eyeDistance = (o, b) => { const p = o.self.position;
  return Math.hypot(b.x + 0.5 - p.x, b.y + 0.5 - p.y - 1.62, b.z + 0.5 - p.z); };

// Absolute position of the nearest crafting table the observation reports, or null.
export function tableIn(o) {
  const b = o?.facts?.nearest_blocks?.crafting_table, fp = o?.facts?.position;
  if (!b || !fp || ![b.dx, b.dy, b.dz].every(Number.isFinite)) return null;
  return { x: Math.round(fp.x + b.dx), y: Math.round(fp.y + b.dy), z: Math.round(fp.z + b.dz) };
}

// A free spot beside the bot with solid ground under it, as the block to click (the ground) and the
// spot where the table will appear. Uses the same yaw rotation as the terrain observation.
export function placeSpot(o) {
  const grid = o?.terrain?.support_grid, clear = o?.terrain?.clearance, yaw = o?.self?.yaw;
  if (!grid || !clear || !Number.isFinite(yaw)) return null;
  const p = o.self.position, f = feet(o);
  for (const [side, rx, rz] of SIDES) {
    const ground = grid[rz + 1]?.[rx + 1];
    if (!ground?.available || !ground.solid || ground.drop_depth !== 0 || !clear[side]?.body_clear) continue;
    const x = Math.floor(p.x + rx * Math.cos(yaw) - rz * Math.sin(yaw));
    const z = Math.floor(p.z - rx * Math.sin(yaw) - rz * Math.cos(yaw));
    return { click: { x, y: f.y - 1, z }, table: { x, y: f.y, z } };
  }
  return null;
}

export function createRun({ tickMs = 50, limitMs = 10000, retryMs = 1500, clickMs = 1000, now = () => performance.now() } = {}) {
  return async function run(bot, input, { signal }) {
    const started = now(), deadline = started + limitMs;
    const before = bot.observe();
    const finish = (outcome, reason) => ({ outcome, reason, elapsed_ms: Math.max(0, now() - started),
      before: counts(before), after: counts(bot.observe()) });
    let seq = 0;
    const id = () => `craft-pickaxe-${Date.now().toString(36)}-${++seq}`;

    // Ask, then watch the observation until check(o) holds. Re-ask every `every` ms while nothing
    // happened. Between asks, hold() replaces the request so a click is not repeated every tick.
    async function until(check, ask, every, hold = null) {
      let asked = -Infinity;
      for (;;) {
        signal.throwIfAborted();
        const o = bot.observe(), t = now();
        if (o?.self?.health != null && o.self.health <= 0) return 'bot_death';
        if (check(o)) return null;
        if (t >= deadline) return 'time_limit';
        if (t - asked >= every) { asked = t; ask(o); } else hold?.();
        await delay(tickMs, undefined, { signal });
      }
    }

    try {
      if (!before?.self?.position || !before.inventory) return finish('failure', 'requirement_unmet:no_observation');
      const startPickaxes = count(before, 'wooden_pickaxe');
      let table = tableIn(before);
      if (table && eyeDistance(before, table) > 4) table = null;
      let steps;
      try { steps = recipeChain('wooden_pickaxe', before.inventory, { tableNearby: Boolean(table) }); }
      catch (error) {
        if (error.code === 'missing_materials') return finish('failure', `requirement_unmet:${error.message}`);
        throw error;
      }
      for (const step of steps) {
        if (step.action === 'place') {
          const spot = placeSpot(bot.observe());
          if (!spot) return finish('failure', 'no_place_for_table');
          const placed = (o) => { const t = tableIn(o); return t && t.x === spot.table.x && t.y === spot.table.y && t.z === spot.table.z; };
          const problem = await until(placed,
            () => bot.requestAction({ equip: 'crafting_table', interact: { ...spot.click, face: UP } }), clickMs,
            () => bot.requestAction({ equip: 'crafting_table' }));
          bot.requestAction({});
          if (problem) return finish(problem === 'time_limit' ? 'timeout' : 'failure', problem === 'time_limit' ? 'time_limit' : problem);
          table = spot.table;
          continue;
        }
        const goal = count(bot.observe(), step.item) + step.count;
        const problem = await until((o) => count(o, step.item) >= goal,
          () => bot.requestAction({ craft: { id: id(), name: step.item, count: step.count, ...(step.table ? { table } : {}) } }), retryMs);
        if (problem === 'time_limit') return finish('timeout', 'time_limit');
        if (problem) return finish('failure', problem);
      }
      const after = bot.observe();
      return count(after, 'wooden_pickaxe') > startPickaxes ? finish('success', 'crafted')
        : finish('failure', 'pickaxe_not_in_inventory');
    } finally {
      bot.releaseControls();
    }
  };
}

export const run = createRun();
