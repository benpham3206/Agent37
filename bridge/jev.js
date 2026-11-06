// Jev perception: a fast, optional hint layer for the planner.
// Jev (TypeSafe's System One model) answers typed questions about a state.
// API: POST https://api.typesafe.ai/v1/systemone, Bearer key, {model,state,questions}
// -> {model, answers:{id:{type,...}}, usage}. Docs: https://docs.typesafe.ai
// Off unless AGENT37_JEV=1 and JEV_API_KEY are set. Never blocks the 50 ms tick:
// the loop runs on its own timer, one request in flight, and any failure keeps
// the planner on facts alone.
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const GOALS = Object.freeze(['wood', 'iron', 'obsidian', 'lava_water', 'portal', 'none']);
const GOAL_BLOCKS = {
  wood: (n) => n.endsWith('_log') || n.endsWith('_stem'),
  iron: (n) => n.endsWith('iron_ore'),
  obsidian: (n) => n === 'obsidian',
  lava_water: (n) => n === 'lava' || n === 'water',
  portal: (n) => n === 'nether_portal',
};

export function jevEnabled(env = process.env) {
  return env.AGENT37_JEV === '1' && Boolean(env.JEV_API_KEY);
}

// Small state: Jev bills per input token, so send only what the questions need.
export function jevState(facts = {}) {
  const near = {};
  for (const [name, b] of Object.entries(facts.nearest_blocks ?? {})) near[name] = { distance: b.distance, dx: b.dx, dy: b.dy, dz: b.dz };
  return {
    goal: 'reach the Nether: wood, tools, iron, obsidian, light a portal, enter',
    dimension: facts.dimension ?? null, health: facts.health ?? null, is_day: facts.is_day ?? null,
    inventory: facts.inventory ?? {}, nearest_blocks: near,
    sounds: (facts.sounds ?? []).slice(0, 8).map((x) => ({ name: x.name, source: x.source ?? null, direction: x.direction, distance: x.distance, age_ms: x.age_ms })),
    nearby_mobs: (facts.nearby_mobs ?? []).slice(0, 8).map((m) => ({ type: m.type, hostile: m.hostile, distance: m.distance, dx: m.dx, dy: m.dy, dz: m.dz })),
  };
}

export const QUESTIONS = Object.freeze({
  next_goal: { type: 'choice', instructions: 'Given `inventory` and `nearest_blocks`, which step of `goal` should the bot work on next?', criteria: {
    wood: 'No logs in inventory and a log is nearby', iron: 'Has tools but not enough iron, iron ore nearby',
    obsidian: 'Has iron kit, needs obsidian; obsidian nearby', lava_water: 'Needs obsidian and lava or water is nearby to make it',
    portal: 'A nether portal is nearby or the kit is complete', none: 'Nothing useful is nearby' } },
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

// Turn Jev answers into planner hints, pointing the chosen goal at the nearest matching block.
export function toHints(reply, facts = {}, now = Date.now()) {
  const goal = reply?.answers?.next_goal, danger = reply?.answers?.danger;
  const choice = GOALS.includes(goal?.choice) ? goal.choice : null;
  let where = null;
  if (choice && GOAL_BLOCKS[choice]) {
    const hits = Object.entries(facts.nearest_blocks ?? {}).filter(([n]) => GOAL_BLOCKS[choice](n)).sort((a, b) => a[1].distance - b[1].distance);
    if (hits.length) where = { block: hits[0][0], distance: hits[0][1].distance, dx: hits[0][1].dx, dy: hits[0][1].dy, dz: hits[0][1].dz };
  }
  const hostile = (facts.nearby_mobs ?? []).find((m) => m.hostile) ?? null;
  return {
    model: reply?.model ?? null, at: now,
    next_goal: choice, next_goal_confidence: Number.isFinite(goal?.confidence) ? goal.confidence : null, where,
    danger: Number.isFinite(danger?.noul) ? danger.noul : null,
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
