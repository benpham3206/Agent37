import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, line, runBench } from './latency.mjs';

test('summary and BENCH line format', () => {
  const r = summarize([10, 20, 300, 40], { mode: 'ci' });
  assert.equal(r.value, 75); assert.equal(r.pass, false); assert.equal(r.trials, 4); assert.equal(r.p95_ms, 300);
  assert.equal(line(r), 'BENCH latency: 75% of 4 steps under 250 ms (target 95%) FAIL');
  assert.equal(summarize([], { mode: 'ci' }).pass, false);
  assert.match(line(summarize(Array(20).fill(5), { mode: 'ci' })), /100% of 20 steps .* PASS$/);
});
test('a short --ci run reaches the fake bot and passes', async () => {
  const r = await runBench({ mode: 'ci', steps: 10 });
  assert.equal(r.trials, 10); assert.equal(r.pass, true);
});
test('--live needs A37_BOT_URL', async () => {
  await assert.rejects(runBench({ mode: 'live', steps: 1, env: {} }), /A37_BOT_URL/);
});
