import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { SkillRegistry } from '../skills/registry.js';
import { normalizeDimension, scoreNetherChain } from '../observation.js';
import { createLiveArena, checkCondition } from './arena.mjs';
import { runTrial } from './run.mjs';
import { createUnstuckWatchdog as makeUnstuckWatchdog } from './unstuck.mjs';
import { createMobWatchdog as makeMobWatchdog } from './mobwatch.mjs';
import { evalSeed, resultsDir as localResults } from '../e2e/local.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const USERNAME = 'Vikram_bot';
const OWNED_USERNAMES = new Set(['Ben_bot', 'Vikram_bot']);
const RUN_LIMIT_MS = 600000;
const PROTECTED_RADIUS = 20;
const countLogs = (inventory) => Object.entries(inventory ?? {}).reduce((n, [name, count]) =>
  n + (name.endsWith('_log') && Number.isFinite(count) ? count : 0), 0);
const centers = [-600, -300, 0, 300, 600].flatMap((z) =>
  [-600, -300, 0, 300, 600].map((x) => ({ x: 11000 + x, z: 5000 + z })));

export function createChainRegion(start = null) {
  if (!start) return { center: { x: 11000, z: 5000 }, radius: 950, plots: centers };
  if (![start.x, start.z].every(Number.isFinite)) throw new Error('invalid start coordinates');
  const center = { x: start.x, z: start.z };
  const plots = [center];
  for (const dz of [-240, 0, 240]) for (const dx of [-240, 0, 240]) {
    if (dx !== 0 || dz !== 0) plots.push({ x: center.x + dx, z: center.z + dz });
  }
  return { center, radius: 400, plots, protected: true };
}

const DEFAULT_REGION = createChainRegion();

export const STEPS = Object.freeze([
  { id: 'spawn', skills: [] },
  { id: 'wood', skills: ['resource.collect_wood', 'resource.collect_oak_log'] },
  { id: 'tools', skills: ['crafting.craft_wooden_pickaxe'] },
  { id: 'iron', skills: ['resource.mine_iron_ore'] },
  { id: 'obsidian', skills: [] },
  { id: 'light', skills: ['portal.light'] },
  { id: 'enter', skills: ['travel.enter_nether'] },
]);

const UNSTUCK_WATCH_STEPS = new Set(['wood', 'iron']);
const MOBWATCH_STEPS = new Set(['wood', 'iron', 'light']);

export function assertLiveSettings(env) {
  if (!['127.0.0.1', 'localhost'].includes(env.A37_MC_HOST)) {
    throw new Error('--live requires a loopback A37_MC_HOST');
  }
  if (!['127.0.0.1', 'localhost'].includes(env.A37_RCON_HOST)) {
    throw new Error('--live requires a loopback A37_RCON_HOST');
  }
  if (!OWNED_USERNAMES.has(env.A37_EVAL_USERNAME)) {
    throw new Error(`this runner owns only ${[...OWNED_USERNAMES].join(' or ')}`);
  }
  if (env.A37_EVAL_APPROVED_RESET !== '1') throw new Error('approved live reset is required');
}

function ownedUsername(env) {
  const username = env.A37_EVAL_USERNAME;
  if (!username) return USERNAME;
  if (!OWNED_USERNAMES.has(username)) {
    throw new Error(`this runner owns only ${[...OWNED_USERNAMES].join(' or ')}`);
  }
  return username;
}

function parseStart(value) {
  if (value == null) return null;
  const parts = value.split(',');
  if (parts.length !== 2 || parts.some((v) => !v.trim() || !Number.isFinite(Number(v)))) {
    throw new Error('--start must be finite X,Z plot coordinates');
  }
  return { x: Number(parts[0]), z: Number(parts[1]) };
}

export function parseOptions(args, env = process.env) {
  // parseArgs refuses a separate value that starts with '-', so --start is
  // lifted out first and accepts both '--start X,Z' and '--start=X,Z'.
  const rest = [], startArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start') {
      if (i + 1 >= args.length) throw new Error('usage: --start needs an X,Z value');
      startArgs.push(args[++i]);
    }
    else if (args[i].startsWith('--start=')) startArgs.push(args[i].slice(8));
    else rest.push(args[i]);
  }
  if (startArgs.length > 1) throw new Error('usage: --start X,Z may be given once');
  const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: {
    live: { type: 'boolean' }, ci: { type: 'boolean' }, runs: { type: 'string' },
    'no-assist': { type: 'boolean' }, 'hold-minutes': { type: 'string' },
    unstuck: { type: 'boolean' }, 'mob-watch': { type: 'boolean' },
  } });
  const start = parseStart(startArgs[0]);
  const region = createChainRegion(start);
  const username = ownedUsername(env);
  const runs = Number(values.runs);
  const holdMinutes = Number(values['hold-minutes'] ?? 0);
  if (Boolean(values.live) === Boolean(values.ci) || !Number.isInteger(runs) || runs < 1 ||
      runs > region.plots.length || !Number.isFinite(holdMinutes) ||
      holdMinutes < 0 || holdMinutes > 60) {
    throw new Error('usage: node eval/chain.mjs (--live | --ci) --runs N [--start X,Z] [--no-assist] [--hold-minutes M] [--unstuck] [--mob-watch]');
  }
  if (values.live) assertLiveSettings(env);
  return { live: Boolean(values.live), ci: Boolean(values.ci), runs,
    noAssist: Boolean(values['no-assist']), holdMinutes, start, username, region,
    unstuck: Boolean(values.unstuck), mobWatch: Boolean(values['mob-watch']) };
}

function snapshot(arena) {
  const o = arena.observe();
  return structuredClone({
    position: o.self?.position ?? o.facts?.position ?? null,
    dimension: normalizeDimension(o.dimension ?? o.facts?.dimension),
    inventory: o.inventory ?? null, health: o.self?.health ?? null,
    on_ground: o.self?.on_ground ?? null, velocity: o.self?.velocity ?? null,
    terrain: o.terrain ?? null,
    hunger: o.self?.hunger ?? null, hostiles: o.hostiles ?? [],
    recent_events: o.self?.recent_events ?? [], facts: o.facts ?? null,
  });
}

function safeReason(error, password = process.env.A37_RCON_PASSWORD) {
  const message = String(error?.message ?? error);
  return password ? message.replaceAll(password, '[redacted]') : message;
}

export function finishSummary(summary) {
  summary.nether_reached = summary.end?.dimension === 'the_nether';
  summary.status = summary.unassisted_depth === 7 && !summary.error &&
    summary.nether_reached ? 'PASS' : 'FAIL';
  const watchdog = summary.watchdog
    ? ` stuck_resets=${summary.watchdog.stuck_resets} mob_removals=${summary.watchdog.mob_removals}` : '';
  return `${summary.status} E2E run ${summary.run}: unassisted_depth=${summary.unassisted_depth}/7 first_blocker=${summary.first_blocker ? `${summary.first_blocker.step}:${summary.first_blocker.reason}` : 'none'} nether_reached=${summary.nether_reached} elapsed=${(summary.elapsed_ms / 1000).toFixed(1)}s${watchdog}`;
}

function scorerView(step, state, outcome) {
  const view = scoreNetherChain({ ...state.facts, position: state.position,
    dimension: state.dimension, inventory: state.inventory }).steps.find((s) => s.id === step);
  return { ...view, mismatch: (view.status === 'demo-ready') !== (outcome === 'success') };
}

export async function loadStep(step, registry = new SkillRegistry()) {
  for (const name of step.skills) {
    let skill;
    try { skill = registry.load(name, 1); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      return { name, outcome: 'failure', reason: `invalid_skill:${error.message}` };
    }
    try {
      if (skill.implementation?.type !== 'code' || skill.implementation.artifact !== 'index.js' ||
          skill.implementation.entry_point !== 'run') throw new Error('needs index.js exporting run');
      const limit = skill.success_check?.time_limit_ms;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2147483647) throw new Error('invalid time_limit_ms');
      checkCondition(skill.success_check.condition, {}, {});
      const filename = registry.contained(path.join(registry.directory(name, 1), 'index.js'));
      const { run } = await import(pathToFileURL(filename).href);
      if (typeof run !== 'function') throw new Error('missing run export');
      return { name, skill, run };
    } catch (error) { return { name, outcome: 'failure', reason: `invalid_skill:${error.message}` }; }
  }
  return { name: step.skills[0] ?? null, outcome: step.skills.length ? 'no_skill' : 'no_owner',
    reason: step.skills.length ? `missing_v1:${step.skills.join('|')}` : 'no_skill_or_owner_for_portal_frame' };
}

function footPosition(arena, region = DEFAULT_REGION) {
  const p = snapshot(arena).position;
  if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) throw new Error('position_unavailable');
  if (snapshot(arena).dimension !== 'overworld' ||
      Math.hypot(p.x - region.center.x, p.z - region.center.z) > region.radius) {
    throw new Error('bot_outside_approved_overworld_region');
  }
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function centerDistance(x, z, region) {
  return Math.hypot(x - region.center.x, z - region.center.z);
}

function rectCenterDistance(x1, z1, x2, z2, region) {
  const cx = Math.max(Math.min(x1, x2), Math.min(region.center.x, Math.max(x1, x2)));
  const cz = Math.max(Math.min(z1, z2), Math.min(region.center.z, Math.max(z1, z2)));
  return Math.hypot(cx - region.center.x, cz - region.center.z);
}

function needsRelocation(x1, z1, x2, z2, region) {
  return [[x1, z1], [x1, z2], [x2, z1], [x2, z2]].some(([x, z]) => centerDistance(x, z, region) > region.radius) ||
    region.protected && rectCenterDistance(x1, z1, x2, z2, region) < PROTECTED_RADIUS;
}

function allowedPosition(position, region) {
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return false;
  const distance = centerDistance(position.x, position.z, region);
  return distance <= region.radius && !(region.protected && distance < PROTECTED_RADIUS);
}

function relocationPlan(context, p) {
  const username = context.username ?? USERNAME;
  const pad = { x: Math.floor(context.region.center.x) + 40, y: p.y,
    z: Math.floor(context.region.center.z) };
  return {
    p: { x: pad.x, y: pad.y + 1, z: pad.z },
    commands: [
      `fill ${pad.x - 3} ${pad.y} ${pad.z - 4} ${pad.x + 5} ${pad.y} ${pad.z + 4} minecraft:stone`,
      `fill ${pad.x - 3} ${pad.y + 1} ${pad.z - 4} ${pad.x + 5} ${pad.y + 6} ${pad.z + 4} minecraft:air`,
      `tp ${username} ${pad.x} ${pad.y + 1} ${pad.z}`,
    ],
  };
}

function stagePlan(step, arena, context) {
  const region = context.region ?? DEFAULT_REGION;
  const username = context.username ?? USERNAME;
  const p0 = footPosition(arena, region);
  const block = { wood: 'oak_log', iron: 'iron_ore' }[step];
  let p = p0, relocate = [];
  if (block && needsRelocation(p0.x + 3, p0.z, p0.x + 3, p0.z, region)) {
    const moved = relocationPlan(context, p0);
    relocate = moved.commands;
    p = moved.p;
  }
  const position = { x: p.x + 3, y: p.y, z: p.z };
  const setblock = block && `setblock ${position.x} ${position.y} ${position.z} minecraft:${block}`;
  const f = context.frame;
  const front = f && `${f.x + 1.5} ${f.y + 1} ${f.z - 2}`;
  const stages = {
    wood: [setblock],
    tools: [`give ${username} minecraft:oak_log 3`],
    iron: [`item replace entity ${username} hotbar.0 with minecraft:stone_pickaxe`,
      setblock],
    light: f ? [`item replace entity ${username} hotbar.0 with minecraft:flint_and_steel`,
      `tp ${username} ${front}`] : [],
    enter: f ? [`tp ${username} ${front}`] : [],
  };
  return { commands: [...relocate, ...(stages[step] ?? [])], target: block ? { position, block } : null };
}

function acceptedStageCommand(command, reply, username = USERNAME) {
  if (typeof reply !== 'string') return false;
  if (command.startsWith('fill ')) return /^Successfully filled \d+ blocks?/.test(reply) || reply === 'No blocks were filled';
  const setblock = command.match(/^setblock (-?\d+) (-?\d+) (-?\d+) /);
  if (setblock) return reply.includes(`Changed the block at ${setblock[1]}, ${setblock[2]}, ${setblock[3]}`);
  if (command.startsWith('give ')) return /Gave \d+ \[/.test(reply) && reply.includes(`to ${username}`);
  if (command.startsWith('item replace ')) return reply.includes(`Replaced a slot on ${username} with`);
  if (command.startsWith('tp ')) return reply.includes(`Teleported ${username} to`);
  return false;
}

async function observeStageTarget(arena, stage, phase, deadline) {
  const { target, verification } = stage;
  for (;;) {
    const state = snapshot(arena);
    const block = arena.inspectBlock?.(target.position) ?? { loaded: false, name: null };
    const fact = state.facts?.nearest_blocks?.[target.block] ?? null;
    const origin = state.facts?.position;
    const selected = origin && fact && ['x', 'y', 'z'].every((axis) =>
      Math.round(origin[axis] + fact[`d${axis}`]) === target.position[axis]);
    const sample = { phase, at: new Date().toISOString(), block, fact, facts_position: origin,
      position: state.position };
    verification.sample_count++;
    if (verification.samples.length < 64) verification.samples.push(sample);
    else verification.samples[63] = sample;
    if (block.loaded && (phase === 'before_command' || block.name === target.block && selected)) return null;
    if (performance.now() >= deadline) {
      return !block.loaded ? 'target_chunk_not_loaded' : block.name !== target.block ? 'block_not_observed' : 'target_not_in_facts';
    }
    const ms = Math.max(1, Math.min(100, deadline - performance.now()));
    if (arena.settle) await arena.settle(ms);
    else await delay(ms);
  }
}

function grantCommands(step, arena, context) {
  const region = context.region ?? DEFAULT_REGION;
  const username = context.username ?? USERNAME;
  if (step === 'obsidian') {
    let p = footPosition(arena, region), relocate = [];
    const frameFor = (at) => ({ x: at.x + 5, y: at.y - 1, z: at.z });
    let f = frameFor(p);
    if (needsRelocation(f.x - 2, f.z - 4, f.x + 5, f.z + 4, region)) {
      const moved = relocationPlan(context, p);
      relocate = moved.commands;
      p = moved.p;
      f = frameFor(p);
    }
    context.frame = f;
    const { x, y, z } = f;
    return [
      ...relocate,
      `fill ${x - 2} ${y} ${z - 4} ${x + 5} ${y} ${z + 4} minecraft:stone`,
      `fill ${x - 2} ${y + 1} ${z - 4} ${x + 5} ${y + 6} ${z + 4} minecraft:air`,
      `fill ${x} ${y} ${z} ${x + 3} ${y + 4} ${z} minecraft:obsidian`,
      `fill ${x + 1} ${y + 1} ${z} ${x + 2} ${y + 3} ${z} minecraft:air`,
    ];
  }
  const f = context.frame;
  return ({
    wood: [`give ${username} minecraft:oak_log 5`],
    tools: [`item replace entity ${username} hotbar.0 with minecraft:stone_pickaxe`],
    iron: [`give ${username} minecraft:iron_ingot 7`],
    light: f ? [`fill ${f.x + 1} ${f.y + 1} ${f.z} ${f.x + 2} ${f.y + 3} ${f.z} minecraft:nether_portal[axis=x]`] : [],
  })[step] ?? [];
}

function classify(natural, staged) {
  if (staged?.failure_type === 'stage_setup') return 'stage_setup';
  if (['no_skill', 'no_owner'].includes(natural.outcome)) return 'missing_work';
  if (natural.outcome === 'success') return 'natural_pass';
  if (staged?.outcome === 'success') return 'finding_or_navigation';
  return staged ? 'skill_or_action' : 'natural_blocker';
}

function checkMutation(command, region) {
  const parts = command.split(' ');
  if (!['fill', 'setblock'].includes(parts[0])) return;
  const [x1, , z1, x2 = x1, , z2 = z1] = parts.slice(1, parts[0] === 'fill' ? 7 : 4).map(Number);
  for (const x of [x1, x2]) for (const z of [z1, z2]) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || centerDistance(x, z, region) > region.radius) {
      throw new Error('mutation_outside_approved_region');
    }
  }
  if (region.protected && rectCenterDistance(x1, z1, x2, z2, region) < PROTECTED_RADIUS) {
    throw new Error('mutation_inside_protected_portal_radius');
  }
}

export async function prepareChainRun(arena, { previous = [], journal = [], username = USERNAME,
  region = DEFAULT_REGION, readinessTimeoutMs = 15000, deadline = performance.now() + RUN_LIMIT_MS } = {}) {
  if (!OWNED_USERNAMES.has(username)) throw new Error('this runner owns only Ben_bot or Vikram_bot');
  let stopped = null;
  const failure = (reason) => { stopped = reason; };
  const human = () => failure('human_takeover');
  arena.events?.on('failure', failure);
  arena.events?.on('human_takeover', human);
  const check = () => {
    if (stopped) throw new Error(stopped);
    if (arena.arbiter?.sources.has('human')) throw new Error('human_takeover');
    if (performance.now() >= deadline) throw new Error('run_time_limit');
  };
  const send = async (command) => {
    check();
    if (performance.now() + (arena.commandBudgetMs ?? 0) >= deadline) throw new Error('run_time_limit');
    const entry = { command };
    journal.push(entry);
    entry.reply = await arena.command(command);
    check();
    return entry;
  };
  try {
    await send(`gamemode survival ${username}`);
    await send(`clear ${username}`);
    for (const c of region.plots) {
      if (previous.some((p) => Math.hypot(c.x - p.x, c.z - p.z) < 236)) continue;
      const entry = await send(`execute in minecraft:overworld run spreadplayers ${c.x} ${c.z} 0 25 false ${username}`);
      entry.accepted = /^(?:Spread 1 player\(s\) around |Successfully spread 1 )/.test(entry.reply);
      if (!entry.accepted) { entry.reason = 'spreadplayers_rejected'; continue; }
      const readyBy = Math.min(deadline, performance.now() + readinessTimeoutMs);
      let ready = false;
      do {
        check();
        const state = snapshot(arena), p = state.position;
        if (state.health != null && state.health <= 0) throw new Error('bot_death');
        ready = p && state.on_ground && state.dimension === 'overworld' && state.health > 0 &&
          Math.hypot(p.x - c.x, p.z - c.z) <= 36 &&
          state.inventory != null && Object.keys(state.inventory).length === 0 &&
          previous.every((v) => Math.hypot(p.x - v.x, p.z - v.z) >= 200);
        if (ready) break;
        await arena.settle(Math.max(1, Math.min(100, readyBy - performance.now())));
      } while (performance.now() < readyBy);
      entry.observed = Boolean(ready);
      if (!ready) { entry.reason = 'spreadplayers_position_unverified'; continue; }
      footPosition(arena, region);
      await send(`data get entity ${username} playerGameType`);
      if (arena.gameMode() !== 'survival') throw new Error('survival_mode_not_observed');
      const started = performance.now();
      let timer;
      try {
        await Promise.race([arena.waitForChunks(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('run_setup_chunks_not_loaded')),
            Math.max(1, Math.min(15000, deadline - performance.now())));
        })]);
      } finally { clearTimeout(timer); }
      check();
      await arena.settle(Math.min(550, Math.max(1, deadline - performance.now())));
      check();
      return { chunks_loaded: true, waited_ms: Math.round(performance.now() - started),
        facts_settle_ms: 550, support: arena.inspectBlock(footPosition(arena, region)) };
    }
    throw new Error('no_safe_approved_plot');
  } finally {
    arena.events?.off('failure', failure);
    arena.events?.off('human_takeover', human);
  }
}

export async function runChain({ arena, runs = 1, noAssist = false,
  username = USERNAME, region = DEFAULT_REGION,
  resolveSkill = (step) => loadStep(step), runLimitMs = RUN_LIMIT_MS,
  stageTimeoutMs = 5000, previousPositions = [], onProgress = () => {}, onSummary = console.log,
  unstuck = false, mobWatch = false,
  createUnstuckWatchdog = makeUnstuckWatchdog, createMobWatchdog = makeMobWatchdog } = {}) {
  if (!OWNED_USERNAMES.has(username)) throw new Error('this runner owns only Ben_bot or Vikram_bot');
  const report = { synthetic: arena.synthetic, seed: arena.synthetic ? null : evalSeed(),
    username, region, started_at: new Date().toISOString(), run_limit_ms: runLimitMs,
    rows: [], runs: [], tick_samples: [], events: [], limitations: [
      'Stages and grants never establish a natural pass.',
      'Natural attempts after assistance retain upstream_assisted=true.',
      'Obsidian has no owner; tools, iron, light, and enter may have no installed v1.',
      'The scorer estimates readiness and can overstate obsidian and light.',
      'Fresh plots exclude earlier live starts recorded in retained local chain reports.',
      'A synchronous skill that blocks Node requires the launcher timeout to terminate it.',
    ] };
  const watchdogDeps = {
    observe: () => arena.observe(),
    blockAt: typeof arena.blockAt === 'function' ? (x, y, z) => arena.blockAt(x, y, z) : () => null,
    runCommand: (command) => arena.command(command),
    resolveUuid: typeof arena.resolveUuid === 'function' ? (mob) => arena.resolveUuid(mob) : () => null,
    username,
    isAllowedPosition: (position) => allowedPosition(position, region),
  };
  let activeRun = null, terminalFailure = null, tickPending = null;
  const failure = (reason) => {
    report.events.push({ at: new Date().toISOString(), run: activeRun, reason });
    terminalFailure = reason;
  };
  arena.events.on('failure', failure);
  const humanTakeover = () => failure('human_takeover');
  arena.events.on('human_takeover', humanTakeover);
  const sampleTicks = async () => {
    const sample = { at: new Date().toISOString(), run: activeRun, command: 'tick query' };
    try { sample.reply = await arena.command('tick query'); }
    catch (error) { sample.error = safeReason(error); failure('rcon_unavailable'); }
    report.tick_samples.push(sample);
    await onProgress(report);
  };
  const timer = setInterval(() => {
    if (!tickPending) tickPending = sampleTicks().finally(() => { tickPending = null; });
  }, 30000);
  const previous = [...previousPositions];
  try {
    for (let run = 1; run <= runs; run++) {
      if (terminalFailure && terminalFailure !== 'bot_death') {
        const reason = `not_started:${terminalFailure}`;
        const summary = { run, unassisted_depth: 0, first_blocker: { step: 'spawn', reason },
          elapsed_ms: 0, completed: false,
          ...(unstuck || mobWatch ? { watchdog: { stuck_resets: 0, mob_removals: 0 } } : {}) };
        report.runs.push(summary);
        report.rows.push({ run, step: 'spawn', skill: null, attempt: 'natural', outcome: 'failure', reason,
          elapsed_ms: 0, rcon_commands: [], before: null, after: null, scorer: null });
        onSummary(finishSummary(summary));
        continue;
      }
      terminalFailure = null;
      activeRun = run;
      const started = performance.now(), deadline = started + runLimitMs;
      const context = { frame: null, username, region };
      const summary = { run, unassisted_depth: 0, first_blocker: null, setup_commands: [],
        assisted: false, findings: [], completed: false };
      report.runs.push(summary);
      const runWatchdogs = [];
      if (unstuck) runWatchdogs.push({ steps: UNSTUCK_WATCH_STEPS, type: 'stuck_reset',
        counter: 'stuck_resets', seen: 0, watchdog: createUnstuckWatchdog(watchdogDeps) });
      if (mobWatch) runWatchdogs.push({ steps: MOBWATCH_STEPS, type: 'mob_removed',
        counter: 'mob_removals', seen: 0, watchdog: createMobWatchdog(watchdogDeps) });
      if (runWatchdogs.length) summary.watchdog = { stuck_resets: 0, mob_removals: 0 };
      let currentRow = null;
      try {
        summary.setup_readiness = await arena.prepare(run, previous, summary.setup_commands, deadline);
        summary.start = snapshot(arena);
        previous.push(summary.start.position);
        await sampleTicks();
        for (const step of STEPS) {
          const loaded = step.id === 'spawn' ? null : await resolveSkill(step);
          const attemptBody = async (kind, plan, row) => {
            const { commands, target } = plan;
            const at = performance.now();
            let stageError = null;
            if (commands.length) {
              const stage = { kind: 'stage', before: snapshot(arena), commands: [], target,
                verification: { samples: [], sample_count: 0 }, status: 'pending' };
              row.assistance.push(stage);
              const stageDeadline = Math.min(deadline, performance.now() + stageTimeoutMs);
              if (target) stageError = await observeStageTarget(arena, stage, 'before_command', stageDeadline);
              for (const command of stageError ? [] : commands) {
                checkMutation(command, region);
                if (terminalFailure) throw new Error(terminalFailure);
                if (performance.now() + (arena.commandBudgetMs ?? 0) >= deadline) throw new Error('run_time_limit');
                row.rcon_commands.push(command);
                const entry = { command };
                stage.commands.push(entry);
                entry.reply = await arena.command(command);
                entry.accepted = acceptedStageCommand(command, entry.reply, username);
                if (!entry.accepted) { stageError = 'command_rejected'; break; }
              }
              if (!stageError && target) stageError = await observeStageTarget(arena, stage, 'after_command', stageDeadline);
              else if (!stageError) await arena.settle?.();
              stage.after = snapshot(arena);
              stage.status = stageError ? 'failed' : 'ready';
              stage.reason = stageError ?? 'stage_observed';
              summary.assisted = true;
            }
            row.attempt_before = snapshot(arena);
            row.assisted = summary.assisted;
            if (arena.arbiter?.sources.has('human')) terminalFailure = 'human_takeover';
            if (stageError) Object.assign(row, { outcome: 'failure', failure_type: 'stage_setup', reason: `stage_failed:${stageError}` });
            else if (performance.now() >= deadline) Object.assign(row, { outcome: 'timeout', reason: 'run_time_limit' });
            else if (terminalFailure) Object.assign(row, { outcome: 'failure', reason: terminalFailure });
            else if (step.id === 'spawn') {
              const f = arena.observe().facts;
              const valid = f?.position && [f.position.x, f.position.y, f.position.z].every(Number.isFinite) &&
                ['overworld', 'the_nether', 'the_end'].includes(normalizeDimension(f.dimension));
              Object.assign(row, { outcome: valid ? 'success' : 'failure', reason: valid ? 'position_and_dimension_known' : 'spawn_facts_unavailable' });
            } else if (loaded.run) {
              const remaining = Math.max(1, Math.floor(deadline - performance.now()));
              const skill = { ...loaded.skill, success_check: { ...loaded.skill.success_check,
                time_limit_ms: Math.min(loaded.skill.success_check.time_limit_ms, remaining) } };
              const input = { ...loaded.skill.requirements?.input };
              if (step.id === 'light') input.frame = context.frame;
              if (step.id === 'iron') delete input.descent;
              if (step.id === 'wood' && loaded.name === 'resource.collect_wood' && kind === 'staged') {
                input.count = countLogs(row.attempt_before.inventory) + 1;
              }
              row.input = input;
              const continuous = { ...arena, reset: async () => {}, observe: () => {
                const observation = arena.observe();
                if (step.id === 'wood') observation.wood = { goal_reached: observation.inventory != null &&
                  countLogs(observation.inventory) >= (input.count ?? 5) };
                return observation;
              } };
              const trial = await runTrial({ arena: continuous, skill, run: (...args) => {
                row.skill_started = true;
                return loaded.run(...args);
              },
                input, trial: run });
              Object.assign(row, { outcome: trial.outcome, reason: trial.reason });
              if (row.outcome === 'success' && step.id === 'light' && !await arena.portalLit(context.frame)) {
                Object.assign(row, { outcome: 'failure', reason: 'frame_interior_not_lit' });
              }
              if (row.outcome === 'success' && step.id === 'enter' && snapshot(arena).dimension !== 'the_nether') {
                Object.assign(row, { outcome: 'failure', reason: 'not_in_the_nether' });
              }
            } else Object.assign(row, { outcome: loaded.outcome, reason: loaded.reason });
            row.after = snapshot(arena);
            row.scorer = scorerView(step.id, row.after, row.outcome);
            row.elapsed_ms = Math.round(performance.now() - at);
            row.frame = context.frame && { ...context.frame };
            report.rows.push(row);
            currentRow = null;
            await onProgress(report);
            return row;
          };
          const attempt = async (kind, plan = { commands: [] }) => {
            const row = { run, step: step.id, skill: loaded?.name ?? null, version: loaded?.skill?.version ?? null,
              attempt: kind, upstream_assisted: summary.assisted, outcome: 'failure', reason: 'attempt_incomplete',
              started_at: new Date().toISOString(), elapsed_ms: 0,
              skill_started: false,
              rcon_commands: [], assistance: [], before: snapshot(arena) };
            currentRow = row;
            const armedWatchdogs = runWatchdogs.filter((w) => w.steps.has(step.id));
            let watchdogTimer = null, watchdogTicks = [];
            if (armedWatchdogs.length) {
              for (const w of armedWatchdogs) w.watchdog.arm(step.id);
              watchdogTimer = setInterval(() => {
                // A watchdog tick must never crash or stall the run.
                watchdogTicks = armedWatchdogs.map((w) =>
                  Promise.resolve().then(() => w.watchdog.tick()).catch(() => {}));
              }, 250);
            }
            try {
              return await attemptBody(kind, plan, row);
            } finally {
              if (watchdogTimer) {
                clearInterval(watchdogTimer);
                for (const w of armedWatchdogs) w.watchdog.disarm();
                await Promise.allSettled(watchdogTicks);
                for (const w of armedWatchdogs) {
                  const events = w.watchdog.events ?? [];
                  const fresh = events.slice(w.seen);
                  w.seen = events.length;
                  for (const event of fresh) {
                    if (event.rcon_reply == null) continue;
                    row.assistance.push({ type: w.type, ...event });
                    row.watchdog_assisted = true;
                    summary.assisted = true;
                    summary.watchdog[w.counter]++;
                  }
                }
              }
            }
          };
          const natural = await attempt('natural');
          if (!summary.first_blocker && natural.outcome === 'success') {
            if (natural.watchdog_assisted) {
              summary.first_blocker = { step: step.id, reason: 'watchdog_assist', outcome: 'assisted' };
            } else summary.unassisted_depth++;
          }
          if (natural.outcome !== 'success') {
            summary.first_blocker ??= { step: step.id, reason: natural.reason, outcome: natural.outcome };
            if (noAssist || terminalFailure || performance.now() >= deadline) break;
            const staged = await attempt('staged', stagePlan(step.id, arena, context));
            summary.findings.push({ step: step.id, classification: classify(natural, staged) });
            if (terminalFailure || performance.now() >= deadline) break;
            if (staged.outcome !== 'success') {
              const commands = grantCommands(step.id, arena, context);
              if (commands.length) {
                const grant = { kind: 'grant', before: snapshot(arena), commands: [] };
                staged.assistance.push(grant);
                for (const command of commands) {
                  checkMutation(command, region);
                  if (terminalFailure) throw new Error(terminalFailure);
                  if (performance.now() + (arena.commandBudgetMs ?? 0) >= deadline) throw new Error('run_time_limit');
                  staged.rcon_commands.push(command);
                  grant.commands.push({ command, reply: await arena.command(command) });
                }
                await arena.settle?.();
                grant.after = snapshot(arena);
                grant.scorer = scorerView(step.id, grant.after, staged.outcome);
                staged.frame = context.frame && { ...context.frame };
                summary.assisted = true;
                await onProgress(report);
              }
            }
          }
          if (step.id === 'enter') summary.completed = true;
        }
      } catch (error) {
        const outcome = error.message === 'run_time_limit' ? 'timeout' : 'failure';
        if (currentRow) {
          Object.assign(currentRow, { outcome, reason: safeReason(error), after: snapshot(arena),
            elapsed_ms: Date.now() - Date.parse(currentRow.started_at) });
          currentRow.scorer = scorerView(currentRow.step, currentRow.after, outcome);
          report.rows.push(currentRow);
        } else if (!report.rows.some((row) => row.run === run)) {
          report.rows.push({ run, step: 'spawn', skill: null, attempt: 'natural', outcome,
            reason: safeReason(error), elapsed_ms: Math.round(performance.now() - started),
            rcon_commands: summary.setup_commands.map((entry) => entry.command),
            before: null, after: snapshot(arena), scorer: null });
        }
        summary.error = safeReason(error);
        summary.first_blocker ??= { step: currentRow?.step ?? 'spawn', outcome, reason: safeReason(error) };
        if (/rcon|bot_(?:end|error|kicked)/.test(error.message)) terminalFailure = error.message;
      } finally {
        arena.release();
        summary.end = snapshot(arena);
        summary.frame = context.frame;
        summary.elapsed_ms = Math.round(performance.now() - started);
        onSummary(finishSummary(summary));
        await onProgress(report);
      }
    }
  } finally {
    clearInterval(timer);
    await tickPending;
    arena.events.off('failure', failure);
    arena.events.off('human_takeover', humanTakeover);
    report.finished_at = new Date().toISOString();
    report.passed = report.runs.length === runs && report.runs.every((r) => r.status === 'PASS');
    report.requested_runs = runs;
    await onProgress(report);
  }
  return report;
}

export function createChainCiArena({ region = DEFAULT_REGION, username = USERNAME } = {}) {
  let state, resetCalls = 0;
  const commands = [], blocks = new Map();
  const arena = {
    synthetic: true, events: new EventEmitter(), commands,
    get resetCalls() { return resetCalls; },
    observe: () => structuredClone(state),
    async reset() { resetCalls++; throw new Error('chain_must_not_reset_skills'); },
    async prepare(run) {
      blocks.clear();
      state = { self: { position: { x: region.plots[run - 1].x, y: 70, z: region.plots[run - 1].z }, health: 20, on_ground: true },
        dimension: 'overworld', inventory: {}, facts: { dimension: 'overworld', nearest_blocks: {} } };
      state.facts.position = state.self.position;
      return [];
    },
    inspectBlock: (position) => ({ position, loaded: true,
      name: blocks.get(JSON.stringify(position)) ?? 'air' }),
    async command(command) {
      commands.push(command);
      if (command === 'tick query') return 'Synthetic tick sample; no server measurement';
      const gift = command.match(/minecraft:(oak_log|iron_ingot) (\d+)$/);
      if (command.startsWith('give ') && gift) {
        state.inventory[gift[1]] = (state.inventory[gift[1]] ?? 0) + Number(gift[2]);
        return `Gave ${gift[2]} [${gift[1]}] to ${username}`;
      }
      if (command.startsWith('item replace ')) {
        const item = command.split('minecraft:')[1];
        state.inventory[item] = 1;
        return `Replaced a slot on ${username} with [${item}]`;
      }
      const block = command.match(/^setblock (-?\d+) (-?\d+) (-?\d+) minecraft:(\w+)$/);
      if (block) {
        const p = { x: Number(block[1]), y: Number(block[2]), z: Number(block[3]) };
        blocks.set(JSON.stringify(p), block[4]);
        const self = state.self.position;
        state.facts.nearest_blocks[block[4]] = { type: block[4], dx: p.x - self.x, dy: p.y - self.y, dz: p.z - self.z };
        return `Changed the block at ${p.x}, ${p.y}, ${p.z}`;
      }
      if (command.startsWith('tp ')) {
        const [, , x, y, z] = command.split(' ');
        state.self.position = { x: Number(x), y: Number(y), z: Number(z) };
        state.facts.position = state.self.position;
        return `Teleported ${username} to staged position`;
      }
      if (command.includes('minecraft:obsidian')) state.facts.nearest_blocks.obsidian = { type: 'obsidian' };
      if (command.includes('minecraft:nether_portal')) state.facts.nearest_blocks.nether_portal = { type: 'nether_portal' };
      return command.startsWith('fill ') ? 'Successfully filled 1 blocks' : 'Synthetic command accepted';
    },
    async portalLit() { return Boolean(state.facts.nearest_blocks.nether_portal); },
    release() {}, close() {},
    bot: (signal) => Object.freeze({ observe: () => arena.observe(),
      requestAction(action) {
        signal.throwIfAborted();
        if (action.dig && blocks.get(JSON.stringify(action.dig)) === 'oak_log') {
          blocks.delete(JSON.stringify(action.dig));
          delete state.facts.nearest_blocks.oak_log;
          state.inventory.oak_log = (state.inventory.oak_log ?? 0) + 1;
        }
      }, releaseControls() {} }),
  };
  return arena;
}

async function liveArena(env, dataDir, region = DEFAULT_REGION) {
  assertLiveSettings(env);
  process.env.AGENT37_JEV = '0';
  const { createRuntime } = await import('../server.js');
  const { rconCommand } = await import('../rcon.js');
  const { Vec3 } = await import('vec3');
  let runtime;
  const arena = await createLiveArena({ expectedSeed: evalSeed(), env, dataDir,
    skill: { requirements: {} }, runtimeFactory: async (config) => {
      runtime = await createRuntime({ ...config, viewerPort: 3744 });
      return runtime;
    } });
  arena.command = (command) => rconCommand({ host: env.A37_RCON_HOST, port: Number(env.A37_RCON_PORT),
    password: env.A37_RCON_PASSWORD, timeoutMs: 10000 }, command);
  arena.commandBudgetMs = 10000;
  arena.settle = (ms = 700) => delay(ms);
  arena.inspectBlock = (position) => {
    const block = runtime.bot.blockAt(new Vec3(position.x, position.y, position.z));
    const column = runtime.bot.world?.getColumnAt(new Vec3(position.x, 0, position.z));
    const below = runtime.bot.blockAt(new Vec3(position.x, position.y - 1, position.z));
    const above = runtime.bot.blockAt(new Vec3(position.x, position.y + 1, position.z));
    return { position, chunk: { x: Math.floor(position.x / 16), z: Math.floor(position.z / 16) },
      loaded: Boolean(column && block), name: block?.name ?? null, state_id: block?.stateId ?? null,
      bounding_box: block?.boundingBox ?? null, below: below?.name ?? null, above: above?.name ?? null };
  };
  arena.portalLit = async (frame) => {
    if (!frame) return false;
    for (let dx = 1; dx <= 2; dx++) for (let dy = 1; dy <= 3; dy++) {
      if (runtime.bot.blockAt(new Vec3(frame.x + dx, frame.y + dy, frame.z))?.name !== 'nether_portal') return false;
    }
    return true;
  };
  arena.gameMode = () => runtime.bot.game?.gameMode;
  arena.waitForChunks = () => runtime.bot.waitForChunksToLoad();
  arena.blockAt = (x, y, z) => runtime.bot?.blockAt?.(new Vec3(x, y, z)) ?? null;
  arena.resolveUuid = (mob) => runtime.bot?.entities?.[mob?.id]?.uuid ?? null;
  arena.prepare = (run, previous, journal, deadline) => prepareChainRun(arena, {
    previous, journal, deadline, username: env.A37_EVAL_USERNAME, region,
  });
  return arena;
}

export async function holdArena(arena, report, holdMinutes, {
  persist = () => {}, onMessage = console.log,
} = {}) {
  report.hold = { pid: process.pid, dimension: snapshot(arena).dimension, started_at: new Date().toISOString(),
    until: new Date(Date.now() + holdMinutes * 60000).toISOString(), status: 'holding' };
  persist(report);
  onMessage(`Holding ${report.username ?? USERNAME} idle for ${holdMinutes} minutes; pid=${process.pid}`);
  const stop = new AbortController();
  const disconnected = (reason) => {
    report.events.push({ at: new Date().toISOString(), run: null, reason });
    if (/bot_(?:death|end|error|kicked)|human_takeover/.test(reason)) {
      report.hold.failure_reason = reason;
      report.passed = false;
      stop.abort();
    }
    persist(report);
  };
  const humanTakeover = () => disconnected('human_takeover');
  arena.events.on('failure', disconnected);
  arena.events.on('human_takeover', humanTakeover);
  try { await delay(holdMinutes * 60000, undefined, { signal: stop.signal }); }
  catch (error) { if (error.name !== 'AbortError') throw error; }
  finally {
    arena.events.off('failure', disconnected);
    arena.events.off('human_takeover', humanTakeover);
    report.hold.status = stop.signal.aborted ? 'interrupted' : 'finished';
    persist(report);
    if (stop.signal.aborted) onMessage(`E2E summary: FAIL hold_interrupted=${report.hold.failure_reason}`);
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args, env);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = path.join(here, 'results');
  const output = path.join(resultsDir, `chain-${stamp}.json`);
  const copyDir = localResults('chain');
  fs.mkdirSync(resultsDir, { recursive: true });
  if (options.live) fs.mkdirSync(copyDir, { recursive: true });
  const persist = (report) => {
    const json = JSON.stringify(report, null, 2) + '\n';
    fs.writeFileSync(output, json);
    if (options.live) fs.writeFileSync(path.join(copyDir, path.basename(output)), json);
  };
  let arena, previousPositions = [];
  try {
    if (options.live) {
      for (const name of fs.readdirSync(resultsDir).filter((name) => /^chain-.*\.json$/.test(name))) {
        let old;
        try { old = JSON.parse(fs.readFileSync(path.join(resultsDir, name), 'utf8')); }
        catch { throw new Error(`history_report_unreadable:${name}`); }
        if (old.synthetic !== false || old.username !== options.username || old.seed !== evalSeed()) continue;
        previousPositions.push(...old.runs.map((r) => r.start?.position).filter((p) =>
          p && [p.x, p.y, p.z].every(Number.isFinite)));
      }
    }
    if (options.live && !env.A37_RCON_PASSWORD) throw new Error('rcon_password_unavailable');
    arena = options.ci ? createChainCiArena(options) : await liveArena(env, path.join(resultsDir, 'sessions'), options.region);
  } catch (error) {
    const reason = `startup_error:${safeReason(error, env.A37_RCON_PASSWORD)}`;
    const report = { synthetic: options.ci, passed: false, requested_runs: options.runs,
      startup_error: reason, rows: [], runs: [], tick_samples: [], events: [] };
    for (let run = 1; run <= options.runs; run++) {
      const summary = { run, unassisted_depth: 0, first_blocker: { step: 'spawn', reason }, elapsed_ms: 0 };
      report.runs.push(summary);
      report.rows.push({ run, step: 'spawn', skill: null, attempt: 'natural', outcome: 'failure', reason,
        elapsed_ms: 0, rcon_commands: [], before: null, after: null, scorer: null });
      console.log(finishSummary(summary));
    }
    persist(report);
    console.log(`E2E summary: FAIL runs=${options.runs}/${options.runs} natural_passes=0 results=${output}`);
    return { output, report };
  }
  let report;
  try {
    report = await runChain({ arena, runs: options.runs, noAssist: options.noAssist,
      username: options.username, region: options.region,
      unstuck: options.unstuck, mobWatch: options.mobWatch,
      resolveSkill: options.ci ? (step) => ({ name: step.skills[0] ?? null,
        outcome: step.skills.length ? 'no_skill' : 'no_owner', reason: 'synthetic_missing_fixture' }) : undefined,
      previousPositions, onProgress: persist });
    console.log(`Wrote ${output}`);
    console.log(`E2E summary: ${report.passed ? 'PASS' : 'FAIL'} runs=${report.runs.length}/${options.runs} natural_passes=${report.runs.filter((r) => r.status === 'PASS').length} results=${output}`);
    if (options.live && options.holdMinutes > 0 &&
        !report.events.some((e) => /bot_(?:end|error|kicked)|human_takeover|rcon/.test(e.reason)) &&
        !report.runs.some((r) => /rcon/.test(r.error ?? '')) &&
        report.runs.at(-1)?.start &&
        report.runs.at(-1)?.end?.health > 0) {
      await holdArena(arena, report, options.holdMinutes, { persist });
    }
  } finally { await arena.close(); }
  return { output, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(({ report }) => { process.exitCode = report.passed ? 0 : 1; }).catch((error) => {
    console.error(`E2E summary: FAIL runner_error=${safeReason(error)}`);
    process.exitCode = 1;
  });
}
