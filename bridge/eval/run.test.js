import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseOptions, runTrial } from './run.mjs';
import { createCiArena } from './arena.mjs';

const bridge = fileURLToPath(new URL('../', import.meta.url));
const skill = {
  reset_steps: [],
  success_check: { time_limit_ms: 1000, condition: { path: 'test.ready', equals: true } },
};
const success = (bot) => ({ outcome: 'success', reason: 'done', elapsed_ms: 0, before: bot.observe(), after: bot.observe() });

test('CLI arguments reject zero/fractional trials, conflicting modes and unknown flags', () => {
  const base = ['--skill', 'test.noop', '--trials', '3', '--ci'];
  assert.equal(parseOptions(base).trials, 3);
  for (const args of [[], [...base, '--live'], [...base, '--other'],
    ['--skill', 'test.noop', '--trials', '0', '--ci'],
    ['--skill', 'test.noop', '--trials', '1.5', '--ci']]) {
    assert.throws(() => parseOptions(args));
  }
});

test('a trial resets before running, checks success and releases controls', async () => {
  const arena = createCiArena();
  let resets = 0;
  const reset = arena.reset;
  arena.reset = async (...args) => { resets++; return reset(...args); };
  for (let trial = 1; trial <= 3; trial++) {
    const row = await runTrial({ arena, skill, trial, run: (bot) => {
      assert.equal(resets, trial);
      bot.requestAction({ forward: true });
      return success(bot);
    } });
    assert.equal(row.outcome, 'success');
    assert.equal(row.trial, trial);
    assert.equal(row.synthetic, true);
    assert.deepEqual(row.before, row.after);
    assert.equal(arena.arbiter.tick().source, 'idle');
  }
});

test('an unverified claimed success becomes a failure', async () => {
  const arena = createCiArena();
  const row = await runTrial({ arena, skill: {
    ...skill, success_check: { ...skill.success_check, condition: { path: 'test.ready', equals: false } },
  }, run: success, trial: 1 });
  assert.equal(row.outcome, 'failure');
  assert.equal(row.reason, 'success_check_not_met');
});

test('errors, malformed returns and death are failures with controls released', async () => {
  for (const run of [
    () => { throw new Error('example_error'); },
    () => ({ outcome: 'not_an_outcome' }),
    (bot) => { return { ...success(bot), elapsed_ms: -1 }; },
  ]) {
    const arena = createCiArena();
    const row = await runTrial({ arena, skill, trial: 1, run: (bot) => {
      bot.requestAction({ forward: true }); return run(bot);
    } });
    assert.equal(row.outcome, 'failure');
    assert.equal(arena.arbiter.tick().source, 'idle');
  }
  const arena = createCiArena();
  const row = await runTrial({ arena, skill, trial: 1, run: () => {
    arena.events.emit('failure', 'bot_death');
    return new Promise(() => {});
  } });
  assert.equal(row.reason, 'bot_death');
  assert.equal(row.outcome, 'failure');
  assert.equal(arena.events.listenerCount('failure'), 0);
});

test('human takeover is a failure and records one interrupted trial', async () => {
  const arena = createCiArena();
  const row = await runTrial({ arena, skill, trial: 1, run: () => {
    arena.events.emit('human_takeover');
    arena.events.emit('human_takeover');
    return new Promise(() => {});
  } });
  assert.equal(row.outcome, 'failure');
  assert.equal(row.human_interventions, 1);
  assert.equal(arena.arbiter.tick().source, 'idle');
});

test('timeout aborts the skill, releases controls and blocks late actions', async () => {
  const arena = createCiArena();
  let savedBot, savedSignal;
  const row = await runTrial({ arena, skill: {
    ...skill, success_check: { ...skill.success_check, time_limit_ms: 20 },
  }, trial: 1, run: (bot, _input, { signal }) => {
    savedBot = bot; savedSignal = signal;
    bot.requestAction({ attack: true });
    return new Promise(() => {});
  } });
  assert.equal(row.outcome, 'timeout');
  assert.equal(savedSignal.aborted, true);
  assert.throws(() => savedBot.requestAction({ forward: true }));
  assert.equal(arena.arbiter.tick().source, 'idle');
});

test('cooperative cancellation does not leave an unhandled rejection', async () => {
  const arena = createCiArena();
  const row = await runTrial({ arena, skill: {
    ...skill, success_check: { ...skill.success_check, time_limit_ms: 20 },
  }, trial: 1, run: async (_bot, _input, { signal }) => {
    await delay(1000, undefined, { signal });
  } });
  assert.equal(row.outcome, 'timeout');
});

test('failed reset never launches a skill', async () => {
  const arena = createCiArena();
  arena.reset = async () => { throw new Error('reset_failed'); };
  let ran = false;
  const row = await runTrial({ arena, skill, trial: 1, run: () => { ran = true; } });
  assert.equal(ran, false);
  assert.equal(row.outcome, 'failure');
  assert.equal(row.reason, 'reset_failed');
});

test('cleanup and observation errors still produce failure rows', async () => {
  const arena = createCiArena();
  const row = await runTrial({ arena, skill, trial: 1, run: (bot) => {
    const value = success(bot);
    arena.release = () => { throw new Error('release_error'); };
    return value;
  } });
  assert.equal(row.outcome, 'failure');
  assert.equal(row.reason, 'control_release_failed');
  const broken = createCiArena();
  broken.observe = () => { throw new Error('missing_observation'); };
  const failed = await runTrial({ arena: broken, skill, trial: 1, run: success });
  assert.equal(failed.outcome, 'failure');
  assert.equal(failed.after, null);
});

// Existing CI invokes npm test, so this also runs the required CLI in CI.
test('CLI writes three rows and a synthetic summary, without activating the fixture', () => {
  const activePath = path.join(bridge, 'skills', 'active.json');
  const activeBefore = fs.readFileSync(activePath, 'utf8');
  const result = spawnSync(process.execPath, ['eval/run.mjs', '--skill', 'test.noop', '--trials', '3', '--ci'], {
    cwd: bridge, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(bridge, 'eval/results/test.noop--v1.json'), 'utf8'));
  assert.equal(report.trials.length, 3);
  assert.equal(report.evaluation.trial_count, 3);
  assert.equal(report.evaluation.successes, 3);
  assert.equal(report.evaluation.synthetic, true);
  assert.equal(report.evaluation.human_interventions, 0);
  assert.equal(report.evaluation.test_settings.seed, 37001);
  assert.deepEqual(report.trials[0].before, report.trials[2].before);
  assert.equal(fs.readFileSync(activePath, 'utf8'), activeBefore);
});
