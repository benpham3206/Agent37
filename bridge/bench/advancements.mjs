// node bench/advancements.mjs (--ci | --live)
// Counts how many of the 5 goals in skills/goals.json are done.
// --ci replays fixed fake advancement packets (synthetic, same output every run).
// --live polls GET $A37_BOT_URL/combat/status for up to 10 minutes. Start it right after a fresh spawn
// (for example after /advancement revoke <bot> everything), so old progress is not counted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { AdvancementTracker } from '../advancements.js';
import { loadGoals, pickNextGoal } from '../skills/goals.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TARGET = 3;
const LIVE_MS = 10 * 60 * 1000, POLL_MS = 5000;
const CI_AT = '2000-01-01T00:00:00.000Z';

export const line = (r) => `BENCH advancements: ${r.value} of ${r.goals} (target ${r.target} of ${r.goals}) ${r.pass ? 'PASS' : 'FAIL'}`;

// Fixed packets in the shape the bot's `advancements` packet has. The first three goals get all
// their criteria, the fourth gets nothing, the fifth is listed but never progresses. A recipe unlock
// and a non-goal advancement are mixed in so the count must come from the goal list.
export function ciPackets(goals) {
  const at = 1700000000000n;
  const entry = (id) => ({ key: id, value: { requirements: [['done']] } });
  return [
    { reset: true, advancementMapping: [...goals.map((g) => entry(g.id)), entry('minecraft:recipes/misc/stick'), entry('minecraft:husbandry/root')],
      identifiers: [], progressMapping: [] },
    { reset: false, advancementMapping: [], identifiers: [],
      progressMapping: [goals[0], goals[1]].map((g) => ({ key: g.id, value: [{ criterionIdentifier: 'done', criterionProgress: at }] })) },
    { reset: false, advancementMapping: [], identifiers: [], progressMapping: [
      { key: 'minecraft:husbandry/root', value: [{ criterionIdentifier: 'done', criterionProgress: at }] },
      { key: goals[2].id, value: [{ criterionIdentifier: 'done', criterionProgress: at + 1n }] }] },
  ];
}

export function score(summary, goals, { mode, at, trials = 1 }) {
  const done = goals.filter((g) => summary.done.includes(g.id)).map((g) => g.id);
  return { name: 'advancements', value: done.length, unit: 'goals done', target: TARGET, goals: goals.length,
    pass: done.length >= TARGET, mode, trials, at, synthetic: mode === 'ci', done, next_goal: pickNextGoal(summary, goals) };
}

export function runCi(goals = loadGoals()) {
  const tracker = new AdvancementTracker();
  for (const packet of ciPackets(goals)) tracker.apply(packet);
  return score(tracker.get(), goals, { mode: 'ci', at: CI_AT });
}

// Polls the bridge until every goal is done or the time is up, and scores the last summary.
export async function runLive({ url, goals = loadGoals(), fetchImpl = fetch, limitMs = LIVE_MS, pollMs = POLL_MS,
  now = () => Date.now(), sleep = (ms) => delay(ms) } = {}) {
  if (!url) throw new Error('--live needs A37_BOT_URL, for example http://127.0.0.1:8765');
  const status = new URL('/combat/status', url);
  const started = now();
  let summary = null, polls = 0;
  for (;;) {
    const response = await fetchImpl(status);
    if (!response.ok) throw new Error(`${status} answered ${response.status}`);
    const advancements = (await response.json())?.advancements;
    polls++;
    if (advancements?.known) summary = advancements;
    if (summary && goals.every((g) => summary.done.includes(g.id))) break;
    if (now() - started >= limitMs) break;
    await sleep(pollMs);
  }
  if (!summary) throw new Error('the bot never reported its advancements; is it spawned?');
  return { ...score(summary, goals, { mode: 'live', at: new Date(now()).toISOString() }), polls,
    elapsed_ms: now() - started };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { ci: { type: 'boolean' }, live: { type: 'boolean' } }, strict: true });
    if (Boolean(values.ci) === Boolean(values.live)) throw new Error('usage: node bench/advancements.mjs (--ci | --live)');
    const result = values.ci ? runCi() : await runLive({ url: process.env.A37_BOT_URL });
    fs.mkdirSync(path.join(here, 'results'), { recursive: true });
    fs.writeFileSync(path.join(here, 'results', `advancements-${result.mode}.json`), JSON.stringify(result, null, 2) + '\n');
    console.log(line(result));
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    console.error(`BENCH advancements: error: ${error.message}`);
    process.exit(1);
  }
}
