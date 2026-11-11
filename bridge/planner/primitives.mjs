// Low-level moves the planner model may choose: walk, dig, jump, wait, craft, place, use_on, equip, attack, flee.
// Fixed code with validated numbers. They act only through the bot adapter
// (observe, requestAction, releaseControls): no RCON, no commands, no model-written code.
// Every result is judged from what the next observations show, never from the request.
import { setTimeout as delay } from 'node:timers/promises';
import { aimDelta, angularError } from '../geometry.js';
import { WATCHED_BLOCKS } from '../observation.js';

export const LIMITS = Object.freeze({ walkRange: 16, walkMs: 8000, walkStallMs: 3000, digReach: 4, digMs: 10000, waitMaxSeconds: 3, tickMs: 50,
  craftMs: 10000, craftMax: 64, interactReach: 4, interactMs: 3000, equipMs: 1500,
  attackMs: 15000, attackReach: 3, fleeMs: 15000, fleeMax: 32, fleeStallMs: 3000 });
export const FACES = Object.freeze({ up: { x: 0, y: 1, z: 0 }, down: { x: 0, y: -1, z: 0 }, north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 }, east: { x: 1, y: 0, z: 0 }, west: { x: -1, y: 0, z: 0 } });
// Only blocks the observation reports can be confirmed, so only those may be placed.
export const PLACEABLE = Object.freeze(['crafting_table', 'furnace', 'obsidian'].filter((b) => WATCHED_BLOCKS.includes(b)));
// What each usable item must make appear. `where` is the clicked face's neighbour or anywhere in the watched area.
export const USE_ON = Object.freeze({ flint_and_steel: { appears: 'nether_portal', where: 'anywhere' },
  water_bucket: { appears: 'water', where: 'adjacent' }, lava_bucket: { appears: 'lava', where: 'adjacent' } });
// Real item names. The model must not invent generic ones; 'planks' alone is resolved from the logs held.
export const WOODS = Object.freeze(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped']);
export const PLANKS = Object.freeze(WOODS.map((w) => `${w}_planks`));
export const CRAFT_NAMES = Object.freeze(['planks', ...PLANKS, 'stick', 'crafting_table',
  ...['wooden', 'stone', 'iron'].flatMap((m) => ['pickaxe', 'axe', 'sword', 'shovel'].map((t) => `${m}_${t}`)),
  'shield', 'furnace', 'bucket', 'flint_and_steel']);
const CRAFTABLE = new Set(CRAFT_NAMES);
// The planks a held log makes: acacia_log -> acacia_planks, stripped_oak_log -> oak_planks, crimson_stem -> crimson_planks.
export function planksFromLog(item) {
  const m = /^(?:stripped_)?(.+?)_(?:log|wood|stem|hyphae)$/.exec(String(item));
  const wood = m ? m[1] : item === 'bamboo_block' || item === 'stripped_bamboo_block' ? 'bamboo' : null;
  return wood && WOODS.includes(wood) ? `${wood}_planks` : null;
}
// { acacia_log: 'acacia_planks', ... } for the logs held, most held first.
export function planksForHeld(inventory) {
  const out = {};
  for (const [item, n] of Object.entries(inventory ?? {}).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
    const planks = Number.isFinite(n) && n > 0 ? planksFromLog(item) : null;
    if (planks) out[item] = planks;
  }
  return out;
}
export const resolveCraftName = (name, inventory) => name === 'planks' ? Object.values(planksForHeld(inventory))[0] ?? null : name;
const ITEM = /^[a-z][a-z0-9_]{0,63}$/;
const FACE_LIST = Object.keys(FACES).join('|');

export const PRIMITIVE_SPECS = Object.freeze({
  walk: { args: { dx: 'int', dz: 'int', 'sprint?': 'boolean' }, description: 'Walk to the block dx, dz from your feet block (east is +dx, south is +dz), at most 16 blocks away. Walks at normal speed; add sprint:true only when speed matters. Jumps when blocked. Ends on arrival, after 8 s, or after 3 s with no progress.' },
  dig: { args: { dx: 'int', dy: 'int', dz: 'int' }, description: 'Dig the block dx, dy, dz from your feet block, within reach 4 (dy -1 is the block you stand on). Ends when it is gone or after 10 s.' },
  jump: { args: {}, description: 'Jump once.' },
  wait: { args: { seconds: 'number 0-3' }, description: 'Do nothing for a moment, at most 3 s.' },
  craft: { args: { name: 'item name', count: 'int 1-64', 'table?': '{dx,dy,dz} of a placed crafting_table within reach 4' }, description: 'Craft an item from what you hold, by real item name: the planks of the logs you hold (acacia_log makes acacia_planks; the name planks alone picks them for you), stick, crafting_table, wooden/stone/iron tools, shield, furnace, bucket, flint_and_steel. Recipes of 3x3 need table. Succeeds only when the inventory gained count of it within 10 s; otherwise it reports craft_unconfirmed.' },
  place: { args: { item: PLACEABLE.join('|'), dx: 'int', dy: 'int', dz: 'int', face: FACE_LIST }, description: 'Place a held block against the block at dx, dy, dz (from your feet block) on the given face, reach 4. Succeeds only when the new block shows up in the observation.' },
  use_on: { args: { item: Object.keys(USE_ON).join('|'), dx: 'int', dy: 'int', dz: 'int', face: FACE_LIST }, description: 'Use an item on the block at dx, dy, dz, for example flint_and_steel on obsidian. Succeeds only when its effect (a nether_portal, or water or lava) shows up in the observation.' },
  equip: { args: { item: 'item name in the hotbar' }, description: 'Select the hotbar slot holding the item. Succeeds only when the held item is seen to change. It lasts while a move runs; place and use_on select their own item.' },
  attack: { args: { mob_id: 'id of a hostile mob in hostiles' }, description: 'Face the mob, walk into reach (3 blocks) and swing a held sword or axe, paced by the 1.21 attack cooldown. Hostile mobs only. Ends when the mob is gone, after 15 s, or if your health falls below the fight rule min_health.' },
  flee: { args: { 'from_mob_id?': 'id of a mob in hostiles', 'away_from?': '{dx,dz} of the threat from you', blocks: 'int 1-32' }, description: 'Run directly away from a mob (from_mob_id) or from a direction (away_from: where the threat is, dx east and dz south of you; give exactly one of the two). Sprints, jumps when blocked. Ends after blocks blocks, 15 s, or 3 s with no progress.' },
});

const isInt = (v) => Number.isSafeInteger(v);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (args, names, optional = []) => {
  for (const k of Object.keys(args)) if (!names.includes(k) && !optional.includes(k)) throw new Error(`unknown_arg:${k}`);
  for (const k of names) if (!(k in args)) throw new Error(`missing_arg:${k}`);
};
const ownSpace = (dx, dy, dz) => dx === 0 && dz === 0 && (dy === 0 || dy === 1);
const farFromEye = (dx, dy, dz) => Math.hypot(dx, dy - 1.12, dz) > LIMITS.interactReach;

// Strict check of a { type: 'primitive', name, args } value. Returns a clean copy or throws.
export function validatePrimitive(value) {
  const allowed = ['type', 'name', 'args'];
  for (const k of Object.keys(value)) if (!allowed.includes(k)) throw new Error(`unknown_field:${k}`);
  if (typeof value.name !== 'string' || !Object.hasOwn(PRIMITIVE_SPECS, value.name)) {
    throw new Error(`unknown_primitive:${String(value.name).slice(0, 40)}. Valid names: ${Object.keys(PRIMITIVE_SPECS).join(', ')}`);
  }
  const args = value.args ?? {};
  if (!isPlain(args)) throw new Error('args_not_an_object');
  const out = (a) => ({ type: 'primitive', name: value.name, args: a });
  switch (value.name) {
    case 'walk': {
      only(args, ['dx', 'dz'], ['sprint']);
      if (!isInt(args.dx) || !isInt(args.dz)) throw new Error('walk_args_must_be_integers');
      if (args.dx === 0 && args.dz === 0) throw new Error('walk_target_is_here');
      if (Math.hypot(args.dx, args.dz) > LIMITS.walkRange) throw new Error('walk_target_too_far');
      if ('sprint' in args && typeof args.sprint !== 'boolean') throw new Error('walk_sprint_must_be_boolean');
      return out({ dx: args.dx, dz: args.dz, ...(args.sprint === true ? { sprint: true } : {}) });
    }
    case 'dig': {
      only(args, ['dx', 'dy', 'dz']);
      if (![args.dx, args.dy, args.dz].every(isInt)) throw new Error('dig_args_must_be_integers');
      if (ownSpace(args.dx, args.dy, args.dz)) throw new Error('dig_target_is_own_space');
      // Eye is 1.62 above the feet; the target block's centre is half a block in.
      if (Math.hypot(args.dx, args.dy - 1.12, args.dz) > LIMITS.digReach) throw new Error('dig_target_out_of_reach');
      return out({ dx: args.dx, dy: args.dy, dz: args.dz });
    }
    case 'jump':
      only(args, []);
      return out({});
    case 'craft': {
      only(args, ['name', 'count'], ['table']);
      if (typeof args.name !== 'string' || !ITEM.test(args.name) || !CRAFTABLE.has(args.name)) {
        throw new Error(`craft_name_not_craftable:${JSON.stringify(String(args.name).slice(0, 40))}. Valid names: ${CRAFT_NAMES.join(', ')}. Use the real name of the planks that match the logs you hold, such as acacia_planks for acacia_log; the name planks alone also works`);
      }
      if (!isInt(args.count) || args.count < 1 || args.count > LIMITS.craftMax) throw new Error('craft_count_out_of_range');
      if (!('table' in args)) return out({ name: args.name, count: args.count });
      const t = args.table;
      if (!isPlain(t)) throw new Error('craft_table_not_an_object');
      only(t, ['dx', 'dy', 'dz']);
      if (![t.dx, t.dy, t.dz].every(isInt)) throw new Error('craft_table_must_be_integers');
      if (farFromEye(t.dx, t.dy, t.dz)) throw new Error('craft_table_out_of_reach');
      return out({ name: args.name, count: args.count, table: { dx: t.dx, dy: t.dy, dz: t.dz } });
    }
    case 'place':
    case 'use_on': {
      only(args, ['item', 'dx', 'dy', 'dz', 'face']);
      const items = value.name === 'place' ? PLACEABLE : Object.keys(USE_ON);
      if (typeof args.item !== 'string' || !items.includes(args.item)) throw new Error(`${value.name}_item_not_allowed`);
      if (![args.dx, args.dy, args.dz].every(isInt)) throw new Error(`${value.name}_args_must_be_integers`);
      if (typeof args.face !== 'string' || !Object.hasOwn(FACES, args.face)) throw new Error(`${value.name}_face_unknown`);
      if (farFromEye(args.dx, args.dy, args.dz)) throw new Error(`${value.name}_target_out_of_reach`);
      if (value.name === 'place') {
        const f = FACES[args.face];
        if (ownSpace(args.dx + f.x, args.dy + f.y, args.dz + f.z)) throw new Error('place_target_is_own_space');
      }
      return out({ item: args.item, dx: args.dx, dy: args.dy, dz: args.dz, face: args.face });
    }
    case 'equip': {
      only(args, ['item']);
      if (typeof args.item !== 'string' || !ITEM.test(args.item)) throw new Error('equip_item_invalid');
      return out({ item: args.item });
    }
    case 'attack': {
      only(args, ['mob_id']);
      if (!isInt(args.mob_id) || args.mob_id < 0) throw new Error('attack_mob_id_must_be_a_non_negative_integer');
      return out({ mob_id: args.mob_id });
    }
    case 'flee': {
      only(args, ['blocks'], ['from_mob_id', 'away_from']);
      if (('from_mob_id' in args) === ('away_from' in args)) throw new Error('flee_needs_exactly_one_of_from_mob_id_or_away_from');
      if (!isInt(args.blocks) || args.blocks < 1 || args.blocks > LIMITS.fleeMax) throw new Error('flee_blocks_out_of_range_1_to_32');
      if ('from_mob_id' in args) {
        if (!isInt(args.from_mob_id) || args.from_mob_id < 0) throw new Error('flee_from_mob_id_must_be_a_non_negative_integer');
        return out({ from_mob_id: args.from_mob_id, blocks: args.blocks });
      }
      const a = args.away_from;
      if (!isPlain(a)) throw new Error('flee_away_from_not_an_object');
      only(a, ['dx', 'dz']);
      if (![a.dx, a.dz].every((v) => Number.isFinite(v) && Math.abs(v) <= 64)) throw new Error('flee_away_from_must_be_numbers_within_64');
      if (Math.hypot(a.dx, a.dz) < 0.1) throw new Error('flee_away_from_is_here');
      return out({ away_from: { dx: a.dx, dz: a.dz }, blocks: args.blocks });
    }
    default: {
      only(args, ['seconds']);
      if (typeof args.seconds !== 'number' || !Number.isFinite(args.seconds) || args.seconds <= 0 || args.seconds > LIMITS.waitMaxSeconds) {
        throw new Error('wait_seconds_out_of_range');
      }
      return out({ seconds: args.seconds });
    }
  }
}

// 1.21 attack speed (swings per second) of what is held. A swing before the cooldown is over does a fraction of the damage.
const TIER = { wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 };
const SPEED = { sword: () => 1.6, axe: (tier) => ({ wooden: 0.8, stone: 0.8, iron: 0.9 })[tier] ?? 1, pickaxe: () => 1.2, shovel: () => 1 };
const toolOf = (item) => { const m = /^(wooden|golden|stone|iron|diamond|netherite)_(sword|axe|pickaxe|shovel)$/.exec(String(item ?? '')); return m ? { tier: m[1], kind: m[2] } : null; };
export const isWeapon = (item) => ['sword', 'axe'].includes(toolOf(item)?.kind);
export const attackCooldownMs = (item) => { const t = toolOf(item); return Math.ceil(1000 / (t ? SPEED[t.kind](t.tier) : 4)) + 50; };
export function bestWeapon(inventory) {
  let best = null, score = -1;
  for (const [item, n] of Object.entries(inventory ?? {})) {
    const t = toolOf(item);
    if (!isWeapon(item) || !(n > 0)) continue;
    const s = TIER[t.tier] + (t.kind === 'sword' ? 0.5 : 0);
    if (s > score) { best = item; score = s; }
  }
  return best;
}
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const clamp = (v, m) => Math.max(-m, Math.min(m, v));
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const total = (inv) => Object.values(inv ?? {}).reduce((n, v) => n + (Number.isFinite(v) ? v : 0), 0);
const held = (o, item) => Number.isFinite(o?.inventory?.[item]) ? o.inventory[item] : 0;

// What the adapter's observation says about one absolute block, or { known: false }.
// Known: the block under the feet, anything inside the bot's own space, and the watched blocks in facts.
export function blockAt(o, target) {
  const p = o?.self?.position;
  if (!p) return { known: false };
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
  if (target.x === fx && target.z === fz && (target.y === fy || target.y === fy + 1)) return { known: true, name: 'air', source: 'space' };
  if (target.x === fx && target.z === fz && target.y === fy - 1) {
    const c = o.terrain?.support_grid?.[1]?.[1];
    if (c?.available) return { known: true, name: c.support ?? 'air', source: 'below' };
  }
  const fp = o.facts?.position;
  if (fp) for (const b of Object.values(o.facts.nearest_blocks ?? {})) {
    if (![b?.dx, b?.dy, b?.dz].every(Number.isFinite)) continue;
    if (Math.round(fp.x + b.dx) === target.x && Math.round(fp.y + b.dy) === target.y && Math.round(fp.z + b.dz) === target.z) {
      return { known: true, name: b.type ?? 'block', source: 'watched' };
    }
  }
  return { known: false };
}
const isAir = (name) => name === 'air' || name === 'cave_air' || name === 'void_air';

let craftSeq = 0;
const craftId = () => `p${Date.now().toString(36)}-${++craftSeq}`;
const fail = (reason, extra = {}) => ({ outcome: 'failure', reason, moved: false, dug: false, ...extra });

// Runs one primitive. Resolves { outcome, reason, moved, dug }; outcome is success, failure or timeout.
export function createPrimitiveRunner({ bot, now = () => performance.now(), sleep = (ms, signal) => delay(ms, undefined, { signal }),
  limits = {}, deadline = Infinity, minHealthFor = null } = {}) {
  const L = { ...LIMITS, ...limits };
  const pos = () => bot.observe()?.self?.position ?? null;
  const dist3 = (a, b) => a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0;
  const alive = (o) => !(o?.self?.health != null && o.self.health <= 0);
  const eyeDistance = (p, block, face = { x: 0, y: 0, z: 0 }) =>
    Math.hypot(block.x + 0.5 + face.x * 0.5 - p.x, block.y + 0.5 + face.y * 0.5 - p.y - 1.62, block.z + 0.5 + face.z * 0.5 - p.z);

  async function walk({ dx, dz, sprint }, signal) {
    const first = bot.observe(), start = first?.self?.position;
    if (!start) return { outcome: 'failure', reason: 'position_unavailable', moved: false, dug: false };
    const target = { x: Math.floor(start.x) + dx + 0.5, z: Math.floor(start.z) + dz + 0.5 };
    const began = now();
    let best = horizontal(start, target), bestAt = began, lastMoveAt = began, lastP = start, last = start;
    for (;;) {
      signal?.throwIfAborted();
      const o = bot.observe(), p = o?.self?.position, t = now();
      if (!p) return { outcome: 'failure', reason: 'position_unavailable', moved: dist3(start, last) >= 0.5, dug: false };
      last = p;
      const moved = dist3(start, p) >= 0.5, left = horizontal(p, target);
      if (!alive(o)) return { outcome: 'failure', reason: 'bot_death', moved, dug: false };
      if (left <= 0.6) return { outcome: 'success', reason: 'arrived', moved, dug: false };
      if (t - began >= Math.min(L.walkMs, deadline - began)) return { outcome: 'timeout', reason: 'time_limit', moved, dug: false };
      if (left < best - 0.25) { best = left; bestAt = t; }
      if (t - bestAt >= L.walkStallMs) return { outcome: 'failure', reason: 'no_progress', moved, dug: false };
      if (horizontal(p, lastP) > 0.1) { lastP = p; lastMoveAt = t; }
      const desired = Math.atan2(-(target.x - p.x), -(target.z - p.z));
      const steering = wrap(desired - (o.self.yaw ?? 0));
      const ahead = o.terrain?.clearance?.forward;
      const blocked = ahead?.body_clear === false && ahead?.head_clear !== false;
      const forward = Math.abs(steering) < 0.32;
      // Walking is the default. Sprint is on only when the model asked for it and the bot is heading for the target.
      bot.requestAction({ forward, sprint: sprint === true && forward, jump: blocked || t - lastMoveAt > 700,
        yaw_delta: clamp(steering * 0.65, 0.18), pitch_delta: clamp(-(o.self.pitch ?? 0) * 0.65, 0.14) });
      await sleep(L.tickMs, signal);
    }
  }

  async function dig({ dx, dy, dz }, signal) {
    const first = bot.observe(), start = first?.self?.position;
    if (!start) return { outcome: 'failure', reason: 'position_unavailable', moved: false, dug: false };
    const target = { x: Math.floor(start.x) + dx, y: Math.floor(start.y) + dy, z: Math.floor(start.z) + dz };
    const seen = blockAt(first, target);
    if (seen.known && isAir(seen.name)) return { outcome: 'failure', reason: 'no_block_there', moved: false, dug: false };
    const items = total(first.inventory), began = now();
    let goneSince = null, last = start;
    for (;;) {
      signal?.throwIfAborted();
      const o = bot.observe(), p = o?.self?.position, t = now();
      if (!p) return { outcome: 'failure', reason: 'position_unavailable', moved: dist3(start, last) >= 0.5, dug: false };
      last = p;
      const moved = dist3(start, p) >= 0.5;
      if (!alive(o)) return { outcome: 'failure', reason: 'bot_death', moved, dug: false };
      const now_ = blockAt(o, target);
      const gone = !seen.known ? total(o.inventory) > items
        : now_.known ? isAir(now_.name) : seen.source === 'watched' && Boolean(o.facts?.position);
      if (gone) { goneSince ??= t; if (!seen.known || t - goneSince >= 150) return { outcome: 'success', reason: seen.known ? 'block_gone' : 'inventory_increased', moved, dug: true }; }
      else goneSince = null;
      if (t - began >= Math.min(L.digMs, deadline - began)) {
        return { outcome: 'timeout', reason: seen.known ? 'time_limit' : 'time_limit_block_not_observable', moved, dug: false };
      }
      const eye = { x: p.x, y: p.y + 1.62, z: p.z };
      const aim = aimDelta(angularError(eye, o.self.yaw ?? 0, o.self.pitch ?? 0, { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }));
      bot.requestAction({ dig: target, yaw_delta: aim.yaw, pitch_delta: aim.pitch });
      await sleep(L.tickMs, signal);
    }
  }

  async function jump(_args, signal) {
    const start = pos();
    let airborne = false, last = start;
    bot.requestAction({ jump: true });
    for (let waited = 0; waited < 800; waited += L.tickMs) {
      signal?.throwIfAborted();
      await sleep(L.tickMs, signal);
      const o = bot.observe(), p = o?.self?.position;
      if (p) last = p;
      if (o?.self?.on_ground === false || (start && p && p.y - start.y >= 0.2)) { airborne = true; break; }
    }
    const moved = dist3(start, last) >= 0.2;
    return airborne ? { outcome: 'success', reason: 'jumped', moved, dug: false }
      : { outcome: 'failure', reason: 'no_effect', moved, dug: false };
  }

  async function wait({ seconds }, signal) {
    const end = now() + Math.min(seconds * 1000, Math.max(0, deadline - now()));
    while (now() < end) { signal?.throwIfAborted(); await sleep(Math.min(L.tickMs, Math.max(1, end - now())), signal); }
    return { outcome: 'success', reason: 'waited', moved: false, dug: false };
  }

  async function craft({ name: asked, count, table }, signal) {
    const first = bot.observe(), start = first?.self?.position;
    if (!start) return fail('position_unavailable');
    const hold = planksForHeld(first.inventory);
    const name = resolveCraftName(asked, first.inventory);
    if (asked === 'planks' && !name) return fail('no_logs_held:planks_need_a_log', { detail: { name: asked } });
    if (PLANKS.includes(name) && !Object.values(hold).includes(name)) {
      return fail(`no_matching_logs:holding_${Object.keys(hold).join('+') || 'no_logs'}:craft_${Object.values(hold)[0] ?? 'planks_after_collecting_a_log'}`, { detail: { name, holding: hold } });
    }
    const before = held(first, name);
    let tableAt = null;
    if (table) {
      tableAt = { x: Math.floor(start.x) + table.dx, y: Math.floor(start.y) + table.dy, z: Math.floor(start.z) + table.dz };
      const seen = blockAt(first, tableAt);
      if (seen.known && seen.name !== 'crafting_table') return fail('no_table_there');
      if (eyeDistance(start, tableAt) > 4.5) return fail('table_out_of_reach');
    }
    const began = now();
    bot.requestAction({ craft: { id: craftId(), name, count, ...(tableAt ? { table: tableAt } : {}) } });
    let gained = 0;
    for (;;) {
      signal?.throwIfAborted();
      await sleep(L.tickMs, signal);
      const o = bot.observe();
      if (!alive(o)) return fail('bot_death', { detail: { gained } });
      gained = held(o, name) - before;
      if (gained >= count) return { outcome: 'success', reason: 'crafted', moved: false, dug: false, detail: { name, gained } };
      if (now() - began >= Math.min(L.craftMs, deadline - began)) {
        return fail('craft_unconfirmed', { detail: { name, wanted: count, gained: Math.max(0, gained) } });
      }
    }
  }

  // place and use_on share one path: select the item, click the block once, then watch the observation.
  async function interact(kind, { item, dx, dy, dz, face }, signal) {
    const first = bot.observe(), start = first?.self?.position;
    if (!start) return fail('position_unavailable');
    if (held(first, item) < 1) return fail('item_not_in_inventory');
    const base = { x: Math.floor(start.x) + dx, y: Math.floor(start.y) + dy, z: Math.floor(start.z) + dz };
    const f = FACES[face], next = { x: base.x + f.x, y: base.y + f.y, z: base.z + f.z };
    const spec = kind === 'place' ? { appears: item, where: 'adjacent' } : USE_ON[item];
    const clicked = blockAt(first, base);
    if (clicked.known && isAir(clicked.name)) return fail('no_block_there');
    if (eyeDistance(start, base, f) > 4.5) return fail('target_out_of_reach');
    const before = blockAt(first, next);
    if (kind === 'place' && before.known && !isAir(before.name)) return fail('target_space_occupied');
    const seenBefore = Boolean(first.facts?.nearest_blocks?.[spec.appears]);
    const appeared = (o) => {
      if (spec.where === 'adjacent') { const b = blockAt(o, next); return b.known && b.name === spec.appears && !(before.known && before.name === spec.appears); }
      return !seenBefore && Boolean(o.facts?.nearest_blocks?.[spec.appears]);
    };
    const began = now();
    let clickedAt = -Infinity;
    for (;;) {
      signal?.throwIfAborted();
      const o = bot.observe(), t = now();
      if (!alive(o)) return fail('bot_death');
      if (appeared(o)) return { outcome: 'success', reason: kind === 'place' ? 'block_placed' : 'effect_seen', moved: false, dug: false, detail: { item, appeared: spec.appears } };
      if (t - began >= Math.min(L.interactMs, deadline - began)) return fail(`${kind}_unconfirmed`, { detail: { item, expected: spec.appears } });
      // One click at a time: the second only after a pause, so a tool is not used over and over.
      const click = t - clickedAt >= 1000;
      if (click) clickedAt = t;
      bot.requestAction({ equip: item, ...(click ? { interact: { ...base, face: { ...f } } } : {}) });
      await sleep(click ? Math.max(L.tickMs, 120) : L.tickMs, signal);
    }
  }

  async function equip({ item }, signal) {
    const first = bot.observe();
    if (!first?.self?.position) return fail('position_unavailable');
    if (held(first, item) < 1) return fail('item_not_in_inventory');
    if (first.self.held_item === item) return { outcome: 'success', reason: 'already_held', moved: false, dug: false };
    const began = now();
    for (;;) {
      signal?.throwIfAborted();
      bot.requestAction({ equip: item });
      await sleep(L.tickMs, signal);
      const o = bot.observe();
      if (!alive(o)) return fail('bot_death');
      if (o?.self?.held_item === item) return { outcome: 'success', reason: 'held', moved: false, dug: false };
      if (now() - began >= Math.min(L.equipMs, deadline - began)) return fail('equip_unconfirmed');
    }
  }

  const blockedAhead = (o) => { const a = o.terrain?.clearance?.forward; return a?.body_clear === false && a?.head_clear !== false; };
  const mobOf = (o, id) => (o?.facts?.nearby_mobs ?? []).find((m) => m?.id === id) ?? null;

  async function attack({ mob_id }, signal) {
    const first = bot.observe(), start = first?.self?.position;
    if (!start) return fail('position_unavailable');
    const seen = mobOf(first, mob_id);
    if (!seen) return fail('mob_not_found');
    if (seen.hostile === false) return fail('mob_not_hostile');
    const began = now();
    let lastSwing = -Infinity, swings = 0, lastMoveAt = began, lastP = start;
    const result = (outcome, reason, moved) => ({ outcome, reason, moved, dug: false, detail: { mob_id, mob: seen.type, swings } });
    for (;;) {
      signal?.throwIfAborted();
      const o = bot.observe(), p = o?.self?.position, t = now();
      if (!p) return fail('position_unavailable', { detail: { mob_id, swings } });
      const moved = dist3(start, p) >= 0.5;
      if (!alive(o)) return result('failure', 'bot_death', moved);
      const min = minHealthFor?.(seen.type);
      if (min != null && Number.isFinite(o.self.health) && o.self.health < min) return result('failure', 'health_below_min_health', moved);
      const m = mobOf(o, mob_id);
      if (!m) return result('success', 'mob_gone', moved);
      if (t - began >= Math.min(L.attackMs, deadline - began)) return result('timeout', 'time_limit', moved);
      const eye = { x: p.x, y: p.y + 1.62, z: p.z };
      const point = { x: p.x + m.dx, y: p.y + m.dy + 0.9, z: p.z + m.dz };
      const err = angularError(eye, o.self.yaw ?? 0, o.self.pitch ?? 0, point), aim = aimDelta(err);
      const flat = Math.hypot(m.dx, m.dz), reach = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
      if (horizontal(p, lastP) > 0.1) { lastP = p; lastMoveAt = t; }
      const weapon = bestWeapon(o.inventory), wielded = o.self.held_item;
      const swing = reach <= L.attackReach && t - lastSwing >= attackCooldownMs(isWeapon(wielded) ? wielded : null);
      if (swing) { lastSwing = t; swings++; }
      bot.requestAction({ forward: flat > 2 && Math.abs(err.yaw) < 1.2, sprint: flat > 4 && Math.abs(err.yaw) < 1.2, jump: blockedAhead(o) || (flat > 2 && t - lastMoveAt > 700),
        yaw_delta: aim.yaw, pitch_delta: aim.pitch, ...(weapon && wielded !== weapon ? { equip: weapon } : {}),
        ...(swing ? { attack_entity: mob_id } : {}) });
      await sleep(L.tickMs, signal);
    }
  }

  async function flee(args, signal) {
    const first = bot.observe(), start = first?.self?.position;
    if (!start) return fail('position_unavailable');
    const unit = (x, z) => { const n = Math.hypot(x, z); return n < 0.1 ? null : { x: x / n, z: z / n }; };
    let dir;
    if ('from_mob_id' in args) {
      const m = mobOf(first, args.from_mob_id);
      if (!m) return fail('mob_not_found');
      dir = unit(-m.dx, -m.dz);
    } else dir = unit(-args.away_from.dx, -args.away_from.dz);
    // A threat right on top of us has no direction: run the way we face away from.
    dir ??= { x: Math.sin(first.self.yaw ?? 0), z: Math.cos(first.self.yaw ?? 0) };
    const began = now();
    let best = 0, bestAt = began, lastMoveAt = began, lastP = start, last = start;
    for (;;) {
      signal?.throwIfAborted();
      const o = bot.observe(), p = o?.self?.position, t = now();
      if (!p) return { outcome: 'failure', reason: 'position_unavailable', moved: dist3(start, last) >= 0.5, dug: false };
      last = p;
      const moved = dist3(start, p) >= 0.5, gone = horizontal(p, start);
      if (!alive(o)) return { outcome: 'failure', reason: 'bot_death', moved, dug: false };
      if (gone >= args.blocks) return { outcome: 'success', reason: 'fled', moved, dug: false, detail: { blocks: Math.round(gone * 10) / 10 } };
      if (t - began >= Math.min(L.fleeMs, deadline - began)) return { outcome: 'timeout', reason: 'time_limit', moved, dug: false };
      if (gone > best + 0.25) { best = gone; bestAt = t; }
      if (t - bestAt >= L.fleeStallMs) return { outcome: 'failure', reason: 'no_progress', moved, dug: false };
      if (horizontal(p, lastP) > 0.1) { lastP = p; lastMoveAt = t; }
      if ('from_mob_id' in args) { const m = mobOf(o, args.from_mob_id); if (m) dir = unit(-m.dx, -m.dz) ?? dir; }
      const steering = wrap(Math.atan2(-dir.x, -dir.z) - (o.self.yaw ?? 0));
      bot.requestAction({ forward: Math.abs(steering) < 0.9, sprint: true, jump: blockedAhead(o) || t - lastMoveAt > 500,
        yaw_delta: clamp(steering * 0.65, 0.4), pitch_delta: clamp(-(o.self.pitch ?? 0) * 0.65, 0.14) });
      await sleep(L.tickMs, signal);
    }
  }

  const handlers = { attack, flee, walk, dig, jump, wait, craft, place: (a, s) => interact('place', a, s), use_on: (a, s) => interact('use_on', a, s), equip };
  return async function run(decision, { signal } = {}) {
    try {
      signal?.throwIfAborted();
      if (decision.name !== 'wait') bot.releaseControls();
      return await handlers[decision.name](decision.args ?? {}, signal);
    } finally { bot.releaseControls(); }
  };
}
