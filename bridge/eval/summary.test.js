import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './summary.js';

const row = (outcome, human_interventions = 0) => ({ outcome, human_interventions, synthetic: false });
test('zero trials keep unknown settings null and do not invent results', () => {
  assert.deepEqual(summarize([]), {
    tested_version: null, test_settings: null, baseline: null, trial_count: 0,
    successes: 0, failures: 0, timeouts: 0, human_interventions: 0,
    synthetic: true, results_link: null,
  });
});
test('all successes preserve settings and do not change the input', () => {
  const rows = [row('success'), row('success')];
  const copy = structuredClone(rows);
  const settings = { tested_version: 1, test_settings: { seed: 37001 }, baseline: null, synthetic: false, results_link: 'results/test.json' };
  const result = summarize(rows, settings);
  assert.equal(result.successes, 2);
  assert.equal(result.synthetic, false);
  assert.deepEqual(result.test_settings, settings.test_settings);
  assert.deepEqual(rows, copy);
});
test('mixed success and failure', () => {
  const result = summarize([row('success'), row('failure'), row('success')]);
  assert.equal(result.trial_count, 3);
  assert.equal(result.successes, 2);
  assert.equal(result.failures, 1);
});
test('timeouts are counted separately', () => {
  const result = summarize([row('timeout')]);
  assert.equal(result.timeouts, 1);
  assert.equal(result.failures, 0);
});
test('human intervention cannot be counted as a success', () => {
  const result = summarize([row('success', 1)]);
  assert.equal(result.successes, 0);
  assert.equal(result.failures, 1);
  assert.equal(result.human_interventions, 1);
});
test('synthetic or unknown rows cannot become real through settings', () => {
  for (const synthetic of [true, null, undefined]) {
    assert.equal(summarize([{ ...row('success'), synthetic }], { synthetic: false }).synthetic, true);
  }
});
test('invalid outcomes and counts are rejected', () => {
  assert.throws(() => summarize([row('unknown')]));
  assert.throws(() => summarize([row('success', -1)]));
});
