// node bench/skills.mjs (--ci | --live) [--trials N]
// Runs every skill in skills/ (except combat.*, which has its own benchmark, and CI-only
// fixtures) through the J1 runner for N trials (default 20). PASS only if every skill
// succeeds in at least 80% of trials (16 of 20).
// --ci runs one fake skill with a fixed seed through the same runTrial path. Its results are
// synthetic: true and never count toward activation.
// --live needs J1's A37_MC_*, A37_RCON_*, A37_EVAL_USERNAME and A37_EVAL_APPROVED_RESET=1 settings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SkillRegistry } from '../skills/registry.js';
import { evaluate, runTrial } from '../eval/run.mjs';
import { createCiArena, SEED } from '../eval/arena.mjs';
import { summarize } from '../eval/summary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CI_AT = '2000-01-01T00:00:00.000Z';
export const targetFor = (trials) => Math.ceil(trials * 0.8);

export const skillLine = (s) => `${s.name} v${s.version ?? '?'}: ${s.successes} of ${s.trial_count} ` +
  `(target ${targetFor(s.trial_count)} of ${s.trial_count}) ${s.pass ? 'PASS' : 'FAIL'}${s.error ? ` (${s.error})` : ''}`;
export const line = (r) => `BENCH skills: ${r.worst} ${r.value} of ${r.trials} (target ${r.target} of ${r.trials}) ${r.pass ? 'PASS' : 'FAIL'}`;

// Skills to benchmark, each with the version to test: the active one if active.json names it,
// otherwise the newest version folder that the registry loads.
export function listSkills(registry = new SkillRegistry()) {
  const active = registry.pointers();
  const out = [];
  for (const name of fs.readdirSync(registry.root).sort()) {
    if (name.startsWith('combat.') || !fs.statSync(path.join(registry.root, name)).isDirectory()) continue;
    const versions = fs.readdirSync(path.join(registry.root, name))
      .map((entry) => /^v([1-9]\d*)$/.exec(entry)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a);
    const version = Object.hasOwn(active, name) ? Number(active[name]) : versions.find((v) => {
      try { registry.load(name, v); return true; } catch { return false; }
    });
    if (version == null) continue; // no folder in the skill-format layout
    if (registry.load(name, version).requirements?.ci_only === true) continue;
    out.push({ name, version });
  }
  return out;
}

// A seeded random number generator (mulberry32), so the fake skill gives the same results every run.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The CI stand-in: succeeds 90% of the time, otherwise fails or times out, from a fixed seed.
export async function runCi({ trials = 20 } = {}) {
  const random = seeded(SEED);
  const skill = { name: 'ci.fake_skill', version: 1, reset_steps: [],
    success_check: { time_limit_ms: 1000, condition: { path: 'test.ready', equals: true } } };
  const run = async (bot) => {
    const roll = random(), observed = bot.observe();
    const [outcome, reason] = roll < 0.9 ? ['success', 'goal_reached'] : roll < 0.97 ? ['failure', 'execution_error'] : ['timeout', 'time_limit'];
    return { outcome, reason, elapsed_ms: 0, before: observed, after: bot.observe() };
  };
  const arena = createCiArena();
  const rows = [];
  try {
    for (let trial = 1; trial <= trials; trial++) {
      rows.push({ ...await runTrial({ arena, skill, run, trial }), elapsed_ms: 0 });
    }
  } finally { await arena.close(); }
  const evaluation = summarize(rows, { tested_version: 1, test_settings: { mode: 'ci', seed: SEED }, synthetic: true });
  return finish([perSkill(skill.name, 1, evaluation)], { mode: 'ci', trials, at: CI_AT });
}

function perSkill(name, version, evaluation, error = null) {
  return { name, version, trial_count: evaluation.trial_count, successes: evaluation.successes,
    failures: evaluation.failures, timeouts: evaluation.timeouts, human_interventions: evaluation.human_interventions,
    pass: !error && evaluation.successes >= targetFor(evaluation.trial_count), error, evaluation };
}

function finish(per_skill, { mode, trials, at }) {
  if (per_skill.length === 0) throw new Error('no skills to benchmark');
  const worst = per_skill.reduce((a, b) => (b.successes < a.successes ? b : a));
  return { name: 'skills', value: worst.successes, unit: 'successes of the worst skill', target: targetFor(trials),
    pass: per_skill.every((s) => s.pass), mode, trials, at, synthetic: mode === 'ci', worst: worst.name, per_skill };
}

// Each skill goes through the J1 runner's evaluate(), which resets, runs, checks and releases every trial.
export async function runLive({ trials = 20, registry = new SkillRegistry(), evaluateImpl = evaluate, log = console.log } = {}) {
  const per_skill = [];
  for (const { name, version } of listSkills(registry)) {
    let result;
    try {
      const { report } = await evaluateImpl({ skill: name, version, trials, live: true, ci: false }, { registry });
      result = perSkill(name, version, report.evaluation);
    } catch (error) {
      // A skill that cannot run (missing settings, a failed reset setup) counts as 0 successes.
      result = perSkill(name, version, { trial_count: trials, successes: 0, failures: trials, timeouts: 0, human_interventions: 0 },
        String(error?.message ?? error));
      result.evaluation = null;
    }
    per_skill.push(result);
    log(skillLine(result));
    // The block its owner can paste into the skill's skill.json "evaluation" field after review.
    if (result.evaluation) log(JSON.stringify(result.evaluation, null, 2));
  }
  return finish(per_skill, { mode: 'live', trials, at: new Date().toISOString() });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { ci: { type: 'boolean' }, live: { type: 'boolean' }, trials: { type: 'string' } }, strict: true });
    if (Boolean(values.ci) === Boolean(values.live)) throw new Error('usage: node bench/skills.mjs (--ci | --live) [--trials N]');
    const trials = values.trials == null ? 20 : Number(values.trials);
    if (!Number.isSafeInteger(trials) || trials < 1) throw new Error('--trials must be a positive integer');
    const result = values.ci ? await runCi({ trials }) : await runLive({ trials });
    if (values.ci) for (const s of result.per_skill) console.log(skillLine(s));
    fs.mkdirSync(path.join(here, 'results'), { recursive: true });
    fs.writeFileSync(path.join(here, 'results', `skills-${result.mode}.json`), JSON.stringify(result, null, 2) + '\n');
    console.log(line(result));
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    console.error(`BENCH skills: error: ${error.message}`);
    process.exit(1);
  }
}
