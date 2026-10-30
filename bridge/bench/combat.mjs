// node bridge/bench/combat.mjs --ci [--scripted | --candidate DIR] [--target skeleton]
// Live: --candidate DIR or --scripted, plus J1's A37_MC_*, A37_RCON_*,
// A37_EVAL_USERNAME and A37_EVAL_APPROVED_RESET=1 environment settings.
// No activation or skill.json writes. CI evidence is always synthetic.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const RESULTS = path.join(here, 'results');
const J1_REF = 'origin/combat-kill-hostile-skill';
const SEED = 37001, TRIALS = 20, TARGET = 16, LIMIT_MS = 60000;
const CI_AT = '2000-01-01T00:00:00.000Z';
const SUCCESS = 'Selected target death, bot alive, no human intervention or safety violation.';
const BOT_POSITION = { x: .5, y: 64, z: .5 };
const MOB_POSITION = { x: 4.5, y: 64, z: .5 };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parseOptions(args) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    ci: { type: 'boolean' }, live: { type: 'boolean' }, scripted: { type: 'boolean' },
    candidate: { type: 'string' }, target: { type: 'string', default: 'zombie' },
  } });
  if ((values.ci && values.live) || (values.scripted && values.candidate) ||
      (!values.ci && !values.scripted && !values.candidate) ||
      !['zombie', 'skeleton'].includes(values.target)) {
    throw new Error('usage: combat.mjs [--ci | --live] (--candidate DIR | --scripted) [--target zombie|skeleton]; --ci alone uses a synthetic template');
  }
  return { ...values, ci: Boolean(values.ci), fighter: values.scripted ? 'scripted' : 'candidate' };
}

function loadJ1() {
  // Read the locally available remote ref without checking out, merging, or
  // patching J1. Keep an exact, ignored snapshot so its relative imports work.
  const git = (...args) => execFileSync('git', args, { cwd: repo, maxBuffer: 4 * 1024 * 1024 });
  const revision = git('rev-parse', '--verify', `${J1_REF}^{commit}`).toString().trim();
  const root = path.join(repo, 'bridge/work/combat-j1', revision);
  const files = ['bridge/package.json', 'bridge/arbiter.js', 'bridge/skills/registry.js',
    'bridge/eval/summary.js', 'bridge/eval/arena.mjs', 'bridge/eval/run.mjs'];
  for (const filename of files) {
    const bytes = git('show', `${revision}:${filename}`);
    const destination = path.join(root, filename);
    if (fs.existsSync(destination)) {
      if (!fs.readFileSync(destination).equals(bytes)) throw new Error(`J1 snapshot changed: ${filename}`);
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { flag: 'wx' });
    }
  }
  return { root, revision };
}

function template(fighter) {
  // Standalone --ci and the scripted baseline need no real model artifact.
  return { name: 'combat.engage', version: fighter === 'scripted' ? 'scripted-v1' : 'ci-fixture-v1',
    implementation: { type: fighter === 'scripted' ? 'code' : 'synthetic' },
    requirements: { combat: true, ci_only: fighter !== 'scripted', input: {} },
    success_check: { success: SUCCESS, time_limit_s: 60, max_pursuit_distance_blocks: 32, retreat_health: 4 },
    reset_steps: [], evaluation: null };
}

function loadCandidate(options) {
  if (!options.candidate) return { skill: template(options.fighter), synthetic: options.ci, directory: null };
  const directory = fs.realpathSync(path.resolve(options.candidate));
  const skill = JSON.parse(fs.readFileSync(path.join(directory, 'skill.json'), 'utf8'));
  const fields = ['name', 'version', 'implementation', 'requirements', 'success_check', 'reset_steps', 'evaluation'];
  if (Object.keys(skill).length !== fields.length || fields.some((key) => !Object.hasOwn(skill, key)) ||
      skill.name !== 'combat.engage' || skill.version == null || skill.implementation?.type !== 'model' ||
      skill.success_check?.success !== SUCCESS || !Array.isArray(skill.reset_steps)) {
    throw new Error('candidate must be a V3 combat.engage skill with the supported success_check');
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json'), 'utf8'));
  const modelHash = hash(fs.readFileSync(path.join(directory, 'model.onnx')));
  if (metadata.model_sha256 !== modelHash || skill.implementation.model_sha256 !== modelHash ||
      typeof metadata.synthetic !== 'boolean') throw new Error('candidate hash or synthetic provenance is invalid');
  // Evaluating a synthetic model is allowed; these results cannot qualify it
  // for promotion, even if the trials themselves happen in Minecraft.
  return { skill, directory, synthetic: options.ci || metadata.synthetic,
    model_sha256: modelHash, dataset_sha256: metadata.dataset_sha256 ?? null };
}

function resetSteps() {
  const verify = (path, equals) => ({ path, equals });
  return [
    { command: 'kill @e[tag=agent37_trial]', verify: verify('trial.targets', 0) },
    { command: 'tp {username} 0.5 64 0.5', verify: verify('self.position', BOT_POSITION) },
    { command: 'fill -8 63 -8 8 63 8 minecraft:stone', verify: verify('bench.floor_ready', true) },
    { command: 'fill -8 64 -8 8 70 8 minecraft:air', verify: verify('bench.space_ready', true) },
    { command: 'time set midnight', verify: verify('bench.night', true) },
    { command: 'clear {username}', verify: verify('inventory.iron_axe', 0) },
    { command: 'effect give {username} minecraft:instant_health 1 10', verify: verify('self.health', 20) },
    { command: 'effect give {username} minecraft:saturation 1 10', verify: verify('self.hunger', 20) },
    { command: 'item replace entity {username} weapon.mainhand with minecraft:iron_axe', verify: verify('self.held_item', 'iron_axe') },
    { command: 'item replace entity {username} weapon.offhand with minecraft:shield', verify: verify('self.offhand_item', 'shield') },
    { command: 'summon minecraft:{target} 4.5 64 0.5 {Tags:["agent37_trial"],PersistenceRequired:1b}', verify: verify('trial.targets', 1) },
  ];
}

function ciFight(createCiArena, target, fighter) {
  const arena = createCiArena();
  const originalReset = arena.reset.bind(arena);
  let state, index = 0, random = SEED;
  const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0; };
  // Exercise all terminal paths, at seeded trial positions. These are fake
  // outcomes, not learned competence. Both fighters receive the same schedule.
  const schedule = [...Array(17).fill('success'), 'bot_death', 'human_takeover', 'timeout'];
  for (let i = schedule.length - 1; i > 0; i--) {
    const j = next() % (i + 1); [schedule[i], schedule[j]] = [schedule[j], schedule[i]];
  }
  arena.observe = () => structuredClone(state);
  arena.reset = async (steps, context) => {
    await originalReset(steps, context);
    state = { self: { health: 20, position: BOT_POSITION },
      target: { id: index + 1, mob_type: target, health: 20, position: MOB_POSITION },
      trial: { targets: 1 }, bench: { success: false, elapsed_ms: 0, selected_target_dead: false, safety_violations: 0 } };
  };
  const run = async (bot, _input, { signal }) => {
    signal.throwIfAborted();
    const before = bot.observe(), outcome = schedule[index++];
    // Fixed virtual 20 Hz steps model an exchange and bounded damage.
    const ticks = 20 + next() % 20;
    for (let tick = 0; tick < ticks; tick++) {
      bot.requestAction({ forward: tick < 5, attack: tick >= 5, use: target === 'skeleton' && tick < 5 });
      state.bench.elapsed_ms += 50;
    }
    state.bench.elapsed_ms += fighter === 'scripted' ? 100 : 0;
    if (outcome === 'success') {
      state.target.health = 0; state.trial.targets = 0;
      state.bench.selected_target_dead = true; state.bench.success = true;
    } else if (outcome === 'bot_death') {
      state.self.health = 0;
      arena.events.emit('failure', 'bot_death');
    } else if (outcome === 'human_takeover') arena.events.emit('human_takeover');
    else state.bench.elapsed_ms = LIMIT_MS;
    return { outcome: outcome === 'success' ? 'success' : outcome === 'timeout' ? 'timeout' : 'failure',
      reason: outcome === 'success' ? 'target_death' : outcome,
      elapsed_ms: state.bench.elapsed_ms, before, after: bot.observe() };
  };
  return { arena, run };
}

async function liveFight(createLiveArena, skill, candidate, options, env) {
  const { createRuntime } = await import('../server.js');
  const { rconCommand } = await import('../rcon.js');
  const { aimDelta } = await import('../geometry.js');
  const { Vec3 } = await import('vec3');
  let runtime, base, selectedId, selectedDead = false, human = false, violations = 0, cancellation, resetting = false;
  const post = async (route, body = {}, signal) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  };
  const arena = await createLiveArena({ skill, env, dataDir: path.join(repo, 'bridge/work/combat-sessions'),
    command: rconCommand, runtimeFactory: async (config) => {
      runtime = await createRuntime(config);
      base = `http://127.0.0.1:${runtime.server.address().port}`;
      return runtime;
    } });
  const observe = arena.observe.bind(arena), reset = arena.reset.bind(arena);
  const release = arena.release.bind(arena), settle = arena.settleReset.bind(arena), close = arena.close.bind(arena);
  runtime.bot.on('entityDead', (entity) => { if (entity.id === selectedId) selectedDead = true; });
  arena.events.on('human_takeover', () => { human = true; });
  arena.observe = () => {
    const observation = observe();
    const result = runtime.invocation?.result;
    violations = Math.max(violations, result?.safety_violations ?? 0, runtime.arbiter.emergency ? 1 : 0);
    observation.bench = { selected_target_dead: selectedDead, safety_violations: violations,
      success: selectedDead && observation.self?.health > 0 && !human && violations === 0 };
    if (resetting) {
      // Read actual client block/time observations to verify arena setup.
      const block = (x, y, z) => runtime.bot.blockAt(new Vec3(x, y, z));
      observation.bench.floor_ready = [-8, 0, 8].every((x) => [-8, 0, 8].every((z) => block(x, 63, z)?.name === 'stone'));
      observation.bench.space_ready = [-8, 0, 8].every((x) => [-8, 0, 8].every((z) =>
        [64, 67, 70].every((y) => block(x, y, z)?.name === 'air')));
      const time = runtime.bot.time?.timeOfDay;
      observation.bench.night = Number.isFinite(time) && time >= 13000 && time < 23000;
    }
    return observation;
  };
  arena.reset = async (steps, context) => {
    await post('/combat/cancel');
    selectedId = null; selectedDead = false; human = false; violations = 0;
    resetting = true;
    try { await reset(steps, context); }
    finally { resetting = false; }
    const targets = Object.values(runtime.bot.entities).filter((entity) => entity.name === options.target);
    if (targets.length !== 1) throw new Error('reset must produce exactly one selected target');
    selectedId = targets[0].id;
    // Populate the bridge's four-frame history before fixed-width inference.
    await delay(250, undefined, { signal: context.signal });
  };
  arena.release = () => {
    release();
    // J1's release hook is synchronous; settleReset waits for HTTP cancellation
    // so an old model invocation cannot write controls into the next trial.
    cancellation = post('/combat/cancel').then(() => { release(); });
    cancellation.catch(() => {});
  };
  arena.settleReset = async () => { await settle(); await cancellation; };
  arena.close = async () => {
    // Stop the invocation before shutting down its HTTP server. Restore J1's
    // synchronous release hook so close() cannot start a late HTTP request.
    try { await post('/combat/cancel'); }
    finally { arena.release = release; close(); }
  };
  const run = async (bot, _input, { signal }) => {
    const started = performance.now(), before = bot.observe();
    const finish = (outcome, reason) => ({ outcome, reason, elapsed_ms: performance.now() - started,
      before, after: bot.observe() });
    let invocation;
    if (!options.scripted) {
      invocation = (await post('/combat/engage', { candidate_dir: candidate.directory, target_type: options.target,
        max_duration_s: 60, max_pursuit_distance: candidate.skill.success_check.max_pursuit_distance_blocks ?? 32,
        retreat_health: candidate.skill.success_check.retreat_health ?? 4 }, signal)).invocation_id;
    }
    for (;;) {
      signal.throwIfAborted();
      const observation = bot.observe();
      if (!(observation.self?.health > 0)) return finish('failure', 'bot_death');
      if (human) return finish('failure', 'human_takeover');
      if (violations) return finish('failure', 'safety_violation');
      if (observation.bench.success) return finish('success', 'target_death');
      if (!options.scripted) {
        const current = runtime.invocation;
        if (!current || current.invocation_id !== invocation) return finish('failure', 'invocation_lost');
        if (current.status !== 'running') return finish(current.status === 'timeout' ? 'timeout' : 'failure', current.status);
      } else {
        const target = observation.target;
        if (!target || target.id !== selectedId) return finish('failure', 'target_lost');
        const aim = target.angular_error ? aimDelta(target.angular_error) : {};
        bot.requestAction({ forward: target.distance > 2.5, sprint: target.distance > 4,
          attack: Boolean(target.in_reach && target.line_of_sight),
          use: options.target === 'skeleton' && !target.in_reach, yaw_delta: aim.yaw, pitch_delta: aim.pitch });
      }
      await delay(50, undefined, { signal });
    }
  };
  return { arena, run };
}

export const line = (result) => `BENCH combat: ${result.value} of 20 (target 16 of 20) ${result.pass ? 'PASS' : 'FAIL'}`;

export async function runBench(options, { env = process.env } = {}) {
  const candidate = loadCandidate(options);
  const snapshot = loadJ1();
  const moduleAt = (filename) => import(pathToFileURL(path.join(snapshot.root, filename)).href);
  const { runTrial } = await moduleAt('bridge/eval/run.mjs');
  const { createCiArena, createLiveArena } = await moduleAt('bridge/eval/arena.mjs');
  const { summarize } = await moduleAt('bridge/eval/summary.js');
  const skill = { ...structuredClone(candidate.skill),
    requirements: { ...candidate.skill.requirements, input: { target_type: options.target, allowed_targets: ['zombie', 'skeleton'] } },
    reset_steps: resetSteps(),
    success_check: { time_limit_ms: LIMIT_MS, condition: { path: 'bench.success', equals: true } } };
  const { arena, run } = options.ci ? ciFight(createCiArena, options.target, options.fighter)
    : await liveFight(createLiveArena, skill, candidate, options, env);
  const rows = [];
  try {
    for (let trial = 1; trial <= TRIALS; trial++) {
      const row = await runTrial({ arena, skill, run, trial, input: skill.requirements.input });
      if (options.ci) row.elapsed_ms = row.after.bench.elapsed_ms;
      rows.push(row);
    }
  } finally { await arena.close(); }
  const mode = options.ci ? 'ci' : 'live';
  const filename = `combat-${mode}-${options.fighter}-${options.target}.json`;
  const resultsLink = `bench/results/${filename}`;
  const settings = { mode, fighter: options.fighter, seed: SEED, time_limit_ms: LIMIT_MS,
    target_type: options.target, bot_position: BOT_POSITION, target_position: MOB_POSITION,
    gear: ['iron_axe', 'shield'], j1_revision: snapshot.revision,
    success_check: candidate.skill.success_check, model_sha256: candidate.model_sha256 ?? null,
    dataset_sha256: candidate.dataset_sha256 ?? null };
  let baseline = null;
  if (options.scripted) baseline = { name: 'scripted-v1', value: rows.filter((row) => row.outcome === 'success' && !row.human_interventions).length,
    trials: TRIALS, target_type: options.target, synthetic: candidate.synthetic, seed: SEED, j1_revision: snapshot.revision, results_link: resultsLink };
  else if (!options.ci) {
    const previous = path.join(RESULTS, `combat-${mode}-scripted-${options.target}.json`);
    if (fs.existsSync(previous)) {
      const saved = JSON.parse(fs.readFileSync(previous, 'utf8'));
      const value = saved.baseline;
      if (saved.mode === mode && saved.trials === TRIALS && value?.name === 'scripted-v1' &&
          value.target_type === options.target && value.synthetic === candidate.synthetic &&
          value.seed === SEED && value.j1_revision === snapshot.revision) baseline = value;
    }
  }
  const evaluation = summarize(rows, { tested_version: candidate.skill.version, test_settings: settings,
    baseline, synthetic: candidate.synthetic, results_link: resultsLink });
  const result = { name: 'combat', value: evaluation.successes, unit: 'successful trials', target: TARGET,
    pass: rows.length === TRIALS && evaluation.successes >= TARGET, mode, trials: rows.length,
    at: options.ci ? CI_AT : new Date().toISOString(), baseline };
  return { result, evaluation, rows, output: path.join(RESULTS, filename) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { result, evaluation, output } = await runBench(parseOptions(process.argv.slice(2)));
    fs.mkdirSync(RESULTS, { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ evaluation }, null, 2));
    console.log(line(result));
    process.exitCode = result.pass ? 0 : 1;
  } catch (error) {
    console.error(`Combat benchmark error: ${error.message}`);
    console.log(line({ value: 0, pass: false }));
    process.exitCode = 1;
  }
}
