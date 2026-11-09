import { setTimeout as delay } from 'node:timers/promises';

const validPosition = (p) => p && ['x', 'y', 'z'].every((k) => Number.isFinite(p[k]));
const copyPosition = ({ x, y, z }) => ({ x, y, z });
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const RANGED = new Set(['skeleton', 'stray', 'bogged', 'witch', 'pillager', 'blaze']);
const NEUTRAL_ONLY = new Set(['enderman', 'piglin', 'zombified_piglin']);

function distanceReason(mob, distance) {
  if (mob.type === 'creeper') return distance <= 7 ? 'creeper' : null;
  if (RANGED.has(mob.type)) return distance <= 12 ? 'ranged' : null;
  if (NEUTRAL_ONLY.has(mob.type)) return null;
  return distance <= 5 ? 'close_hostile' : null;
}

function selectThreat(mobs, hitReceived) {
  const candidates = [];
  mobs.forEach((mob, index) => {
    if (!mob || mob.hostile !== true) return;
    if (!Number.isFinite(mob.distance) || mob.distance < 0) return;
    candidates.push({ mob, index, distance: mob.distance });
  });
  candidates.sort((a, b) => a.distance - b.distance || a.index - b.index);
  const nearestWithin16 = candidates.length && candidates[0].distance <= 16 ? candidates[0] : null;
  for (const c of candidates) {
    const reason = distanceReason(c.mob, c.distance) ??
      (hitReceived && c === nearestWithin16 ? 'hit_received' : null);
    if (reason) return { mob: c.mob, reason, distance: c.distance };
  }
  return null;
}

function mobPosition(self, mob) {
  if (validPosition(mob.position)) return copyPosition(mob.position);
  if (validPosition(self) && [mob.dx, mob.dy, mob.dz].every(Number.isFinite)) {
    return { x: self.x + mob.dx, y: self.y + mob.dy, z: self.z + mob.dz };
  }
  return null;
}

export function createMobWatchdog({ observe, resolveUuid, runCommand, username,
  isAllowedPosition, log = console.log, now = () => performance.now(), sleep = delay, limits = {} }) {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) throw new Error('invalid_bot_username');
  if ([observe, resolveUuid, runCommand, isAllowedPosition, log, now, sleep].some((f) => typeof f !== 'function')) {
    throw new Error('missing_watchdog_dependency');
  }
  const { perStep = 4, perRun = 10 } = limits;
  if (![perStep, perRun].every((n) => Number.isInteger(n) && n >= 0)) throw new Error('invalid_kill_limits');
  const history = [], steps = new Map(), refusals = new Map(), started = now();
  let active = null, lastStepId = null, generation = 0, inFlight = null;
  let total = 0, cooldownUntil = 0, runLimitRecorded = false, disarmRecorded = false;
  function record(stepId, fields) {
    const event = Object.freeze({ step: stepId, at_ms: now() - started, reason: null,
      mob_type: null, mob_id: null, uuid: null, distance: null, health: null,
      rcon_reply: null, confirmed: false, ...fields });
    history.push(event);
    return event;
  }
  function threatFields(mob, distance, health) {
    return { mob_type: mob.type ?? null, mob_id: mob.id ?? null, distance, health };
  }
  function refuse(step, threat, reason, at, health) {
    const key = `${threat.mob.type ?? '?'}:${threat.mob.id ?? threat.distance}`;
    const last = refusals.get(key) ?? -Infinity;
    if (at - last < 2000) return;
    refusals.set(key, at);
    record(step.id, { at_ms: at - started, reason, ...threatFields(threat.mob, threat.distance, health) });
  }
  function limited(step, threat, health) {
    const run = total >= perRun, local = step.attempts >= perStep;
    if (!run && !local) return false;
    if (run ? !runLimitRecorded : !step.limitRecorded) {
      record(step.id, { at_ms: now() - started, reason: 'mob_limit',
        ...threatFields(threat.mob, threat.distance, health) });
      if (run) runLimitRecorded = true;
      step.limitRecorded = true;
    }
    return true;
  }
  async function confirm(step, armedGeneration, mobId, issuedAt) {
    const deadline = issuedAt + 2000;
    for (let poll = 0; poll <= 40; poll++) {
      if (active !== step || generation !== armedGeneration) return false;
      const after = await observe();
      const mobs = after?.facts?.nearby_mobs;
      if (Array.isArray(mobs) && !mobs.some((m) => m && m.id === mobId)) return true;
      if (now() >= deadline) return false;
      await sleep(Math.min(50, deadline - now()));
    }
    return false;
  }
  async function check() {
    const step = active, armedGeneration = generation;
    if (!step) {
      if (!disarmRecorded) {
        disarmRecorded = true;
        record(lastStepId, { reason: 'disarmed' });
      }
      return;
    }
    if (now() < cooldownUntil) return;
    const observation = await observe();
    if (active !== step || generation !== armedGeneration) return;
    const mobs = observation?.facts?.nearby_mobs;
    if (!Array.isArray(mobs)) return;
    const self = observation?.self;
    const threat = selectThreat(mobs, self?.incoming_attack?.hit_received === true);
    if (!threat) return;
    const health = self?.health ?? observation?.facts?.health ?? null;
    const at = now();
    if (limited(step, threat, health)) return;
    const resolved = await resolveUuid(threat.mob);
    if (active !== step || generation !== armedGeneration) return;
    if (resolved == null || resolved === '') {
      refuse(step, threat, 'no_uuid', at, health);
      return;
    }
    if (typeof resolved !== 'string' || !UUID_RE.test(resolved)) {
      refuse(step, threat, 'invalid_uuid', at, health);
      return;
    }
    const selfPos = validPosition(self?.position) ? copyPosition(self.position) : null;
    const target = mobPosition(selfPos, threat.mob);
    if (!selfPos || !target || !isAllowedPosition(selfPos) || !isAllowedPosition(target)) {
      refuse(step, threat, 'outside_region', at, health);
      return;
    }
    step.attempts++; total++;
    const issuedAt = now();
    let reply = null, confirmed = false;
    try {
      reply = await runCommand(`kill ${resolved}`);
      confirmed = await confirm(step, armedGeneration, threat.mob.id ?? null, issuedAt);
    } catch {
      reply = 'rcon_or_observation_error';
    }
    cooldownUntil = issuedAt + 2000;
    record(step.id, { at_ms: issuedAt - started, reason: threat.reason,
      ...threatFields(threat.mob, threat.distance, health),
      uuid: resolved, rcon_reply: reply ?? null, confirmed });
    log(`MOBWATCH step=${step.id} mob=${threat.mob.type} distance=${threat.distance} reason=${threat.reason} confirmed=${confirmed}`);
  }
  return Object.freeze({
    arm(stepId) {
      if (typeof stepId !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(stepId)) throw new Error('invalid_step_id');
      if (!steps.has(stepId)) steps.set(stepId, { id: stepId, attempts: 0, limitRecorded: false });
      active = steps.get(stepId);
      lastStepId = stepId;
      generation++;
      disarmRecorded = false;
    },
    disarm() { active = null; generation++; },
    tick() {
      if (!inFlight) inFlight = check().finally(() => { inFlight = null; });
      return inFlight;
    },
    get events() { return Object.freeze([...history]); },
  });
}
