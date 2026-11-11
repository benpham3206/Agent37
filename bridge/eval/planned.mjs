import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runTrial } from './run.mjs';
import { createUnstuckWatchdog } from './unstuck.mjs';
import { createMobWatchdog } from './mobwatch.mjs';
import { resultsDir as localResults } from '../e2e/local.js';
import {
  DEFAULT_REGION, UNSTUCK_WATCH_STEPS, MOBWATCH_STEPS, assertLiveSettings, countLogs,
  createChainCiArena, createChainRegion, footPosition, grantCommands, stagePlan, checkMutation,
  acceptedStageCommand, allowedPosition, jevSample, liveArena, loadStep, ownedUsername, parseStart,
  safeReason, snapshot,
} from './chain.mjs';
import { createPlanner, shouldDecide, describe, conditionMet, MIN_INTERVAL_MS, MAX_REVISIONS } from '../planner/planner.mjs';
import { findThreat, ignoredHostileClose, primitiveFor, effectiveAction, minHealthFor, FUSE_RANGE, COOLDOWN_MS } from '../planner/threat.mjs';
import { timeLimitFor } from '../skills/resource.collect_wood/v1/index.js';
import { createCliModel, cliArgs } from '../planner/model-cli.mjs';
import { PRIMITIVE_SPECS, createPrimitiveRunner, validatePrimitive } from '../planner/primitives.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MINUTES = 10;
export const MAX_MINUTES = 15;
// The arbiter's retreat reflex (a sprinting retreat at 4 health or below) takes control from the skill.
// In planned runs the model owns that decision through its threat_policy, so the reflex is off here only.
export const PLANNED_RUNTIME_OPTIONS = Object.freeze({ retreatHealth: 0 });
export const openPlannedArena = (env, dataDir, region, jev, open = liveArena) => open(env, dataDir, region, jev, { ...PLANNED_RUNTIME_OPTIONS });
const FUSE_SOUND = 'entity.creeper.primed';
const ABORTED_BY_RUNNER = new Set(['planner_replaced', 'threat_reflex']);

const sum = (inv, test) => Object.entries(inv ?? {}).reduce((n, [k, v]) => n + (test(k) && Number.isFinite(v) ? v : 0), 0);
const have = (s, name) => (s.inventory?.[name] ?? 0) > 0;
const hasPickaxe = (s) => sum(s.inventory, (k) => k.endsWith('_pickaxe')) > 0;

// Everything the model may pick. A skill that cannot load is left out by buildCandidates.
export const SKILL_SPECS = Object.freeze({
  'resource.collect_wood': { step: 'wood', input: { count: { type: 'integer', min: 1, max: 64 } },
    description: 'Collect logs from nearby trees until count logs are held in total. It finishes the tree it started before walking to another. Time limit is 30 s plus 30 s per log.',
    requires: (s) => sum(s.inventory, (k) => k.endsWith('_log')) < 3 },
  'resource.collect_oak_log': { step: 'wood', input: {}, description: 'Collect one more oak log.',
    requires: (s) => sum(s.inventory, (k) => k.endsWith('_log')) < 3 },
  'resource.mine_iron_ore': { step: 'iron', input: { descent: 'boolean' },
    description: 'Mine one raw iron with a pickaxe. descent:true digs stairs down to search; the runner supplies safe bounds.',
    requires: (s) => hasPickaxe(s) && !have(s, 'raw_iron') && !have(s, 'iron_ingot') },
  'combat.kill_hostile': { step: 'combat', input: {},
    description: 'Fight and kill one hostile mob with the trained combat policy. Only zombies are trained: against any other mob it is untested, so use the attack or flee moves for those. Needs a combat model on the bot and fails with requirement_unmet without one. Time limit 60 s.',
    requires: () => true },
  'portal.light': { step: 'light', input: {}, description: 'Light the built portal frame with flint and steel. Needs a built frame.',
    requires: (s) => s.frame_built && have(s, 'flint_and_steel') },
  'travel.enter_nether': { step: 'enter', input: {}, description: 'Walk into a lit portal.',
    requires: (s) => s.frame_built && s.nearest_blocks.some((b) => b.type === 'nether_portal') },
});

export const ASSIST_SPECS = Object.freeze({
  give_wood: { description: 'Give 5 oak logs.', requires: (s) => sum(s.inventory, (k) => k.endsWith('_log')) < 3 },
  give_tools: { description: 'Put a stone pickaxe in the hotbar. No skill crafts tools yet.', requires: (s) => !hasPickaxe(s) },
  give_iron: { description: 'Give 7 iron ingots.', requires: (s) => !have(s, 'raw_iron') && !have(s, 'iron_ingot') },
  build_frame: { description: 'Build an obsidian portal frame on a cleared pad.', requires: (s) => !s.frame_built },
  give_flint: { description: 'Give flint and steel and move the bot to the frame.', requires: (s) => s.frame_built && !have(s, 'flint_and_steel') },
});

// The fixed chain order, used only when the model's reply is unusable.
const FALLBACK_ORDER = Object.freeze([
  ['skill', 'resource.collect_wood'], ['skill', 'resource.collect_oak_log'], ['assist', 'give_tools'],
  ['skill', 'resource.mine_iron_ore'], ['assist', 'build_frame'], ['assist', 'give_flint'],
  ['skill', 'portal.light'], ['skill', 'travel.enter_nether']]);

export function makeSkillLoader(resolve = (name) => loadStep({ skills: [name] })) {
  const cache = new Map();
  return (name) => {
    if (!cache.has(name)) cache.set(name, Promise.resolve(resolve(name)));
    return cache.get(name);
  };
}

export async function buildCandidates(load, { allowAssists = false } = {}) {
  const skills = {}, skipped = [];
  for (const [name, spec] of Object.entries(SKILL_SPECS)) {
    const loaded = await load(name);
    if (!loaded?.run) { skipped.push({ skill: name, reason: loaded?.reason ?? 'unavailable' }); continue; }
    skills[name] = { input: spec.input, description: spec.description, requires: spec.requires };
  }
  const assists = allowAssists ? Object.fromEntries(Object.entries(ASSIST_SPECS).map(([k, v]) => [k, { ...v }])) : {};
  const order = FALLBACK_ORDER.filter(([kind, name]) => kind === 'skill' ? skills[name] : assists[name])
    .map(([kind, name]) => ({ kind, name }));
  return { candidates: { skills, assists, order, primitives: PRIMITIVE_SPECS, allowAssists }, skipped };
}

export function finishPlanned(s) {
  s.status = s.reached_nether && s.assists_used === 0 && s.watchdog_actions === 0 && s.fallback_decisions === 0
    ? 'PASS' : s.reached_nether ? 'ASSISTED' : 'FAIL';
  return s.status;
}

export function parsePlannedOptions(args, env = process.env) {
  const rest = [], startArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start') {
      if (i + 1 >= args.length) throw new Error('usage: --start needs an X,Z value');
      startArgs.push(args[++i]);
    } else if (args[i].startsWith('--start=')) startArgs.push(args[i].slice(8));
    else rest.push(args[i]);
  }
  if (startArgs.length !== 1) throw new Error('usage: --start X,Z is required exactly once');
  const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: {
    live: { type: 'boolean' }, ci: { type: 'boolean' }, model: { type: 'string' }, minutes: { type: 'string' },
    unstuck: { type: 'boolean' }, 'mob-watch': { type: 'boolean' }, jev: { type: 'boolean' },
    'allow-assists': { type: 'boolean' }, 'reset-advancements': { type: 'boolean' } } });
  const minutes = values.minutes == null ? DEFAULT_MINUTES : Number(values.minutes);
  const usage = 'usage: node eval/planned.mjs (--live | --ci) --start X,Z --model <name> [--minutes M] [--unstuck] [--mob-watch] [--jev] [--allow-assists] [--reset-advancements]';
  if (Boolean(values.live) === Boolean(values.ci) || !values.model || !Number.isFinite(minutes) ||
      minutes <= 0 || minutes > MAX_MINUTES) throw new Error(usage);
  cliArgs(values.model);
  const region = { ...createChainRegion(parseStart(startArgs[0])), protected: false };
  const username = ownedUsername(env);
  if (values.live) assertLiveSettings(env);
  return { live: Boolean(values.live), ci: Boolean(values.ci), start: region.center, region, username,
    model: values.model, minutes, unstuck: Boolean(values.unstuck), mobWatch: Boolean(values['mob-watch']),
    jev: Boolean(values.jev), allowAssists: Boolean(values['allow-assists']),
    resetAdvancements: Boolean(values['reset-advancements']) };
}

const STEP_OF = Object.fromEntries(Object.entries(SKILL_SPECS).map(([k, v]) => [k, v.step]));
const ASSIST_COMMANDS = {
  give_wood: (arena, ctx) => grantCommands('wood', arena, ctx),
  give_tools: (arena, ctx) => grantCommands('tools', arena, ctx),
  give_iron: (arena, ctx) => grantCommands('iron', arena, ctx),
  build_frame: (arena, ctx) => grantCommands('obsidian', arena, ctx),
  give_flint: (arena, ctx) => ctx.frame ? stagePlan('light', arena, ctx).commands : [],
};

export async function runPlanned({ arena, planner, load, username, region: regionIn = DEFAULT_REGION, minutes = DEFAULT_MINUTES,
  model = 'unknown', unstuck = false, mobWatch = false, jev = false, getJev = () => arena.runtimeJev?.() ?? null,
  allowAssists = false, resetAdvancements = false, getAdvancements = () => arena.advancements?.() ?? null,
  primitiveClock = {}, watchdogLimits = {}, reactionClock = () => performance.now(), threatPollMs = 100,
  minIntervalMs = MIN_INTERVAL_MS, pollMs = 250, jevIntervalMs = 5000, onLine = console.log, onProgress = () => {},
  limits = null } = {}) {
  if (!['Ben_bot', 'Vikram_bot'].includes(username)) throw new Error('this runner owns only Ben_bot or Vikram_bot');
  if (!(minutes > 0 && minutes <= MAX_MINUTES)) throw new Error(`minutes must be in (0, ${MAX_MINUTES}]`);
  // The 20-block protected radius guards the ruined portal in chain.mjs. This runner has none; the outer limit stays.
  const region = { ...regionIn, protected: false };
  const startedAt = performance.now(), deadline = startedAt + minutes * 60000;
  const report = { kind: 'planned', synthetic: arena.synthetic, username, model, region, minutes,
    started_at: new Date().toISOString(), limits: limits ?? planner.limits, rows: [], events: [], setup_commands: [],
    assists_allowed: allowAssists, advancement_reset: null, advancement_timeline: [], watchdog_events: [],
    plan: { objectives: null, initial: null, completed: [], revisions: [] },
    threat: { policy: null, policy_changes: [], events: [] },
    totals: { requested_new_skills: [], jev_samples: [] },
    summary: { reached_nether: false, objectives_done: 0, objectives_total: 0, plan_revisions: 0, gave_up: null, assisted: false, natural_skill_successes: 0, primitive_steps: 0, threat_responses: 0, threat_events: 0, threat_policy_changes: 0, assists_used: 0,
      watchdog_actions: 0, fallback_decisions: 0, watchdog: { stuck_resets: 0, mob_removals: 0, noops: 0 }, status: 'FAIL' },
    limitations: ['Assists, watchdog actions and fallback decisions all block a PASS.',
      'Skills are not aborted by the region guard mid-run; only their start is guarded.'] };
  const S = report.summary;
  const context = { frame: null, username, region };
  const history = [], stragglers = [];
  let terminalFailure = null, n = 0, lastDecisionAt = null, prevJev = null, pendingTrigger = null, skillEnded = false;
  let planMade = false, objectiveDone = false, policySet = false, prevHostileClose = false;
  const planState = { objectives: null, index: 0, revisions: 0, doneIds: [] };
  const failure = (reason) => { report.events.push({ at: new Date().toISOString(), reason }); terminalFailure ??= reason; };
  const human = () => failure('human_takeover');
  arena.events.on('failure', failure);
  arena.events.on('human_takeover', human);

  const observe = () => ({ ...snapshot(arena), frame: context.frame });
  const readJev = () => { if (!jev) return jevSample(null, null); try { return jevSample(getJev(), null); } catch { return jevSample(null, null); } };
  let jevTimer = null;
  if (jev) {
    const sample = () => { const s = jevSample((() => { try { return getJev(); } catch { return null; } })(), null);
      if (report.totals.jev_samples.length < 400) report.totals.jev_samples.push(s); return s; };
    sample();
    jevTimer = setInterval(sample, jevIntervalMs);
  }

  const doneAdvancements = () => {
    try { const a = getAdvancements(); return a && a.known !== false && Array.isArray(a.done) ? new Set(a.done) : null; } catch { return null; }
  };
  report.advancement_tracker = doneAdvancements() !== null;
  let seenAdvancements = null, advTimer = null;
  const pollAdvancements = () => {
    const now = doneAdvancements();
    if (!now) return;
    if (!seenAdvancements) { seenAdvancements = new Set(now); return; }
    for (const id of [...now].sort()) {
      if (seenAdvancements.has(id)) continue;
      seenAdvancements.add(id);
      const elapsed = Math.round(performance.now() - startedAt);
      report.advancement_timeline.push({ advancement: id, at: new Date().toISOString(), elapsed_ms: elapsed, step: n });
      onLine(`ADVANCEMENT ${id} elapsed=${(elapsed / 1000).toFixed(1)}`);
    }
  };
  async function revokeAdvancements() {
    const command = `advancement revoke ${username} everything`;
    const entry = { command, at: new Date().toISOString(), reply: null, error: null };
    report.advancement_reset = entry;
    try { entry.reply = await arena.command(command); } catch (error) { entry.error = safeReason(error); return; }
    await arena.settle?.();
    for (let i = 0; i < 20 && (doneAdvancements()?.size ?? 0) > 0; i++) await delay(100);
  }

  const watchdogDeps = { observe: () => arena.observe(),
    blockAt: typeof arena.blockAt === 'function' ? (x, y, z) => arena.blockAt(x, y, z) : () => null,
    runCommand: (c) => arena.command(c),
    resolveUuid: typeof arena.resolveUuid === 'function' ? (m) => arena.resolveUuid(m) : () => null,
    username, isAllowedPosition: (p) => allowedPosition(p, region) };
  const watchdogs = [];
  if (unstuck) watchdogs.push({ steps: UNSTUCK_WATCH_STEPS, type: 'stuck_reset', counter: 'stuck_resets', seen: 0,
    watchdog: createUnstuckWatchdog({ ...watchdogDeps, limits: watchdogLimits }) });
  if (mobWatch) watchdogs.push({ steps: MOBWATCH_STEPS, type: 'mob_removed', counter: 'mob_removals', seen: 0,
    watchdog: createMobWatchdog(watchdogDeps) });

  const nowMs = () => performance.now();
  // The model's own threat rules, applied by the runner at once. A model call is too slow for a hit or a creeper fuse.
  const threat = { policy: null, active: null, main: null, epoch: 0, pending: [], lastAt: new Map(), prevHealth: null, ignoredClose: false };
  const cooling = (key) => {
    const at = threat.lastAt.get(key);
    return at != null && reactionClock() - at < (key === 'hit' ? COOLDOWN_MS.hit : key === 'fuse' ? COOLDOWN_MS.fuse : COOLDOWN_MS.mob);
  };

  function openRow({ decision, trace, trigger }) {
    const row = { n: ++n, at: trace?.at ?? new Date().toISOString(), trigger, summary_sent: trace?.summary ?? null,
      raw_replies: trace?.raw_replies ?? [], model_errors: trace?.errors ?? [], attempts: trace?.attempts ?? 0,
      decision, objective: decision.objective ?? null, fallback: Boolean(decision.fallback), outcome: null, reason: null, assisted: false,
      elapsed_ms: null, model_ms: trace?.elapsed_ms ?? null, tokens: trace?.tokens ?? 0, cost_usd: trace?.cost_usd ?? 0,
      models: trace?.models ?? [] };
    if (row.fallback) S.fallback_decisions++;
    report.rows.push(row);
    return row;
  }
  function closeRow(row, result, { record = true } = {}) {
    pollAdvancements();
    Object.assign(row, { outcome: result.outcome, reason: result.reason ?? null });
    if (result.input) row.input = result.input;
    if (result.detail) row.detail = result.detail;
    if (result.moved !== undefined) { row.moved = result.moved; row.dug = result.dug; }
    if (record) history.push({ n: row.n, decision: row.decision, outcome: row.outcome, reason: row.reason,
      ...(result.moved !== undefined ? { moved: result.moved, dug: result.dug } : {}) });
    onLine(`PLAN ${row.n} trigger=${row.trigger} decision=${describe(row.decision).replace(/\s+/g, '_').slice(0, 80)} outcome=${row.outcome} tokens=${row.tokens}`);
    return onProgress(report);
  }

  const currentObjective = () => planState.objectives?.[planState.index] ?? null;
  const planForModel = () => planState.objectives ? { objectives: planState.objectives, done: planState.doneIds.slice(),
    current: currentObjective()?.id ?? null, revisionsLeft: MAX_REVISIONS - planState.revisions } : null;
  const objectiveLine = (objectives) => objectives.map((o) => ({ id: o.id, description: o.description, done: o.done, reasoning: o.reasoning }));
  const setPlan = (objectives) => {
    planState.objectives = objectives; planState.index = 0; planState.doneIds = [];
    S.objectives_total = objectives.length;
    report.plan.objectives = objectives;
    onLine(`PLAN_OBJECTIVES ${JSON.stringify(objectiveLine(objectives))}`);
  };
  // The runner, not the model, decides an objective is done: it reads the real observation.
  function completeObjectives() {
    let any = false;
    for (let o = currentObjective(); o && conditionMet(o.done, observe()); o = currentObjective()) {
      const elapsed = Math.round(nowMs() - startedAt);
      report.plan.completed.push({ id: o.id, description: o.description, done: o.done, at: new Date().toISOString(), elapsed_ms: elapsed, step: n });
      planState.doneIds.push(o.id); planState.index++; S.objectives_done++; any = true;
      onLine(`OBJECTIVE done ${o.id} elapsed=${(elapsed / 1000).toFixed(1)}`);
    }
    return any;
  }

  const requestDecision = (trigger) => {
    lastDecisionAt = nowMs();
    const report = threat.pending.length ? threat.pending.splice(0) : null;
    return planner.decide({ observation: observe(), jev: readJev(), history: history.slice(), trigger, plan: planForModel(),
      threatPolicy: threat.policy, threat: report && { what_happened: report } })
      .then((decision) => ({ decision, trace: planner.traceOf(decision), trigger }));
  };

  async function assistAction(decision, row) {
    const commands = ASSIST_COMMANDS[decision.assist](arena, context);
    row.assisted = true; S.assisted = true; S.assists_used++;
    if (!commands.length) return { outcome: 'failure', reason: decision.assist === 'give_flint' ? 'no_frame' : 'no_commands' };
    const entry = { kind: 'assist', assist: decision.assist, assisted: true, before: snapshot(arena), commands: [] };
    row.assistance = [entry];
    for (const command of commands) {
      checkMutation(command, region);
      if (terminalFailure) throw new Error(terminalFailure);
      if (nowMs() + (arena.commandBudgetMs ?? 0) >= deadline) throw new Error('run_time_limit');
      const item = { command };
      entry.commands.push(item);
      item.reply = await arena.command(command);
      item.accepted = acceptedStageCommand(command, item.reply, username);
      if (!item.accepted) { entry.after = snapshot(arena); return { outcome: 'failure', reason: 'command_rejected' }; }
    }
    await arena.settle?.();
    entry.after = snapshot(arena);
    return { outcome: 'success', reason: 'assist_applied' };
  }

  async function skillAction(decision, row, trialEvents) {
    const loaded = await load(decision.skill);
    if (!loaded?.run) return { outcome: 'failure', reason: loaded?.reason ?? 'skill_unavailable' };
    const foot = footPosition(arena, region);
    const step = STEP_OF[decision.skill];
    const input = { ...loaded.skill.requirements?.input };
    if (step === 'wood') input.count = decision.input.count ?? input.count ?? 5;
    if (step === 'iron') {
      delete input.descent;
      if (decision.input.descent) {
        const radius = 24;
        const away = Math.hypot(foot.x - region.center.x, foot.z - region.center.z);
        if (away + radius > region.radius) {
          return { outcome: 'failure', reason: 'descent_bounds_outside_region' };
        }
        Object.assign(input, { descent: true, bounds: { x: foot.x, z: foot.z, radius } });
      }
    }
    if (step === 'combat') { delete input.allowed_targets; input.target_type = 'zombie'; }
    if (step === 'light') {
      if (!context.frame) return { outcome: 'failure', reason: 'no_frame' };
      input.frame = context.frame;
    }
    const armed = watchdogs.filter((w) => w.steps.has(step));
    let tick = null, ticks = [];
    for (const w of armed) w.watchdog.arm(step);
    if (armed.length) tick = setInterval(() => {
      ticks = armed.map((w) => Promise.resolve().then(() => w.watchdog.tick()).catch(() => {}));
    }, 250);
    try {
      const remaining = Math.max(1, Math.floor(deadline - nowMs()));
      const limit = step === 'wood' ? timeLimitFor(input.count) : loaded.skill.success_check.time_limit_ms;
      const skill = { ...loaded.skill, success_check: { ...loaded.skill.success_check, time_limit_ms: Math.min(limit, remaining) } };
      row.attempt_before = snapshot(arena);
      const continuous = { ...arena, events: trialEvents, reset: async () => {}, observe: () => {
        const o = arena.observe();
        if (step === 'wood') o.wood = { goal_reached: o.inventory != null && countLogs(o.inventory) >= (input.count ?? 5) };
        return o;
      } };
      const trial = await runTrial({ arena: continuous, skill, run: loaded.run, input, trial: row.n });
      let { outcome, reason } = trial;
      if (outcome === 'failure' && ABORTED_BY_RUNNER.has(reason)) outcome = 'aborted';
      if (outcome === 'success' && step === 'light' && !await arena.portalLit(context.frame)) {
        outcome = 'failure'; reason = 'frame_interior_not_lit';
      }
      if (outcome === 'success' && step === 'enter' && snapshot(arena).dimension !== 'the_nether') {
        outcome = 'failure'; reason = 'not_in_the_nether';
      }
      return { outcome, reason, input };
    } finally {
      if (tick) clearInterval(tick);
      for (const w of armed) w.watchdog.disarm();
      await Promise.allSettled(ticks);
      for (const w of armed) {
        const events = w.watchdog.events ?? [];
        const fresh = events.slice(w.seen);
        w.seen = events.length;
        for (const event of fresh) {
          if (event.rcon_reply == null) {
            report.watchdog_events.push({ type: w.type, row: row.n, acted: false, ...event });
            (row.watchdog_noops ??= []).push(event.reason);
            S.watchdog.noops++;
            continue;
          }
          (row.assistance ??= []).push({ type: w.type, assisted: true, ...event });
          row.assisted = row.watchdog_assisted = true;
          S.assisted = true;
          S.watchdog[w.counter]++;
          S.watchdog_actions++;
        }
      }
    }
  }

  async function primitiveAction(decision, row, trialEvents, { reflex = false, onFirstAction = null } = {}) {
    const controller = new AbortController();
    const abort = (reason) => controller.abort(new Error(String(reason)));
    trialEvents.on('failure', abort);
    trialEvents.on('human_takeover', () => abort('human_takeover'));
    try {
      const raw = arena.bot(controller.signal);
      let first = true;
      const bot = !onFirstAction ? raw : Object.freeze({ observe: () => raw.observe(), releaseControls: () => raw.releaseControls(),
        requestAction(action) { if (first) { first = false; onFirstAction(reactionClock()); } return raw.requestAction(action); } });
      const run = createPrimitiveRunner({ bot, deadline: deadline, ...primitiveClock, minHealthFor: (type) => minHealthFor(threat.policy, type) });
      row.attempt_before = snapshot(arena);
      const result = await run(decision, { signal: controller.signal });
      S.primitive_steps++;
      return result;
    } catch (error) {
      const reason = safeReason(controller.signal.aborted ? controller.signal.reason : error);
      return { outcome: ABORTED_BY_RUNNER.has(reason) ? 'aborted' : 'failure', reason, moved: false, dug: false };
    } finally { if (reflex || !threat.active) { try { arena.release(); } catch { /* controls already released */ } } }
  }

  function startAction(decision, row, hooks = null) {
    const trialEvents = new EventEmitter();
    const forward = (reason) => trialEvents.emit('failure', reason);
    const forwardHuman = () => trialEvents.emit('human_takeover');
    arena.events.on('failure', forward);
    arena.events.on('human_takeover', forwardHuman);
    const began = nowMs();
    const promise = (async () => {
      try {
        if (decision.type === 'request_new_skill') {
          const found = report.totals.requested_new_skills.find((r) => r.name === decision.name);
          if (found) found.count++;
          else report.totals.requested_new_skills.push({ name: decision.name, goal: decision.goal, why: decision.why, count: 1 });
          return { outcome: 'recorded', reason: 'request_recorded_nothing_written' };
        }
        if (decision.type === 'primitive') return await primitiveAction(decision, row, trialEvents, hooks ?? {});
        if (decision.type === 'request_assist') {
          if (!allowAssists) return { outcome: 'failure', reason: 'assists_disabled' };
          return await assistAction(decision, row);
        }
        const result = await skillAction(decision, row, trialEvents);
        if (result.outcome === 'success') S.natural_skill_successes++;
        return result;
      } catch (error) {
        return { outcome: error.message === 'run_time_limit' ? 'timeout' : 'failure', reason: safeReason(error) };
      } finally {
        arena.events.off('failure', forward);
        arena.events.off('human_takeover', forwardHuman);
        row.elapsed_ms = Math.round(nowMs() - began);
      }
    })();
    return { decision, row, promise, abort: (reason) => trialEvents.emit('failure', reason) };
  }

  // Apply the model's own rule for a threat right now, pausing the running action. These are the bot's own
  // moves through the adapter: never assisted. The model is told afterwards and decides what comes next.
  function respond(v, arrived = reactionClock()) {
    threat.lastAt.set(v.kind === 'creeper_fuse' ? 'fuse' : v.kind === 'hit' ? 'hit' : `mob:${v.mob?.id}`, arrived);
    if (v.mob?.id != null) threat.lastAt.set(`mob:${v.mob.id}`, arrived);
    let decision = null;
    try { const raw = primitiveFor(v); decision = raw && { ...validatePrimitive(raw), reflex: true, rule: v.rule }; } catch { decision = null; }
    const event = { kind: v.kind, rule: v.rule, action: decision ? v.action : 'tell_model_only', why: v.why, health_at_trigger: threat.prevHealth,
      mob: v.mob ? { id: v.mob.id, type: v.mob.type, distance: v.mob.distance } : null, at: new Date().toISOString() };
    if (threat.active && !(v.kind === 'creeper_fuse' && threat.active.kind !== 'creeper_fuse')) return null;
    threat.active?.abort('threat_reflex');
    threat.main?.abort('threat_reflex');
    threat.epoch++;
    if (!decision) {
      Object.assign(event, { outcome: 'not_acted', reason: v.why });
      report.threat.events.push(event); S.threat_events++; threat.pending.push(event);
      return null;
    }
    const row = openRow({ decision, trace: null, trigger: `threat:${v.rule ?? v.kind}` });
    row.reflex = true;
    event.row = row.n;
    onLine(`THREAT ${v.kind} rule=${v.rule} action=${v.action} row=${row.n}`);
    const active = startAction(decision, row, { reflex: true, onFirstAction: (at) => { event.reaction_ms = Math.round((at - arrived) * 10) / 10; } });
    const mine = { kind: v.kind, row, abort: active.abort };
    mine.promise = active.promise.then(async (result) => {
      await closeRow(row, result);
      Object.assign(event, { outcome: result.outcome, reason: result.reason ?? null, health_at_end: threat.prevHealth });
      report.threat.events.push(event); S.threat_responses++; threat.pending.push(event);
    }).catch(() => {}).finally(() => { if (threat.active === mine) threat.active = null; });
    threat.active = mine;
    return mine;
  }

  // Creeper fuse: straight from the sound packet, inside the packet handler, with no Jev and no model call first.
  function onSound(ev) {
    const arrived = reactionClock();
    if (ev?.name !== FUSE_SOUND || !threat.policy || terminalFailure || cooling('fuse')) return;
    let o; try { o = arena.observe(); } catch { return; }
    const p = o?.self?.position, at = ev.position;
    if (!p) return;
    if (at && Math.hypot(at.x - p.x, at.z - p.z) > FUSE_RANGE) return;
    const rule = threat.policy.creeper_fuse, health = o.self?.health ?? null;
    const creeper = (o.facts?.nearby_mobs ?? []).find((m) => m?.type === 'creeper' && m.id != null) ?? null;
    let { action, why } = effectiveAction(rule, health);
    if (action === 'ignore') return;
    if (action === 'fight' && !creeper) { action = 'flee'; why = 'no_creeper_to_fight'; }
    const yaw = o.self?.yaw ?? 0;
    const away = at && Math.hypot(at.x - p.x, at.z - p.z) >= 0.1 ? { dx: at.x - p.x, dz: at.z - p.z } : { dx: -Math.sin(yaw), dz: -Math.cos(yaw) };
    respond({ kind: 'creeper_fuse', rule: 'creeper_fuse', action, why, mob: action === 'fight' ? creeper : null, away_from: away,
      flee_distance: rule.flee_distance }, arrived);
  }

  function threatPoll() {
    if (!threat.policy || terminalFailure) return;
    let o; try { o = arena.observe(); } catch { return; }
    const health = o.self?.health ?? null, prev = threat.prevHealth;
    threat.prevHealth = health;
    const view = { ...o, health, recent_events: o.self?.recent_events ?? [] };
    threat.ignoredClose = ignoredHostileClose(threat.policy, view);
    const v = findThreat({ policy: threat.policy, observation: view, prevHealth: prev, cooling });
    if (v) respond(v);
  }
  const stopSound = typeof arena.onSound === 'function' ? arena.onSound(onSound) : null;
  const threatTimer = setInterval(threatPoll, threatPollMs);

  // Runs one action. It is never asked about again while it runs, except when Jev's danger crosses up through 0.5
  // or a hostile the policy ignores comes close.
  async function supervise(active) {
    for (;;) {
      const ev = await Promise.race([active.promise.then(() => 'ended'), delay(pollMs).then(() => 'tick')]);
      if (ev === 'ended') { await closeRow(active.row, await active.promise); return { ended: true }; }
      if (terminalFailure || nowMs() >= deadline) {
        active.abort(terminalFailure ?? 'run_time_limit');
        await closeRow(active.row, await active.promise);
        return { ended: false, stop: true };
      }
      const j = readJev();
      const s = shouldDecide({ now: nowMs(), lastDecisionAt, skillActive: true, jev: j, prevJev, pendingTrigger, minIntervalMs,
        hostileClose: threat.ignoredClose, prevHostileClose });
      prevHostileClose = threat.ignoredClose;
      if (j.enabled && j.stale === false) prevJev = { danger: j.danger };
      if (s.decide) {
        pendingTrigger = null;
        active.abort('planner_replaced');
        await closeRow(active.row, await active.promise);
        return { ended: false, interrupted: s.trigger };
      }
      if (s.deferred) pendingTrigger = s.trigger;
    }
  }

  let runError = null;
  try {
    report.setup_readiness = await arena.prepare(1, [], report.setup_commands, deadline);
    report.start = snapshot(arena);
    if (resetAdvancements) await revokeAdvancements();
    pollAdvancements();
    advTimer = setInterval(pollAdvancements, pollMs);
    let forced = null;
    for (;;) {
      if (snapshot(arena).dimension === 'the_nether') { S.reached_nether = true; break; }
      if (terminalFailure) { runError = terminalFailure; break; }
      if (nowMs() >= deadline) { runError = 'run_time_limit'; break; }
      if (threat.active) { await threat.active.promise; continue; }
      if (!forced && threat.pending.length) { forced = 'threat_response'; skillEnded = false; }
      let trigger = forced;
      forced = null;
      if (!trigger) {
        const s = shouldDecide({ now: nowMs(), lastDecisionAt, skillActive: false, skillEnded, planNeeded: !planState.objectives,
          planMade, objectiveDone, policySet, jev: readJev(), minIntervalMs });
        if (!s.decide) { await delay(Math.min(pollMs, Math.max(1, deadline - nowMs()))); continue; }
        trigger = s.trigger;
        skillEnded = false; planMade = false; objectiveDone = false; policySet = false;
      }
      const epoch = threat.epoch;
      const row = openRow(await requestDecision(trigger));
      const decision = row.decision;
      if (threat.epoch !== epoch && ['run_skill', 'primitive', 'request_assist'].includes(decision.type)) {
        await closeRow(row, { outcome: 'discarded', reason: 'threat_response_ran_during_this_decision' }, { record: false });
        threat.pending.unshift(...(row.summary_sent?.threat_report?.what_happened ?? []));
        forced = 'threat_response';
        continue;
      }
      if (decision.type === 'plan') {
        threat.policy = report.threat.policy = decision.threat_policy;
        onLine(`THREAT_POLICY ${JSON.stringify(decision.threat_policy)}`);
        setPlan(decision.objectives);
        await closeRow(row, { outcome: 'success', reason: 'plan_accepted' });
        objectiveDone = completeObjectives(); planMade = !objectiveDone;
        continue;
      }
      if (decision.type === 'revise_plan') {
        planState.revisions++; S.plan_revisions = planState.revisions;
        report.plan.revisions.push({ n: row.n, at: new Date().toISOString(), why: decision.why, objectives: objectiveLine(decision.objectives) });
        onLine(`PLAN_REVISED ${planState.revisions}/${MAX_REVISIONS} why=${JSON.stringify(decision.why)}`);
        setPlan(decision.objectives);
        await closeRow(row, { outcome: 'success', reason: 'plan_revised' });
        objectiveDone = completeObjectives(); planMade = !objectiveDone;
        continue;
      }
      if (decision.type === 'set_threat_policy') {
        threat.policy = report.threat.policy = decision.policy; S.threat_policy_changes++;
        report.threat.policy_changes.push({ n: row.n, at: new Date().toISOString(), why: decision.why, policy: decision.policy });
        onLine(`THREAT_POLICY_SET ${S.threat_policy_changes} why=${JSON.stringify(decision.why)} policy=${JSON.stringify(decision.policy)}`);
        await closeRow(row, { outcome: 'success', reason: 'policy_set' });
        policySet = true;
        continue;
      }
      if (decision.type === 'done') {
        const finished = planState.objectives && !currentObjective();
        if (!finished) { S.gave_up = decision.reason; onLine(`GAVE_UP ${JSON.stringify(decision.reason)}`); }
        await closeRow(row, { outcome: finished ? 'done' : 'gave_up', reason: decision.reason });
        break;
      }
      const active = startAction(decision, row);
      threat.main = active;
      const result = await supervise(active);
      threat.main = null;
      skillEnded = decision.type !== 'request_new_skill';
      objectiveDone = completeObjectives();
      if (result.interrupted) forced = result.interrupted;
      if (result.stop) { runError = terminalFailure ?? 'run_time_limit'; break; }
    }
  } catch (error) {
    runError = safeReason(error);
    report.events.push({ at: new Date().toISOString(), reason: `runner_error:${runError}` });
  } finally {
    clearInterval(threatTimer); stopSound?.();
    threat.active?.abort('run_ended');
    if (jevTimer) clearInterval(jevTimer);
    if (advTimer) clearInterval(advTimer);
    pollAdvancements();
    const cap = new AbortController();
    await Promise.race([Promise.allSettled(stragglers), delay(5000, null, { signal: cap.signal }).catch(() => {})]);
    cap.abort();
    arena.events.off('failure', failure);
    arena.events.off('human_takeover', human);
    try { arena.release(); } catch { /* controls already released */ }
    S.reached_nether = S.reached_nether || snapshot(arena).dimension === 'the_nether';
    report.end = snapshot(arena);
    Object.assign(report.totals, planner.totals(), { decision_rows: report.rows.length });
    S.error = runError;
    finishPlanned(S);
    S.elapsed_ms = Math.round(performance.now() - startedAt);
    report.finished_at = new Date().toISOString();
    await onProgress(report);
  }
  const line = `SUMMARY ${S.status} reached_nether=${S.reached_nether} objectives=${S.objectives_done}/${S.objectives_total} plan_revisions=${S.plan_revisions} gave_up=${S.gave_up ? 'yes' : 'no'} decisions=${report.rows.length} natural_skill_successes=${S.natural_skill_successes} primitive_steps=${S.primitive_steps} threat_responses=${S.threat_responses} assists_used=${S.assists_used} watchdog_actions=${S.watchdog_actions} watchdog_noops=${S.watchdog.noops} advancements=${report.advancement_timeline.length} fallback_decisions=${S.fallback_decisions} tokens=${report.totals.tokens} cost_usd=${report.totals.cost_usd.toFixed(4)} elapsed=${(S.elapsed_ms / 1000).toFixed(1)}s`;
  report.summary_line = line;
  onLine(line);
  return report;
}

// Fake world for --ci and tests: a synthetic arena, synthetic skills and a scripted model.
export const CI_POLICY = Object.freeze({
  zombie_like: { action: 'fight', min_health: 8, flee_distance: 12 },
  creeper: { action: 'flee', flee_distance: 14 },
  creeper_fuse: { action: 'flee', flee_distance: 12 },
  other_hostile: { action: 'flee', flee_distance: 16 } });

export function createCiWorld({ region, username, model = 'fake' }) {
  const arena = createChainCiArena({ region, username });
  let inNether = false;
  const observe = arena.observe;
  arena.observe = () => {
    const o = observe();
    if (inNether) { o.dimension = 'the_nether'; if (o.facts) o.facts.dimension = 'the_nether'; }
    return o;
  };
  arena.portalLit = async () => true;
  // Synthetic advancements: a revoke command clears them, finished skills earn them.
  const earned = new Set(['minecraft:story/root']);
  arena.advancements = () => ({ known: true, done: [...earned] });
  const command = arena.command;
  arena.command = async (text) => {
    if (text === `advancement revoke ${username} everything`) { earned.clear(); await command(text); return `Revoked every advancement from ${username}`; }
    return command(text);
  };
  // Synthetic inventory changes and placed blocks live in an overlay on the observation. None of it touches RCON.
  const delta = {}, placed = {};
  const addItem = (name, n) => { delta[name] = (delta[name] ?? 0) + n; };
  const heldCount = (name) => Math.max(0, (arena.observe().inventory?.[name] ?? 0));
  const withOverlay = arena.observe;
  arena.observe = () => {
    const o = withOverlay();
    o.inventory = { ...(o.inventory ?? {}) };
    for (const [k, v] of Object.entries(delta)) { const n = (o.inventory[k] ?? 0) + v; if (n > 0) o.inventory[k] = n; else delete o.inventory[k]; }
    for (const [block, at] of Object.entries(placed)) {
      const p = o.self.position;
      o.facts.nearest_blocks[block] = { type: block, dx: at.x - p.x, dy: at.y - p.y, dz: at.z - p.z };
    }
    return o;
  };
  const logsHeld = () => Object.entries(arena.observe().inventory).filter(([k]) => k.endsWith('_log')).reduce((n, [, v]) => n + v, 0);
  const craftNow = ({ name, count }) => {
    const per = name === 'crafting_table' ? 1 : 4;
    for (let made = 0; made < count; made += per) {
      if (name === 'oak_planks') { if (logsHeld() < 1) return; addItem('oak_log', -1); addItem('oak_planks', 4); }
      else if (name === 'crafting_table') { if (heldCount('oak_planks') < 4) return; addItem('oak_planks', -4); addItem('crafting_table', 1); }
      else return;
    }
  };
  // A synthetic jump lifts the bot for a few observations. It never touches RCON.
  let airborne = 0;
  const lifted = arena.observe;
  arena.observe = () => {
    const o = lifted();
    if (airborne > 0) { airborne--; o.self.position.y += 0.6; o.self.on_ground = false; if (o.facts) o.facts.position = o.self.position; }
    return o;
  };
  const baseBot = arena.bot;
  arena.bot = (signal) => { const b = baseBot(signal); return { ...b, requestAction(action) {
    if (action.jump) airborne = 2;
    if (action.craft) craftNow(action.craft);
    if (action.interact && action.equip === 'crafting_table' && heldCount('crafting_table') > 0) {
      const { x, y, z, face } = action.interact;
      addItem('crafting_table', -1); placed.crafting_table = { x: x + face.x, y: y + face.y, z: z + face.z };
    }
    return b.requestAction(action); } }; };
  const resolve = (name) => ({ name, skill: { version: 1, requirements: { input: {} }, reset_steps: [],
    success_check: { time_limit_ms: 1000, condition: { path: 'self.health', equals: 20 } } },
  run: async (bot, input) => {
    const before = bot.observe();
    if (name === 'travel.enter_nether') { inNether = true; earned.add('minecraft:story/enter_the_nether'); }
    if (name === 'resource.collect_wood') {
      earned.add('minecraft:story/mine_stone');
      addItem('oak_log', Math.max(0, (input?.count ?? 5) - logsHeld()));
    }
    return { outcome: 'success', reason: 'synthetic', elapsed_ms: 0, before, after: bot.observe() };
  } });
  // Sounds the fake arena can play, as the bridge's sound tracker would report them.
  const listeners = new Set();
  arena.onSound = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  arena.emitSound = (ev) => { for (const fn of [...listeners]) fn(ev); };
  const objective = (id, description, done, reasoning) => ({ id, description, done, reasoning });
  const PLAN = { type: 'plan', objectives: [
    objective('logs', 'Hold 3 logs', { have: { item: 'any_log', count: 3 } }, 'Need 8 planks (2 logs x 4) for a table and sticks, plus 1 spare log: 3 logs.'),
    objective('planks', 'Hold 8 planks', { have: { item: 'any_planks', count: 8 } }, '2 logs x 4 planks = 8 planks; the table takes 4 of them.'),
    objective('table', 'Place a crafting table', { placed: { block: 'crafting_table' } }, 'A table is 4 planks; 8 - 4 leaves 4.'),
    objective('nether', 'Be in the Nether', { dimension: 'the_nether' }, 'Walk into the lit portal.')],
    threat_policy: CI_POLICY };
  const act = (objectiveId, rest) => ({ ...rest, objective: objectiveId });
  const script = ['not json at all', PLAN,
    act('logs', { type: 'run_skill', skill: 'resource.collect_wood', input: { count: 3 } }),
    act('planks', { type: 'primitive', name: 'craft', args: { name: 'oak_planks', count: 8 } }),
    act('table', { type: 'primitive', name: 'craft', args: { name: 'crafting_table', count: 1 } }),
    act('table', { type: 'primitive', name: 'place', args: { item: 'crafting_table', dx: 1, dy: -1, dz: 0, face: 'up' } }),
    act('nether', { type: 'run_skill', skill: 'travel.enter_nether', input: {} }),
    { type: 'done', reason: 'script_finished' }];
  let i = 0;
  const callModel = async () => {
    const next = script[Math.min(i++, script.length - 1)];
    return { text: typeof next === 'string' ? next : JSON.stringify(next),
      usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      cost_usd: 0.0004, model: `fake-${model}` };
  };
  return { arena, resolve, callModel };
}

export async function main(args = process.argv.slice(2), env = process.env, { onLine = console.log, resultsDir = path.join(here, 'results') } = {}) {
  const options = parsePlannedOptions(args, env);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(resultsDir, `planned-${stamp}.json`);
  const copyDir = localResults('planned');
  fs.mkdirSync(resultsDir, { recursive: true });
  if (options.live) fs.mkdirSync(copyDir, { recursive: true });
  const persist = (report) => {
    const json = JSON.stringify(report, null, 2) + '\n';
    fs.writeFileSync(output, json);
    if (options.live) fs.writeFileSync(path.join(copyDir, path.basename(output)), json);
  };
  let arena, callModel, resolve, closeModel = () => {};
  if (options.ci) {
    const world = createCiWorld(options);
    ({ arena, callModel, resolve } = world);
  } else {
    if (!env.A37_RCON_PASSWORD) throw new Error('rcon_password_unavailable');
    arena = await openPlannedArena(env, path.join(resultsDir, 'sessions'), options.region, options.jev);
    callModel = createCliModel({ model: options.model });
    closeModel = () => callModel.close();
  }
  const load = makeSkillLoader(resolve);
  const { candidates, skipped } = await buildCandidates(load, { allowAssists: options.allowAssists });
  const planner = createPlanner({ callModel, candidates });
  let report;
  try {
    report = await runPlanned({ arena, planner, load, username: options.username, region: options.region,
      minutes: options.minutes, model: options.model, unstuck: options.unstuck, mobWatch: options.mobWatch,
      jev: options.jev, allowAssists: options.allowAssists, resetAdvancements: options.resetAdvancements, minIntervalMs: options.ci ? 0 : MIN_INTERVAL_MS, onLine, onProgress: persist });
    report.skipped_skills = skipped;
    report.candidates = { skills: Object.keys(candidates.skills), assists: Object.keys(candidates.assists), primitives: Object.keys(candidates.primitives) };
    persist(report);
    onLine(`Wrote ${output}`);
  } finally { closeModel(); await arena.close(); }
  return { output, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(({ output, report }) => {
    console.log(`E2E summary: ${report.summary.status} results=${output}`);
    process.exitCode = report.summary.status === 'FAIL' ? 1 : 0;
  }).catch((error) => {
    console.error(`E2E summary: FAIL runner_error=${safeReason(error)}`);
    process.exitCode = 1;
  });
}
