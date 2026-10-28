// Tracks one bot's advancement progress from the raw `advancements` packet on bot._client.
// Packet parsing adapted from mindcraft-ce (MIT): keeps ids, requirements and criteria only; display/NBT data is dropped.
const ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const CRITERION = /^[a-z0-9_.:-]+$/;
const MAX = 128;

const safeId = (v) => (typeof v === 'string' && v.length <= 256 && ID.test(v) ? v : null);
const safeCriteria = (v) => (Array.isArray(v) && v.length <= MAX
  ? v.filter((c) => typeof c === 'string' && c.length <= MAX && CRITERION.test(c)) : []);

// Pure reducer: (state, packet) -> new state. Handles reset, added (advancementMapping), removed (identifiers), progress (progressMapping).
export function applyAdvancementPacket(previous, packet) {
  const state = previous?.entries ? structuredClone(previous) : { known: false, entries: {} };
  if (packet?.reset === true) state.entries = {};
  for (const id of Array.isArray(packet?.identifiers) ? packet.identifiers : []) {
    const safe = safeId(id); if (safe) delete state.entries[safe];
  }
  for (const pair of Array.isArray(packet?.advancementMapping) ? packet.advancementMapping : []) {
    const id = safeId(pair?.key); if (!id || !pair.value || typeof pair.value !== 'object') continue;
    const reqs = Array.isArray(pair.value.requirements) && pair.value.requirements.length <= MAX
      ? pair.value.requirements.map(safeCriteria).filter((g) => g.length) : [];
    state.entries[id] = { requirements: reqs, criteria: state.entries[id]?.criteria ?? {} };
  }
  for (const pair of Array.isArray(packet?.progressMapping) ? packet.progressMapping : []) {
    const id = safeId(pair?.key); const entry = id && state.entries[id]; if (!entry) continue;
    const criteria = { ...entry.criteria };
    for (const p of Array.isArray(pair.value) ? pair.value.slice(0, MAX) : []) {
      const c = p?.criterionIdentifier; if (typeof c !== 'string' || c.length > MAX || !CRITERION.test(c)) continue;
      const t = p.criterionProgress;
      criteria[c] = t === null || t === undefined ? null : (typeof t === 'bigint' ? Number(t) : Number.isFinite(t) && t >= 0 ? t : null);
    }
    entry.criteria = criteria;
  }
  state.known = true;
  return state;
}

// An advancement is done when every requirement group has at least one criterion with a timestamp.
export function isDone(entry) {
  return entry.requirements.length > 0 && entry.requirements.every((g) => g.some((c) => entry.criteria[c] != null));
}

// Summary for /status: done ids, in-progress ids (some criteria met), and per-id counts.
export function summarize(state) {
  const done = [], inProgress = [], progress = {};
  for (const [id, e] of Object.entries(state.entries)) {
    if (id.includes(':recipes/')) continue; // recipe unlocks are advancements too; leave them out of the view
    const met = e.requirements.filter((g) => g.some((c) => e.criteria[c] != null)).length;
    progress[id] = { met, total: e.requirements.length };
    if (isDone(e)) done.push(id); else if (met > 0) inProgress.push(id);
  }
  return { known: state.known, done: done.sort(), in_progress: inProgress.sort(), progress };
}

// Per-bot tracker. attach(bot) listens on bot._client; get() returns the summary.
export class AdvancementTracker {
  constructor() { this.state = { known: false, entries: {} }; this.updatedAt = null; }
  apply(packet) { this.state = applyAdvancementPacket(this.state, packet); this.updatedAt = Date.now(); return this; }
  attach(bot) {
    const client = bot?._client; if (!client?.on) return () => {};
    const onPacket = (packet) => { try { this.apply(packet); } catch {} };
    const onEnd = () => { this.state = { known: false, entries: {} }; };
    client.on('advancements', onPacket); bot.on?.('end', onEnd);
    return () => { client.removeListener?.('advancements', onPacket); bot.removeListener?.('end', onEnd); };
  }
  get() { return { ...summarize(this.state), updated_at: this.updatedAt }; }
}
