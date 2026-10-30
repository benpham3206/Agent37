import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SkillRegistry, versionNumber } from '../skills/registry.js';
import { summarize } from './summary.js';
import { createCiArena, createLiveArena, checkCondition, SEED } from './arena.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outcomes = new Set(['success', 'failure', 'timeout']);

export function parseOptions(args) {
  const { values } = parseArgs({ args, options: {
    skill: { type: 'string' }, version: { type: 'string' }, trials: { type: 'string' },
    ci: { type: 'boolean' }, live: { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (!values.skill || !values.trials || Boolean(values.ci) === Boolean(values.live)) {
    throw new Error('usage: node eval/run.mjs --skill NAME [--version N] --trials N (--ci | --live)');
  }
  const trials = versionNumber(values.trials);
  return { ...values, trials, version: values.version == null ? null : versionNumber(values.version) };
}

export async function runTrial({ arena, skill, run, input = {}, trial }) {
  const controller = new AbortController();
  let timer, before = null, human_interventions = 0;
  let started = performance.now();
  let stop;
  const interrupted = new Promise((resolve) => { stop = resolve; });
  let terminal = null;
  const interrupt = (outcome, reason) => {
    if (terminal) return;
    terminal = { outcome, reason };
    controller.abort(new Error(reason));
    stop(terminal);
  };
  const onFailure = (reason) => interrupt('failure', reason);
  const onHuman = () => {
    human_interventions = 1; // One interrupted trial, not one per keyboard packet.
    interrupt('failure', 'human_takeover');
  };
  arena.events.on('failure', onFailure);
  arena.events.on('human_takeover', onHuman);
  let result;
  try {
    const operation = (async () => {
      timer = setTimeout(() => interrupt('failure', 'reset_timeout'), 30000);
      await arena.reset(skill.reset_steps, { signal: controller.signal });
      controller.signal.throwIfAborted();
      clearTimeout(timer);
      before = structuredClone(arena.observe());
      if (before.self?.health != null && before.self.health <= 0) throw new Error('bot_death');
      started = performance.now();
      timer = setTimeout(() => interrupt('timeout', 'time_limit'), skill.success_check.time_limit_ms);
      const value = await run(arena.bot(controller.signal), structuredClone(input), { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!value || !outcomes.has(value.outcome) || typeof value.reason !== 'string' ||
          !Number.isFinite(value.elapsed_ms) || value.elapsed_ms < 0 ||
          !Object.hasOwn(value, 'before') || !Object.hasOwn(value, 'after')) {
        throw new Error('invalid skill result');
      }
      const after = arena.observe();
      if (after.self?.health != null && after.self.health <= 0) return { outcome: 'failure', reason: 'bot_death' };
      if (performance.now() - started >= skill.success_check.time_limit_ms) return { outcome: 'timeout', reason: 'time_limit' };
      if (value.outcome === 'success' && !checkCondition(skill.success_check.condition, before, after)) {
        return { outcome: 'failure', reason: 'success_check_not_met' };
      }
      return { outcome: value.outcome, reason: value.reason };
    })();
    result = await Promise.race([operation, interrupted]);
  } catch (error) {
    result = terminal ?? { outcome: 'failure', reason: error.message ?? 'skill_error' };
  } finally {
    clearTimeout(timer);
    controller.abort(new Error('trial_finished'));
    arena.events.off('failure', onFailure);
    arena.events.off('human_takeover', onHuman);
    try { arena.release(); }
    catch { result = { outcome: 'failure', reason: 'control_release_failed' }; }
    await arena.settleReset?.();
  }
  let after = null;
  try { after = structuredClone(arena.observe() ?? null); }
  catch { result = { outcome: 'failure', reason: 'observation_error' }; }
  return {
    trial, ...result, elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
    before, after,
    human_interventions, synthetic: arena.synthetic,
  };
}

export async function evaluate(options, {
  registry = new SkillRegistry(), resultsDir = path.join(here, 'results'),
  makeArena = null,
} = {}) {
  // Only the bundled CI fixture has an implicit candidate version. It is never
  // put into active.json just to make the smoke command pass.
  const skill = options.version != null ? registry.load(options.skill, options.version)
    : options.ci && options.skill === 'test.noop' ? registry.load('test.noop', 1)
      : registry.get(options.skill);
  const implementation = skill.implementation;
  if (implementation?.type !== 'code' || implementation.entry_point !== 'run' ||
      implementation.artifact !== 'index.js') throw new Error('runner needs a code adapter: index.js exporting run');
  if (!Number.isSafeInteger(skill.success_check?.time_limit_ms) || skill.success_check.time_limit_ms <= 0 ||
      skill.success_check.time_limit_ms > 2147483647 || !skill.success_check.condition) {
    throw new Error('success_check needs a condition and positive time_limit_ms');
  }
  if (!Array.isArray(skill.reset_steps)) throw new Error('reset_steps are unknown; this skill is not runnable');
  // Check the condition shape before connecting to a live world.
  checkCondition(skill.success_check.condition, {}, {});
  const filename = registry.contained(path.join(registry.directory(skill.name, skill.version), 'index.js'));
  const { run } = await import(pathToFileURL(filename).href);
  if (typeof run !== 'function') throw new Error('index.js must export run');
  const settings = { mode: options.ci ? 'ci' : 'live', seed: SEED, time_limit_ms: skill.success_check.time_limit_ms,
    requirements: skill.requirements, reset_steps: skill.reset_steps };
  const arena = makeArena ? await makeArena() : options.ci ? createCiArena()
    : await createLiveArena({ skill, dataDir: path.join(resultsDir, 'sessions') });
  const rows = [];
  try {
    for (let trial = 1; trial <= options.trials; trial++) {
      rows.push(await runTrial({ arena, skill, run, input: skill.requirements?.input ?? {}, trial }));
    }
  } finally { await arena.close(); }
  fs.mkdirSync(resultsDir, { recursive: true });
  const output = path.join(resultsDir, `${skill.name}--v${skill.version}.json`);
  const results_link = path.relative(path.dirname(here), output).split(path.sep).join('/');
  const evaluation = summarize(rows, {
    tested_version: skill.version, test_settings: settings,
    baseline: skill.evaluation?.baseline ?? null, synthetic: options.ci || arena.synthetic, results_link,
  });
  const report = { name: skill.name, version: skill.version, trials: rows, evaluation };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  return { report, output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, output } = await evaluate(parseOptions(process.argv.slice(2)));
    console.log(`Wrote ${output}`);
    console.log(JSON.stringify(report.evaluation, null, 2));
    if (report.evaluation.failures || report.evaluation.timeouts) process.exitCode = 1;
  } catch (error) {
    console.error(`Evaluation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
