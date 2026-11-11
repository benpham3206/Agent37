// B1 read-and-act latency bench.
//   node bench/latency.mjs --ci     fake bot, no Minecraft server (runs in CI)
//   node bench/latency.mjs --live   real bridge at env A37_BOT_URL (e.g. the bot's control URL)
// One step = GET /api/observation, POST /api/action, then wait until the action
// takes effect. In --ci that is the fake bot's setControlState call. In --live
// the bot is remote, so a step ends when the bridge accepts the action (HTTP 200);
// the bridge then applies it on its next 50 ms control tick.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const TARGET_MS = 250, TARGET_PCT = 95;

export function summarize(samples, { mode }) {
  const sorted = [...samples].sort((a, b) => a - b);
  const under = samples.filter((ms) => ms < TARGET_MS).length;
  const pct = samples.length ? Math.round((under / samples.length) * 1000) / 10 : 0;
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null;
  return { name: 'latency', value: pct, unit: `% of steps under ${TARGET_MS} ms`, target: TARGET_PCT,
    pass: samples.length > 0 && pct >= TARGET_PCT, mode, trials: samples.length, at: new Date().toISOString(),
    p95_ms: p95 == null ? null : Math.round(p95 * 10) / 10 };
}
export const line = (r) => `BENCH latency: ${r.value}% of ${r.trials} steps under ${TARGET_MS} ms (target ${TARGET_PCT}%) ${r.pass ? 'PASS' : 'FAIL'}`;

async function step(base, action, applied) {
  const started = performance.now();
  const obs = await fetch(`${base}/api/observation`, { signal: AbortSignal.timeout(2000) });
  if (!obs.ok) throw new Error(`observation returned ${obs.status}`);
  await obs.json();
  const wait = applied?.();
  const res = await fetch(`${base}/api/action`, { method: 'POST', body: JSON.stringify(action), signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`action returned ${res.status}`);
  await res.json();
  if (wait) await wait;
  return performance.now() - started;
}

export async function runBench({ mode, steps = 1000, env = process.env }) {
  let base, close = () => {}, waiter = null;
  if (mode === 'ci') {
    const { createRuntime } = await import('../server.js');
    const { fakeWorldBot } = await import('../fixtures/observation/fake-world.js');
    const bot = fakeWorldBot();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-bench-'));
    const runtime = await createRuntime({ bot, webPort: 0, dataDir, session: 'bench' });
    base = `http://127.0.0.1:${runtime.server.address().port}`;
    close = () => { runtime.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
    waiter = (value) => () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { bot.off('control', on); reject(new Error('action never reached the bot')); }, 2000);
      function on(key, v) { if (key === 'forward' && v === value) { clearTimeout(timer); bot.off('control', on); resolve(); } }
      bot.on('control', on);
    });
  } else {
    base = env.A37_BOT_URL;
    if (!base) throw new Error('set A37_BOT_URL for --live');
  }
  const samples = [];
  try {
    for (let i = 0; i < steps; i++) {
      const forward = i % 2 === 0;
      samples.push(await step(base, { forward }, waiter?.(forward)));
    }
    if (mode === 'live') await fetch(`${base}/api/action`, { method: 'POST', body: '{}' }); // leave the bot idle
  } finally { close(); }
  return summarize(samples, { mode });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { ci: { type: 'boolean' }, live: { type: 'boolean' }, steps: { type: 'string' } }, strict: true });
    if (Boolean(values.ci) === Boolean(values.live)) throw new Error('usage: node bench/latency.mjs (--ci | --live) [--steps N]');
    const steps = values.steps == null ? 1000 : Number(values.steps);
    if (!Number.isInteger(steps) || steps < 1) throw new Error('--steps must be a positive integer');
    const result = await runBench({ mode: values.ci ? 'ci' : 'live', steps });
    fs.mkdirSync(path.join(here, 'results'), { recursive: true });
    fs.writeFileSync(path.join(here, 'results', `latency-${result.mode}.json`), JSON.stringify(result, null, 2) + '\n');
    console.log(line(result));
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    console.error(`BENCH latency: error: ${error.message}`);
    process.exit(1);
  }
}
