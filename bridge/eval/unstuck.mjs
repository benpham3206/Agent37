import { setTimeout as delay } from 'node:timers/promises';

const validPosition = (p) => p && ['x', 'y', 'z'].every((k) => Number.isFinite(p[k]));
const copyPosition = ({ x, y, z }) => ({ x, y, z });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function createStuckDetector({ stuckAfterMs = 25000, minMoveBlocks = 1.5,
  wanderWindowMs = 60000, wanderMinNetBlocks = 4 } = {}) {
  let anchor = null, window = null, inventory, dim;
  function reset() { anchor = window = null; }
  function start(sample) {
    anchor = window = { position: copyPosition(sample.position), at: sample.now };
    inventory = sample.inventoryKey;
    dim = sample.dimension;
  }
  return {
    reset,
    update(sample) {
      const { now, position, dimension, inventoryKey, hazard } = sample;
      if (!validPosition(position)) return null;
      if (!anchor || inventoryKey !== inventory || dimension !== dim) start(sample);
      if (hazard) return { reason: `hazard:${hazard}` };
      if (distance(position, anchor.position) > minMoveBlocks) {
        anchor = { position: copyPosition(position), at: now };
      }
      if (now - anchor.at >= stuckAfterMs) return { reason: 'no_movement' };
      if (now - window.at >= wanderWindowMs) {
        if (distance(position, window.position) < wanderMinNetBlocks) return { reason: 'wandering' };
        window = { position: copyPosition(position), at: now };
      }
      return null;
    },
  };
}

const badFloor = new Set(['magma_block', 'cactus', 'campfire', 'soul_campfire',
  'sweet_berry_bush', 'wither_rose', 'powder_snow', 'pointed_dripstone',
  'water', 'lava', 'fire', 'soul_fire']);
const badSpace = new Set(['water', 'lava', 'fire', 'soul_fire', 'nether_portal', 'end_portal', 'cobweb', 'powder_snow']);
const hot = new Set(['lava', 'fire', 'soul_fire']);
const directions = [[-1, 0], [0, -1], [0, 1], [1, 0]];
const key = (x, y, z) => `${x},${y},${z}`;
const readBlock = (blockAt, x, y, z) => { try { return blockAt(x, y, z) ?? null; } catch { return null; } };

export function findSafeSpot({ blockAt, origin, minDistance = 3, maxRadius = 16, minReachable = 40 }) {
  if (!validPosition(origin)) return null;
  if (!Number.isInteger(maxRadius) || maxRadius < 1 || maxRadius > 32 ||
      !Number.isFinite(minDistance) || minDistance < 0 ||
      !Number.isInteger(minReachable) || minReachable < 0) throw new Error('invalid_search_limits');
  const center = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
  const blocks = new Map(), standing = new Map();
  const inside = (x, y, z) => Math.abs(x - center.x) <= maxRadius &&
    Math.abs(y - center.y) <= maxRadius && Math.abs(z - center.z) <= maxRadius;
  function block(x, y, z) {
    const id = key(x, y, z);
    if (!blocks.has(id)) blocks.set(id, readBlock(blockAt, x, y, z));
    return blocks.get(id);
  }
  function empty(x, y, z) {
    const b = block(x, y, z);
    return b?.boundingBox === 'empty' && !badSpace.has(b.name);
  }
  function safe(x, y, z) {
    if (!inside(x, y, z)) return false;
    const id = key(x, y, z);
    if (standing.has(id)) return standing.get(id);
    const floor = block(x, y - 1, z);
    let ok = floor?.boundingBox === 'block' && !badFloor.has(floor.name) &&
      !/(?:^|_)(?:leaves|log|logs|stem|hyphae|wood)$/.test(floor.name) &&
      empty(x, y, z) && empty(x, y + 1, z);
    if (ok) {
      for (let dx = -1; dx <= 1 && ok; dx++) for (let dy = -1; dy <= 1 && ok; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const b = block(x + dx, y + dy, z + dz);
          if (!b || hot.has(b.name)) { ok = false; break; }
        }
      }
    }
    standing.set(id, Boolean(ok));
    return Boolean(ok);
  }
  function reachable(start) {
    const queue = [start], seen = new Set([key(start.x, start.y, start.z)]);
    for (let i = 0; i < queue.length && seen.size - 1 < minReachable; i++) {
      const p = queue[i];
      for (const [dx, dz] of directions) {
        for (const dy of [0, 1, -1, -2, -3]) {
          const x = p.x + dx, y = p.y + dy, z = p.z + dz;
          if (!safe(x, y, z)) continue;
          // A jump needs room over the source; a drop needs a clear entry shaft.
          if (dy === 1 && !empty(p.x, p.y + 2, p.z)) continue;
          let clear = true;
          for (let h = y + 2; h <= p.y + 1; h++) if (!empty(x, h, z)) { clear = false; break; }
          if (!clear) continue;
          const id = key(x, y, z);
          if (!seen.has(id)) { seen.add(id); queue.push({ x, y, z }); }
        }
      }
    }
    return seen.size - 1;
  }
  // Feet level plus four empty blocks below means a drop deeper than the three-block reach.
  function deepDrop(x, y, z) {
    for (const [dx, dz] of directions) {
      let drop = true;
      for (let dy = 0; dy <= 4; dy++) {
        const b = block(x + dx, y - dy, z + dz);
        if (!b) return true;
        if (b.boundingBox !== 'empty') { drop = false; break; }
      }
      if (drop) return true;
    }
    return false;
  }
  const candidates = [];
  for (let x = center.x - maxRadius; x <= center.x + maxRadius; x++) {
    for (let y = center.y - maxRadius; y <= center.y + maxRadius; y++) {
      for (let z = center.z - maxRadius; z <= center.z + maxRadius; z++) {
        const cell = { x, y, z }, d = distance(cell, origin);
        const horizontal = Math.hypot(cell.x - origin.x, cell.z - origin.z);
        if (horizontal >= minDistance && d <= maxRadius) candidates.push({ ...cell, distance: d });
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.x - b.x || a.y - b.y || a.z - b.z);
  for (const p of candidates) {
    if (!safe(p.x, p.y, p.z) || deepDrop(p.x, p.y, p.z)) continue;
    const count = reachable(p);
    if (count >= minReachable) return { ...p, reachable: count };
  }
  return null;
}

function createHazardCheck(blockAt) {
  let underwaterAt = null, dimension;
  return {
    reset() { underwaterAt = null; dimension = undefined; },
    update(position, dim, now) {
      if (dim !== dimension) { underwaterAt = null; dimension = dim; }
      if (!validPosition(position)) { underwaterAt = null; return null; }
      const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
      const feet = readBlock(blockAt, x, y, z), head = readBlock(blockAt, x, y + 1, z);
      for (const b of [feet, head]) if (hot.has(b?.name)) return b.name;
      if (head?.name !== 'water') { underwaterAt = null; return null; }
      underwaterAt ??= now;
      return now - underwaterAt >= 8000 ? 'water' : null;
    },
  };
}

export function createUnstuckWatchdog({ observe, blockAt, runCommand, username,
  isAllowedPosition, log = console.log, now = () => performance.now(), sleep = delay, limits = {} }) {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) throw new Error('invalid_bot_username');
  if ([observe, blockAt, runCommand, isAllowedPosition, log, now, sleep].some((f) => typeof f !== 'function')) {
    throw new Error('missing_watchdog_dependency');
  }
  const { perStep = 2, perRun = 5 } = limits;
  if (![perStep, perRun].every((n) => Number.isInteger(n) && n >= 0)) throw new Error('invalid_reset_limits');
  const detector = createStuckDetector(limits), hazards = createHazardCheck(blockAt);
  const history = [], steps = new Map(), started = now();
  let active = null, generation = 0, inFlight = null, total = 0, cooldownUntil = 0, runLimitRecorded = false;
  function record(step, reason, from, to = null, extra = {}) {
    const event = Object.freeze({ step: step.id, at_ms: now() - started, reason,
      from: from ? Object.freeze(copyPosition(from)) : null,
      to: to ? Object.freeze(copyPosition(to)) : null,
      distance: to && from ? distance(from, to) : null,
      attempt: step.attempts + 1, rcon_reply: null, confirmed: false, ...extra });
    history.push(event);
    return event;
  }
  function limited(step, from) {
    const run = total >= perRun, local = step.attempts >= perStep;
    if (!run && !local) return false;
    if (run ? !runLimitRecorded : !step.limitRecorded) {
      record(step, 'reset_limit', from, null, { attempt: step.attempts });
      if (run) runLimitRecorded = true;
      step.limitRecorded = true;
    }
    return true;
  }
  async function check() {
    const step = active;
    const armedGeneration = generation;
    if (!step) return;
    const observation = await observe();
    if (active !== step || generation !== armedGeneration) return;
    const from = validPosition(observation?.self?.position) ? copyPosition(observation.self.position) : null;
    if (limited(step, from) || now() < cooldownUntil) return;
    const dim = observation?.dimension ?? observation?.terrain?.dimension;
    const inventoryKey = JSON.stringify(Object.entries(observation?.inventory ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    const t = now();
    const fired = detector.update({ now: t, position: from, dimension: dim, inventoryKey,
      hazard: hazards.update(from, dim, t) });
    if (!fired) return;
    const spot = findSafeSpot({ blockAt, origin: from, minDistance: [3, 6, 12][Math.min(step.attempts, 2)],
      maxRadius: limits.maxRadius ?? 16, minReachable: limits.minReachable ?? 40 });
    const target = spot ? { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 } : null;
    if (!target || !isAllowedPosition(target) || !isAllowedPosition(from)) {
      record(step, target ? 'outside_region' : 'no_safe_spot', from, target);
      detector.reset(now()); cooldownUntil = now() + 10000;
      return;
    }
    step.attempts++; total++;
    const at = now() - started;
    let reply = null, confirmed = false;
    try {
      reply = await runCommand(`tp ${username} ${target.x} ${target.y} ${target.z}`);
      const deadline = now() + 3000;
      for (let poll = 0; poll <= 60 && active === step && generation === armedGeneration; poll++) {
        const after = await observe();
        const p = after?.self?.position;
        if ((after?.dimension ?? after?.terrain?.dimension) === dim && validPosition(p) && distance(p, target) <= 1.5) {
          confirmed = true; break;
        }
        if (now() >= deadline) break;
        await sleep(Math.min(50, deadline - now()));
      }
    } catch {
      reply = 'rcon_or_observation_error';
    }
    record(step, fired.reason, from, target, { at_ms: at, attempt: step.attempts, rcon_reply: reply ?? null, confirmed });
    log(`UNSTUCK step=${step.id} reason=${fired.reason} from=${from.x},${from.y},${from.z} to=${target.x},${target.y},${target.z} confirmed=${confirmed}`);
    if (active === step && generation === armedGeneration) { detector.reset(now()); hazards.reset(); }
    cooldownUntil = now() + 10000;
    limited(step, target);
  }
  return Object.freeze({
    arm(stepId) {
      if (typeof stepId !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(stepId)) throw new Error('invalid_step_id');
      if (!steps.has(stepId)) steps.set(stepId, { id: stepId, attempts: 0, limitRecorded: false });
      active = steps.get(stepId);
      generation++;
      detector.reset(now()); hazards.reset();
    },
    disarm() { active = null; generation++; detector.reset(now()); hazards.reset(); },
    tick() {
      if (!inFlight) inFlight = check().finally(() => { inFlight = null; });
      return inFlight;
    },
    get events() { return Object.freeze([...history]); },
  });
}
