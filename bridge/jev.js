// Jev perception: a fast, optional observation layer for the planner. It reports; it never chooses.
// Jev (TypeSafe's System One model) answers typed questions about a state.
// API: POST https://api.typesafe.ai/v1/systemone, Bearer key, {model,state,questions}
// -> {model, answers:{id:{type,...}}, usage}. Docs: https://docs.typesafe.ai
// Off unless AGENT37_JEV=1 and JEV_API_KEY are set. Never blocks the 50 ms tick:
// the loop runs on its own timer, one request in flight, and any failure keeps
// the planner on facts alone.
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const SITUATIONS = Object.freeze(['on_flat_ground', 'on_tree', 'on_steep_ground', 'in_water', 'in_cave', 'boxed_in', 'other']);

// What the bot just heard that is a threat. An observation only; the planner model decides what to do about it.
export const HEARD_THREATS = Object.freeze(['none', 'creeper_fuse', 'explosion', 'hostile_nearby', 'other']);

export function jevEnabled(env = process.env) {
  return env.AGENT37_JEV === '1' && Boolean(env.JEV_API_KEY);
}

// Small state: Jev bills per input token, so send only what the questions need.
// Jev only observes. It is never told a goal; deciding what to do is the planner model's job.
export function jevState(facts = {}) {
  const near = {};
  for (const [name, b] of Object.entries(facts.nearest_blocks ?? {})) near[name] = { distance: b.distance, dx: b.dx, dy: b.dy, dz: b.dz };
  return {
    dimension: facts.dimension ?? null, y: facts.position?.y ?? null, health: facts.health ?? null, is_day: facts.is_day ?? null,
    inventory: facts.inventory ?? {}, nearest_blocks: near,
    surroundings: facts.surroundings ?? null,
    sounds: (facts.sounds ?? []).slice(0, 8).map((x) => ({ name: x.name, source: x.source ?? null, direction: x.direction, distance: x.distance, age_ms: x.age_ms })),
    nearby_mobs: (facts.nearby_mobs ?? []).slice(0, 8).map((m) => ({ type: m.type, hostile: m.hostile, distance: m.distance, dx: m.dx, dy: m.dy, dz: m.dz })),
  };
}

export const QUESTIONS = Object.freeze({
  situation: { type: 'choice', instructions: 'Using `surroundings` (`standing_on`, and per compass side the block `below`, whether it is `open_below`, and the `body` and `head` blocks), `nearest_blocks` and `y`, which describes where the bot is standing right now? Describe only; do not say what to do.', criteria: {
    on_flat_ground: 'Standing on solid ground that is not leaves or a log, and every side has solid support below it',
    on_tree: 'Standing on a leaves or log block, or the solid support below is leaves or logs on most sides',
    on_steep_ground: 'Standing on solid ground but at least one side is open_below (an edge or drop) or has a block in the way at body height',
    in_water: 'The block it stands on or the body blocks around it are water',
    in_cave: 'Stone, deepslate or dirt at body and head height on two or more sides, and y is below 55',
    boxed_in: 'Every side has a solid block at body or head height, so it cannot walk in any direction',
    other: 'None of the above fit' } },
  heard_threat: { type: 'choice', instructions: 'Using `sounds` (what the bot heard in the last 3 seconds; `name` is the Minecraft sound, `source` the mob standing where it played, `distance` in blocks), which threat did it just hear? Describe only; do not say what to do.', criteria: {
    none: 'No sound in the list is a threat',
    creeper_fuse: 'A sound named entity.creeper.primed: a creeper has lit its fuse close by',
    explosion: 'A sound named entity.generic.explode or entity.creeper.explode, or any explosion',
    hostile_nearby: 'A hostile mob made a sound (a groan, hiss, rattle, shoot or hurt sound) within about 12 blocks',
    other: 'A threatening sound that is none of the above, such as lava popping or a fall' } },
  danger: { type: 'noul', instructions: 'Using `nearby_mobs` and `sounds` (things heard, maybe out of sight), is a hostile mob or lava close enough to threaten the bot in the next few seconds?' },
});

export function createJevClient({ apiKey = process.env.JEV_API_KEY, model = process.env.JEV_MODEL ?? 'jev-latest', timeoutMs = 400, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error('JEV_API_KEY is not set');
  return async function ask(state, questions = QUESTIONS) {
    const res = await fetchImpl(JEV_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state, questions }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`jev returned ${res.status}`);
    return res.json();
  };
}

// Turn Jev answers into observations for the planner. Nothing here says what to do.
export function toHints(reply, facts = {}, now = Date.now()) {
  const sit = reply?.answers?.situation, danger = reply?.answers?.danger, heard = reply?.answers?.heard_threat;
  const hostile = (facts.nearby_mobs ?? []).find((m) => m.hostile) ?? null;
  return {
    model: reply?.model ?? null, at: now,
    situation: SITUATIONS.includes(sit?.choice) ? sit.choice : null,
    situation_confidence: Number.isFinite(sit?.confidence) ? sit.confidence : null,
    danger: Number.isFinite(danger?.noul) ? danger.noul : null,
    heard_threat: HEARD_THREATS.includes(heard?.choice) ? heard.choice : null,
    nearest_hostile: hostile ? { type: hostile.type, distance: hostile.distance, dx: hostile.dx, dy: hostile.dy, dz: hostile.dz } : null,
  };
}

// Refresh hints every intervalMs. Skips a beat while a request is in flight.
export function createJevPerception({ ask, getFacts, intervalMs = 500, now = Date.now, setTimer = setInterval, clearTimer = clearInterval, onError = () => {} }) {
  let hints = null, busy = false, errors = 0, lastError = null, timer = null, latency = null;
  async function refresh() {
    if (busy) return;
    busy = true;
    const started = now();
    try { const facts = getFacts(); hints = toHints(await ask(jevState(facts)), facts, now()); latency = now() - started; errors = 0; lastError = null; }
    catch (e) { errors++; lastError = String(e?.message ?? e); onError(e); }
    finally { busy = false; }
  }
  return {
    refresh,
    start() { if (!timer) timer = setTimer(() => { refresh(); }, intervalMs); return this; },
    stop() { if (timer) clearTimer(timer); timer = null; },
    // Hints older than 3 intervals are stale; the planner should fall back to facts.
    read() { const age = hints ? now() - hints.at : null; return { enabled: true, hints, age_ms: age, stale: age == null || age > intervalMs * 3, latency_ms: latency, errors, last_error: lastError }; },
  };
}
