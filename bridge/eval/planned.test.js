import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChainRegion } from './chain.mjs';
import { createPlanner } from '../planner/planner.mjs';
import { CI_POLICY, PLANNED_RUNTIME_OPTIONS, buildCandidates, createCiWorld, finishPlanned, main, makeSkillLoader, openPlannedArena, parsePlannedOptions, runPlanned } from './planned.mjs';

const env = { A37_EVAL_USERNAME: 'Ben_bot' };
const region = createChainRegion({ x: 740, z: 692 });
const reply = (d) => ({ text: typeof d === 'string' ? d : JSON.stringify(d),
  usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, cost_usd: 0.001, model: 'fake-haiku' });
const rawScript = (...items) => { let i = 0; return async () => reply(items[Math.min(i++, items.length - 1)]); };
const ACTIONS = new Set(['run_skill', 'primitive', 'request_assist']);
const objective = (id, done, reasoning = 'need 3 logs and hold 0, so 3') => ({ id, description: `do ${id}`, done, reasoning });
const NETHER = objective('nether', { dimension: 'the_nether' }, 'enter the portal');
const POLICY = CI_POLICY;
const planOf = (...objectives) => ({ type: 'plan', objectives, threat_policy: POLICY });
const ONE_PLAN = planOf(NETHER);
// Most tests have one objective, the Nether, so the plan comes first and every action names it.
const tag = (d) => typeof d === 'object' && ACTIONS.has(d.type) && !('objective' in d) ? { ...d, objective: 'nether' } : d;
const script = (...items) => rawScript(ONE_PLAN, ...items.map(tag));
const ENTER = { type: 'run_skill', skill: 'travel.enter_nether', input: {} };
const WOOD = { type: 'run_skill', skill: 'resource.collect_wood', input: {} };

async function play(callModel, { world = createCiWorld({ region, username: 'Ben_bot' }), limits, allowAssists = false, ...options } = {}) {
  const load = makeSkillLoader(world.resolve);
  const { candidates } = await buildCandidates(load, { allowAssists });
  const planner = createPlanner({ callModel, candidates, limits });
  const lines = [];
  const report = await runPlanned({ arena: world.arena, planner, load, username: 'Ben_bot', region, minutes: 1, allowAssists,
    minIntervalMs: 0, pollMs: 10, onLine: (l) => lines.push(l), ...options });
  return { report, lines, world };
}

test('options: start and model are required, minutes are capped at 15, and only owned bots are allowed', () => {
  assert.equal(parsePlannedOptions(['--ci', '--start=740,692', '--model', 'haiku'], env).minutes, 10);
  assert.equal(parsePlannedOptions(['--ci', '--start', '740,692', '--model', 'sonnet', '--minutes', '15'], env).minutes, 15);
  assert.throws(() => parsePlannedOptions(['--ci', '--start=740,692', '--model', 'haiku', '--minutes', '16'], env), /usage/);
  assert.throws(() => parsePlannedOptions(['--ci', '--model', 'haiku'], env), /--start/);
  assert.throws(() => parsePlannedOptions(['--ci', '--start=740,692'], env), /usage/);
  assert.throws(() => parsePlannedOptions(['--ci', '--live', '--start=740,692', '--model', 'haiku'], env), /usage/);
  assert.throws(() => parsePlannedOptions(['--ci', '--start=740,692', '--model', 'haiku'], { A37_EVAL_USERNAME: 'Thinh_bot' }), /owns only/);
  assert.throws(() => parsePlannedOptions(['--live', '--start=740,692', '--model', 'haiku'],
    { ...env, A37_MC_HOST: [10, 0, 0, 5].join('.'), A37_RCON_HOST: '127.0.0.1', A37_EVAL_APPROVED_RESET: '1' }), /loopback/);
});

test('status is PASS only with the Nether reached and zero assists, watchdog actions and fallbacks', () => {
  const base = { reached_nether: true, assists_used: 0, watchdog_actions: 0, fallback_decisions: 0 };
  assert.equal(finishPlanned({ ...base }), 'PASS');
  assert.equal(finishPlanned({ ...base, assists_used: 1 }), 'ASSISTED');
  assert.equal(finishPlanned({ ...base, watchdog_actions: 1 }), 'ASSISTED');
  assert.equal(finishPlanned({ ...base, fallback_decisions: 1 }), 'ASSISTED');
  assert.equal(finishPlanned({ ...base, reached_nether: false }), 'FAIL');
  assert.equal(finishPlanned({ ...base, reached_nether: false, assists_used: 2 }), 'FAIL');
});

test('a clean run into the Nether is PASS and the dimension is read from the arena', async () => {
  const { report, lines } = await play(script(ENTER));
  assert.equal(report.summary.status, 'PASS');
  assert.equal(report.summary.reached_nether, true);
  assert.equal(report.summary.natural_skill_successes, 1);
  assert.equal(report.end.dimension, 'the_nether');
  assert.match(lines.find((l) => l.startsWith('PLAN 1 ')), /^PLAN 1 trigger=plan_needed decision=plan:1_objectives outcome=success tokens=520$/);
  assert.match(lines.find((l) => l.startsWith('PLAN 2 ')), /^PLAN 2 trigger=plan_made decision=run_skill:travel\.enter_nether outcome=success tokens=520$/);
  assert.match(lines.at(-1), /^SUMMARY PASS reached_nether=true objectives=1\/1 /);
});

test('the first decision must be a plan: an action first never runs, and the run records a give-up', async () => {
  const world = createCiWorld({ region, username: 'Ben_bot' });
  const prompts = [];
  const model = async (prompt) => { prompts.push(prompt); return reply(tag(ENTER)); };
  const { report } = await play(model, { world });
  assert.equal(report.rows.length, 1);
  assert.deepEqual(report.rows[0].decision, { type: 'done', reason: 'invalid_plan', fallback: true });
  assert.equal(report.summary.reached_nether, false);
  assert.equal(report.summary.status, 'FAIL');
  assert.equal(report.summary.gave_up, 'invalid_plan');
  assert.equal(report.summary.natural_skill_successes, 0);
  assert.match(prompts[1], /first_decision_must_be_a_plan/);
});

test('the plan is saved, printed as PLAN_OBJECTIVES, and shown to the model with the current objective', async () => {
  const prompts = [];
  const inner = script(ENTER);
  const { report, lines } = await play(async (p) => { prompts.push(p); return inner(); });
  assert.deepEqual(report.plan.objectives, ONE_PLAN.objectives);
  const printed = lines.find((l) => l.startsWith('PLAN_OBJECTIVES '));
  assert.deepEqual(JSON.parse(printed.slice('PLAN_OBJECTIVES '.length)), ONE_PLAN.objectives);
  assert.match(prompts[1], /"current":"nether"/);
  assert.match(prompts[1], /"status":"current"/);
});

test('an objective is done only when the real observation says so, never because the model said so', async () => {
  const logs = objective('logs', { have: { item: 'any_log', count: 3 } }, 'need 3 logs, hold 0');
  const wait = { type: 'primitive', name: 'wait', args: { seconds: 0.05 } };
  const claim = await play(rawScript(planOf(logs, NETHER), { ...wait, objective: 'logs' },
    { type: 'done', reason: 'all objectives are complete, trust me' }));
  assert.deepEqual(claim.report.plan.completed, []);
  assert.equal(claim.report.summary.objectives_done, 0);
  assert.equal(claim.report.summary.gave_up, 'all objectives are complete, trust me');
  assert.equal(claim.report.rows.at(-1).outcome, 'gave_up');
  assert.ok(!claim.lines.some((l) => l.startsWith('OBJECTIVE done')));
  assert.match(claim.lines.find((l) => l.startsWith('GAVE_UP')), /trust me/);
  const real = await play(rawScript(planOf(logs, NETHER), { type: 'run_skill', skill: 'resource.collect_wood', input: { count: 3 }, objective: 'logs' },
    { ...ENTER, objective: 'nether' }));
  assert.deepEqual(real.report.plan.completed.map((c) => c.id), ['logs', 'nether']);
  assert.ok(real.report.plan.completed.every((c) => Number.isFinite(c.elapsed_ms) && c.step >= 1));
  assert.deepEqual(real.lines.filter((l) => l.startsWith('OBJECTIVE done')).map((l) => l.replace(/ elapsed=.*/, '')), ['OBJECTIVE done logs', 'OBJECTIVE done nether']);
  assert.ok(real.lines.some((l) => /^OBJECTIVE done logs elapsed=\d+\.\d$/.test(l)));
  assert.equal(real.report.rows.find((r) => r.decision.skill === 'resource.collect_wood').input.count, 3);
});

test('skipping ahead is impossible: an action for a later objective is rejected and never runs', async () => {
  const logs = objective('logs', { have: { item: 'any_log', count: 3 } }, 'need 3 logs, hold 0');
  const prompts = [];
  const inner = rawScript(planOf(logs, NETHER), { ...ENTER, objective: 'nether' }, { ...ENTER, objective: 'nether' });
  const { report, world } = await play(async (p) => { prompts.push(p); return inner(); });
  assert.match(prompts[2], /objective_must_be_the_current_one:logs/);
  assert.equal(report.summary.natural_skill_successes, 0);
  assert.equal(report.summary.reached_nether, false);
  assert.equal(report.rows.at(-1).decision.type, 'done');
  assert.deepEqual(world.arena.commands, []);
});

test('revise_plan replaces the plan, is logged in full, and is limited to 3 per run', async () => {
  const revise = (id) => ({ type: 'revise_plan', why: `change ${id}`, objectives: [objective(id, { dimension: 'the_nether' }, 'go')] });
  const prompts = [];
  const inner = rawScript(planOf(NETHER), revise('a'), revise('b'), revise('c'), revise('d'), revise('d'));
  const { report, lines } = await play(async (p) => { prompts.push(p); return inner(); });
  assert.deepEqual(report.plan.revisions.map((r) => r.why), ['change a', 'change b', 'change c']);
  assert.equal(report.plan.revisions[0].objectives[0].id, 'a');
  assert.equal(report.plan.objectives[0].id, 'c');
  assert.equal(report.summary.plan_revisions, 3);
  assert.equal(lines.filter((l) => l.startsWith('PLAN_REVISED')).length, 3);
  assert.equal(lines.filter((l) => l.startsWith('PLAN_OBJECTIVES')).length, 4);
  assert.ok(prompts.some((p) => /revisions_exhausted/.test(p)));
  assert.equal(report.rows.at(-1).decision.type, 'done');
  assert.equal(report.summary.status, 'FAIL');
});

test('an assist sets assisted and the run can never be PASS', async () => {
  const { report, world } = await play(script({ type: 'request_assist', assist: 'give_wood' }, ENTER), { allowAssists: true });
  assert.equal(report.summary.reached_nether, true);
  assert.equal(report.summary.assists_used, 1);
  assert.equal(report.summary.assisted, true);
  assert.equal(report.summary.status, 'ASSISTED');
  assert.equal(report.rows[1].assisted, true);
  assert.ok(world.arena.commands.some((c) => c.startsWith('give Ben_bot minecraft:oak_log')));
});

test('a fallback decision blocks PASS and is counted', async () => {
  const { report } = await play(rawScript(ONE_PLAN, 'garbage', 'still garbage', 'garbage again', tag(ENTER)), { allowAssists: true });
  assert.equal(report.rows[1].fallback, true);
  assert.equal(report.rows[1].attempts, 3);
  assert.equal(report.rows[1].decision.objective, 'nether');
  assert.equal(report.summary.fallback_decisions, 1);
  assert.equal(report.summary.status, 'ASSISTED');
});

test('a run that never reaches the Nether is FAIL even without assists', async () => {
  const { report } = await play(script({ type: 'done', reason: 'giving up' }));
  assert.equal(report.summary.status, 'FAIL');
  assert.equal(report.summary.reached_nether, false);
  assert.equal(report.summary.gave_up, 'giving up');
});

test('request_new_skill is recorded, nothing is written or loaded, and the run continues', async () => {
  const world = createCiWorld({ region, username: 'Ben_bot' });
  const loaded = [];
  const resolve = world.resolve;
  world.resolve = (name) => { loaded.push(name); return resolve(name); };
  const before = fs.readdirSync(path.resolve('skills')).sort();
  const wanted = { type: 'request_new_skill', name: 'crafting.craft_stone_axe', goal: 'craft an axe', why: 'tools have no skill' };
  const { report } = await play(script(wanted, wanted, ENTER), { world });
  assert.deepEqual(report.totals.requested_new_skills,
    [{ name: 'crafting.craft_stone_axe', goal: 'craft an axe', why: 'tools have no skill', count: 2 }]);
  assert.equal(report.rows[1].outcome, 'recorded');
  assert.equal(report.summary.status, 'PASS');
  assert.ok(!loaded.includes('crafting.craft_stone_axe'));
  assert.deepEqual(fs.readdirSync(path.resolve('skills')).sort(), before);
});

test('assist commands stay inside the region guard', async () => {
  const world = createCiWorld({ region, username: 'Ben_bot' });
  const observe = world.arena.observe;
  world.arena.observe = () => { const o = observe(); o.self.position = { x: 5000, y: 70, z: 5000 }; o.facts.position = o.self.position; return o; };
  const { report } = await play(script({ type: 'request_assist', assist: 'build_frame' }, { type: 'done', reason: 'x' }), { world, allowAssists: true });
  assert.equal(report.rows[1].outcome, 'failure');
  assert.match(report.rows[1].reason, /outside_approved_overworld_region/);
  assert.ok(!world.arena.commands.some((c) => c.startsWith('fill')));
});

const slowWorld = (ms) => {
  const world = createCiWorld({ region, username: 'Ben_bot' });
  const resolve = world.resolve;
  world.resolve = (name) => {
    const loaded = resolve(name);
    if (name !== 'resource.collect_wood') return loaded;
    return { ...loaded, run: async (bot, input, { signal }) => {
      const before = bot.observe();
      await new Promise((done, fail) => {
        const t = setTimeout(done, ms);
        signal.addEventListener('abort', () => { clearTimeout(t); fail(signal.reason); });
      });
      return { outcome: 'success', reason: 'slow', elapsed_ms: ms, before, after: bot.observe() };
    } };
  };
  return world;
};
const fakeJev = () => {
  const t0 = Date.now();
  return { read: () => ({ enabled: true, stale: false, age_ms: 5, latency_ms: 5, errors: 0, last_error: null,
    hints: { situation: 'on_tree', situation_confidence: 0.9, danger: Date.now() - t0 > 60 ? 0.95 : 0.1, nearest_hostile: null } }) };
};

test('a Jev danger crossing interrupts the running skill through its abort signal and asks the model again', async () => {
  const j = fakeJev();
  const { report } = await play(script(WOOD, { type: 'request_assist', assist: 'give_wood' }, ENTER),
    { world: slowWorld(5000), jev: true, getJev: () => j, allowAssists: true });
  const [, first, second] = report.rows;
  assert.equal(first.outcome, 'aborted');
  assert.equal(first.reason, 'planner_replaced');
  assert.equal(second.trigger, 'jev_danger');
  assert.equal(second.decision.assist, 'give_wood');
  assert.equal(report.summary.reached_nether, true);
  assert.ok(report.totals.jev_samples.length >= 1);
});

test('a running skill is not asked about again: a changed Jev situation never calls the model', async () => {
  const t0 = Date.now();
  const j = { read: () => ({ enabled: true, stale: false, age_ms: 5, latency_ms: 5, errors: 0, last_error: null,
    hints: { situation: Date.now() - t0 > 60 ? 'on_flat_ground' : 'on_tree', situation_confidence: 0.9, danger: 0.1, nearest_hostile: null } }) };
  const calls = [];
  const inner = script(WOOD, ENTER);
  const { report } = await play(async (p) => { calls.push(p); return inner(); }, { world: slowWorld(600), jev: true, getJev: () => j, jevIntervalMs: 20 });
  assert.equal(calls.length, 3, 'plan, the wood skill, then enter_nether: nothing in between');
  assert.deepEqual(report.rows.map((r) => r.trigger), ['plan_needed', 'plan_made', 'skill_ended']);
  assert.ok(report.rows.every((r) => !['kept', 'aborted', 'discarded'].includes(r.outcome)));
  assert.equal(report.rows[1].outcome, 'success');
  assert.ok(report.totals.jev_samples.some((x) => x.situation === 'on_flat_ground'), 'the situation is still recorded as an observation');
  assert.ok(report.totals.jev_samples.every((x) => !('next_goal' in x)));
  assert.equal(report.summary.status, 'PASS');
});

test('the model summary still carries Jev situation as an observation', async () => {
  const j = fakeJev();
  const { report } = await play(script(ENTER), { jev: true, getJev: () => j });
  assert.equal(report.rows[1].summary_sent.jev.situation, 'on_tree');
});

test('--ci main shows the plan, objective completions and a PASS with zero assists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planned-test-'));
  const lines = [];
  const secretEnv = { ...env, A37_RCON_PASSWORD: 'hunter2-secret', JEV_API_KEY: 'jev-secret-value' };
  try {
    const { output, report } = await main(['--ci', '--start=740,692', '--model', 'haiku', '--unstuck', '--mob-watch', '--jev'],
      secretEnv, { onLine: (l) => lines.push(l), resultsDir: dir });
    const text = fs.readFileSync(output, 'utf8');
    const saved = JSON.parse(text);
    assert.equal(saved.rows.length, 6);
    assert.ok(saved.totals.tokens > 0);
    assert.ok(saved.totals.cost_usd > 0);
    assert.equal(saved.totals.by_model['fake-haiku'].calls, 7);
    assert.ok(Array.isArray(saved.totals.jev_samples));
    assert.equal(saved.summary.status, 'PASS');
    assert.equal(saved.summary.assists_used, 0);
    assert.equal(report.summary.assists_used, 0);
    assert.equal(report.summary.primitive_steps, 3);
    assert.deepEqual(saved.plan.objectives.map((o) => o.id), ['logs', 'planks', 'table', 'nether']);
    assert.deepEqual(saved.plan.completed.map((o) => o.id), ['logs', 'planks', 'table', 'nether']);
    assert.equal(saved.summary.objectives_done, 4);
    assert.deepEqual(saved.candidates.assists, []);
    assert.ok(!saved.advancement_reset);
    assert.deepEqual(saved.advancement_timeline.map((a) => a.advancement), ['minecraft:story/mine_stone', 'minecraft:story/enter_the_nether']);
    for (const key of ['decision', 'objective', 'trigger', 'summary_sent', 'raw_replies', 'outcome', 'reason', 'elapsed_ms', 'tokens', 'cost_usd']) {
      assert.ok(key in saved.rows[0], key);
    }
    assert.doesNotMatch(text, /hunter2|jev-secret|authorization|Bearer/i);
    assert.equal(lines.filter((l) => l.startsWith('PLAN ')).length, 6);
    assert.equal(lines.filter((l) => l.startsWith('PLAN_OBJECTIVES ')).length, 1);
    assert.deepEqual(lines.filter((l) => l.startsWith('OBJECTIVE done ')).map((l) => l.split(' ')[2]), ['logs', 'planks', 'table', 'nether']);
    assert.ok(lines.some((l) => /^SUMMARY PASS .*objectives=4\/4 .*assists_used=0 .*advancements=2 /.test(l)));
    assert.ok(lines.some((l) => /^ADVANCEMENT minecraft:story\/enter_the_nether elapsed=\d+\.\d$/.test(l)));
    assert.deepEqual(saved.rows.filter((r) => r.decision.type === 'primitive').map((r) => [r.decision.name, r.outcome]),
      [['craft', 'success'], ['craft', 'success'], ['place', 'success']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const assistsAllowed = { allowAssists: true };

test('primitives run through the bot adapter only: no RCON, not assisted, and the run can be PASS', async () => {
  const world = createCiWorld({ region, username: 'Ben_bot' });
  const { report } = await play(script({ type: 'primitive', name: 'jump', args: {} },
    { type: 'primitive', name: 'wait', args: { seconds: 0.05 } }, ENTER), { world });
  assert.equal(report.summary.status, 'PASS');
  assert.equal(report.summary.primitive_steps, 2);
  assert.equal(report.summary.assisted, false);
  assert.deepEqual(report.rows.slice(1, 3).map((r) => [r.decision.name, r.outcome, r.assisted, r.moved, r.dug]),
    [['jump', 'success', false, true, false], ['wait', 'success', false, false, false]]);
  assert.deepEqual(world.arena.commands, [], 'no RCON command of any kind');
});

test('a primitive that does nothing is a failure and is removed after two repeats', async () => {
  const world = createCiWorld({ region, username: 'Ben_bot' });
  const baseBot = world.arena.bot;
  world.arena.bot = (signal) => ({ ...baseBot(signal), requestAction() {} });
  const jump = { type: 'primitive', name: 'jump', args: {} };
  const { report } = await play(script(jump, jump, jump, { type: 'done', reason: 'x' }), { world });
  assert.deepEqual(report.rows.slice(1, 3).map((r) => [r.outcome, r.reason]), [['failure', 'no_effect'], ['failure', 'no_effect']]);
  assert.match(report.rows[3].summary_sent.unavailable_options.join(), /primitive:jump/);
  assert.equal(report.rows[3].decision.type, 'done');
});

test('a craft that changes nothing is reported as craft_unconfirmed and does not complete the objective', async () => {
  const world = createCiWorld({ region, username: 'Ben_bot' });
  const baseBot = world.arena.bot, seen = world.arena.observe;
  world.arena.observe = () => { const o = seen(); o.inventory = { ...o.inventory, oak_log: 1 }; return o; };
  world.arena.bot = (signal) => ({ ...baseBot(signal), requestAction(a) { return baseBot(signal).requestAction({ ...a, craft: undefined }); } });
  const planks = objective('planks', { have: { item: 'any_planks', count: 4 } }, '1 log gives 4 planks; hold 1, so 4');
  const { report } = await play(rawScript(planOf(planks), { type: 'primitive', name: 'craft', args: { name: 'oak_planks', count: 4 }, objective: 'planks' },
    { type: 'done', reason: 'craft did not work' }), { world, minutes: 1, primitiveClock: { limits: { craftMs: 100 } } });
  assert.equal(report.rows[1].reason, 'craft_unconfirmed');
  assert.deepEqual(report.plan.completed, []);
  assert.equal(report.summary.gave_up, 'craft did not work');
});

test('assists are off by default: the model never sees them, an assist reply is rejected, bad output ends the run', async () => {
  const prompts = [];
  let acts = 0;
  const model = async (prompt) => {
    prompts.push(prompt);
    if (prompt.includes('FIRST make a plan')) return reply(ONE_PLAN);
    return reply(++acts === 1 ? { type: 'request_assist', objective: 'nether', assist: 'give_wood' } : 'garbage');
  };
  const world = createCiWorld({ region, username: 'Ben_bot' });
  const { report } = await play(model, { world });
  assert.ok(prompts.every((x) => !x.includes('give_wood') && !x.includes('build_frame')));
  assert.match(prompts[2], /assists_disabled/);
  assert.deepEqual(report.rows[1].decision, { type: 'done', reason: 'invalid_model_output', fallback: true });
  assert.equal(report.summary.assists_used, 0);
  assert.deepEqual(world.arena.commands, []);
});

test('with allowAssists an assist works and the status can never be PASS', async () => {
  const { report, world } = await play(script({ type: 'request_assist', assist: 'give_wood' }, ENTER), assistsAllowed);
  assert.equal(report.assists_allowed, true);
  assert.equal(report.summary.assists_used, 1);
  assert.equal(report.summary.status, 'ASSISTED');
  assert.ok(world.arena.commands.some((c) => c.startsWith('give Ben_bot')));
  assert.deepEqual(parsePlannedOptions(['--ci', '--start=740,692', '--model', 'haiku', '--allow-assists'], env).allowAssists, true);
  assert.equal(parsePlannedOptions(['--ci', '--start=740,692', '--model', 'haiku'], env).allowAssists, false);
});

test('advancement revoke is sent only with the flag and only with the exact bot name', async () => {
  const withoutFlag = await play(script(ENTER));
  assert.ok(!withoutFlag.world.arena.commands.some((c) => c.startsWith('advancement')));
  assert.equal(withoutFlag.report.advancement_reset, null);
  for (const bot of ['Ben_bot', 'Vikram_bot']) {
    const world = createCiWorld({ region, username: bot });
    const load = makeSkillLoader(world.resolve);
    const { candidates } = await buildCandidates(load);
    const report = await runPlanned({ arena: world.arena, planner: createPlanner({ callModel: script(ENTER), candidates }), load,
      username: bot, region, minutes: 1, minIntervalMs: 0, pollMs: 10, onLine() {}, resetAdvancements: true });
    const sent = world.arena.commands.filter((c) => c.startsWith('advancement'));
    assert.deepEqual(sent, [`advancement revoke ${bot} everything`]);
    assert.equal(report.advancement_reset.reply, `Revoked every advancement from ${bot}`);
    assert.equal(report.rows[0].n, 1);
  }
  assert.deepEqual(parsePlannedOptions(['--ci', '--start=740,692', '--model', 'haiku', '--reset-advancements'], env).resetAdvancements, true);
  assert.equal(parsePlannedOptions(['--ci', '--start=740,692', '--model', 'haiku'], env).resetAdvancements, false);
});

test('the timeline records each newly done advancement once, with a printed line, and not the ones held at the start', async () => {
  const { report, lines } = await play(script(WOOD, WOOD, ENTER));
  assert.deepEqual(report.advancement_timeline.map((a) => a.advancement), ['minecraft:story/mine_stone', 'minecraft:story/enter_the_nether']);
  for (const entry of report.advancement_timeline) {
    assert.ok(Number.isFinite(entry.elapsed_ms) && entry.elapsed_ms >= 0 && entry.step >= 1 && typeof entry.at === 'string');
  }
  assert.ok(!report.advancement_timeline.some((a) => a.advancement.endsWith('/root')), 'root was done before the run');
  assert.match(report.summary_line, /advancements=2/);
  assert.equal(lines.filter((l) => l.startsWith('ADVANCEMENT ')).length, 2);
});

test('the region has no protected radius: iron descent works next to the start; the outer limit stays', async () => {
  assert.equal(parsePlannedOptions(['--ci', '--start=740,692', '--model', 'haiku'], env).region.protected, false);
  const { report } = await play(script({ type: 'run_skill', skill: 'resource.mine_iron_ore', input: { descent: true } }, ENTER));
  assert.equal(report.region.protected, false);
  assert.notEqual(report.rows[1].reason, 'descent_bounds_outside_region');
  const world = createCiWorld({ region, username: 'Ben_bot' });
  const observe = world.arena.observe;
  world.arena.observe = () => { const o = observe(); o.self.position = { x: 740 + 390, y: 70, z: 692 }; o.facts.position = o.self.position; return o; };
  const far = await play(script({ type: 'run_skill', skill: 'resource.mine_iron_ore', input: { descent: true } }, { type: 'done', reason: 'x' }), { world });
  assert.equal(far.report.rows[1].reason, 'descent_bounds_outside_region');
});

test('a watchdog that fires but cannot act is recorded, not dropped', async () => {
  const slow = slowWorld(1500);
  const arena = slow.arena;
  arena.blockAt = () => null;
  const { report } = await play(script(WOOD, ENTER), { world: slow, unstuck: true, watchdogLimits: { stuckAfterMs: 50 } });
  assert.ok(report.watchdog_events.length >= 1);
  assert.equal(report.watchdog_events[0].acted, false);
  assert.equal(report.watchdog_events[0].reason, 'no_safe_spot');
  assert.equal(report.summary.watchdog.noops, report.watchdog_events.length);
  assert.equal(report.summary.watchdog_actions, 0);
  assert.equal(report.summary.status, 'PASS');
});

// ---- threat policy: the model's own rules, applied at once ----
const sleepMs = (ms) => new Promise((done) => { setTimeout(done, ms); });
const waitFor = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('waitFor timed out'); await sleepMs(5); }
};
const fakeClock = () => { const c = { t: 1000, now: () => c.t, sleep: async (ms) => { c.t += ms; } }; return c; };
const PLANNED_POLICY = { zombie_like: { action: 'fight', min_health: 8, flee_distance: 12 }, creeper: { action: 'flee', flee_distance: 14 },
  creeper_fuse: { action: 'flee', flee_distance: 12 }, other_hostile: { action: 'flee', flee_distance: 16 } };
const planWith = (policy, ...objectives) => ({ type: 'plan', objectives: objectives.length ? objectives : [NETHER], threat_policy: policy });

// Wraps a CI world with a moving fake bot, mobs and an event log. Mobs are placed relative to the start (ox east, oz south).
function threatWorld(world, { clock = null, events = [], health = 20, mobs = [] } = {}) {
  const st = { dx: 0, dz: 0, yaw: 0, health, mobs: mobs.map((m) => ({ ...m })) };
  let start = null;
  const base = world.arena.observe;
  world.arena.observe = () => {
    const o = base();
    start ??= { ...o.self.position };
    const p = { x: start.x + st.dx, y: start.y, z: start.z + st.dz };
    o.self.position = p; o.facts.position = p; o.self.yaw = st.yaw; o.self.health = st.health;
    o.facts.nearby_mobs = st.mobs.map((m) => { const dx = start.x + m.ox - p.x, dz = start.z + m.oz - p.z;
      return { id: m.id, type: m.type, hostile: m.hostile !== false, dx, dy: 0, dz, distance: Math.hypot(dx, dz) }; });
    return o;
  };
  const baseBot = world.arena.bot;
  world.arena.bot = (signal) => {
    const b = baseBot(signal);
    return Object.freeze({ ...b, requestAction(a) {
      events.push({ kind: 'action', t: clock?.now() ?? 0, a });
      st.yaw += a.yaw_delta ?? 0;
      if (a.forward) { st.dx += -Math.sin(st.yaw) * 0.3; st.dz += -Math.cos(st.yaw) * 0.3; }
      return b.requestAction(a);
    } });
  };
  return { st, events, world, startPosition: () => ({ ...(start ?? world.arena.observe().self.position) }) };
}
// A model that plans first, then answers each decision with act(prompt, n).
const actor = (events, plan, act, clock = null) => { let n = 0; return async (prompt) => {
  events.push({ kind: 'model', t: clock?.now() ?? 0, prompt });
  return reply(prompt.includes('FIRST make a plan') ? plan : act(prompt, ++n)); }; };
const REPORTED = '"threat_report":';

test('a creeper fuse sound starts the creeper_fuse rule at once, with no model call before it, and then the model is told', async () => {
  const clock = fakeClock(), events = [];
  const tw = threatWorld(slowWorld(5000), { clock, events });
  const model = actor(events, planWith(PLANNED_POLICY), (prompt) => tag(prompt.includes(REPORTED) ? ENTER : WOOD), clock);
  const running = play(model, { world: tw.world, threatPollMs: 20, reactionClock: clock.now, primitiveClock: { now: clock.now, sleep: clock.sleep } });
  await waitFor(() => events.filter((e) => e.kind === 'model').length === 2);
  await sleepMs(40);
  const p = tw.startPosition();
  events.push({ kind: 'sound', t: clock.now() });
  tw.world.arena.emitSound({ name: 'entity.creeper.primed', category: 'hostile', position: { x: p.x + 3, y: p.y, z: p.z } });
  const { report, lines } = await running;
  const sound = events.findIndex((e) => e.kind === 'sound');
  const firstAction = events.findIndex((e, i) => i > sound && e.kind === 'action');
  const nextModel = events.findIndex((e, i) => i > sound && e.kind === 'model');
  assert.ok(firstAction > sound, 'the bot acted after the sound');
  assert.ok(nextModel > firstAction, 'the first move came before any model call');
  assert.ok(events[firstAction].t - events[sound].t <= 300, `reaction ${events[firstAction].t - events[sound].t} ms on the fake clock`);
  const row = report.rows.find((r) => r.reflex);
  assert.equal(row.trigger, 'threat:creeper_fuse');
  assert.deepEqual([row.decision.name, row.decision.args.blocks, row.decision.rule], ['flee', 12, 'creeper_fuse']);
  assert.ok(row.decision.args.away_from.dx > 2.9 && Math.abs(row.decision.args.away_from.dz) < 0.1, 'away from where the sound came from');
  assert.equal(events[firstAction].a.sprint, true, 'sprinting away');
  assert.deepEqual([row.outcome, row.reason], ['success', 'fled']);
  assert.ok(report.threat.events[0].reaction_ms <= 300);
  assert.equal(report.threat.events[0].kind, 'creeper_fuse');
  const before = report.rows[report.rows.indexOf(row) - 1];
  assert.deepEqual([before.decision.skill, before.outcome, before.reason], ['resource.collect_wood', 'aborted', 'threat_reflex']);
  const told = report.rows[report.rows.indexOf(row) + 1];
  assert.equal(told.trigger, 'threat_response');
  assert.equal(told.summary_sent.threat_report.what_happened[0].kind, 'creeper_fuse');
  assert.equal(told.summary_sent.threat_report.what_happened[0].outcome, 'success');
  assert.deepEqual(told.summary_sent.threat_policy, PLANNED_POLICY);
  assert.ok(lines.some((l) => l.startsWith('THREAT creeper_fuse rule=creeper_fuse action=flee')));
  assert.deepEqual([report.summary.assisted, report.summary.assists_used, row.assisted, report.summary.threat_responses], [false, 0, false, 1]);
  assert.equal(report.summary.status, 'PASS', 'threat responses are the bot own actions, not assists');
  assert.deepEqual(tw.world.arena.commands, [], 'no RCON command of any kind');
});

test('a creeper_fuse sound far away, another sound, an ignore rule, or no policy does nothing', async () => {
  for (const [name, sound, policy] of [['far', { name: 'entity.creeper.primed', position: { dx: 40, dz: 0 } }, PLANNED_POLICY],
    ['other', { name: 'entity.creeper.hurt', position: { dx: 2, dz: 0 } }, PLANNED_POLICY],
    ['ignored', { name: 'entity.creeper.primed', position: { dx: 2, dz: 0 } }, { ...PLANNED_POLICY, creeper_fuse: { action: 'ignore', flee_distance: 8 } }]]) {
    const events = [];
    const tw = threatWorld(slowWorld(300), { events });
    const model = actor(events, planWith(policy), (prompt, n) => tag(n === 1 ? WOOD : ENTER));
    const running = play(model, { world: tw.world, threatPollMs: 20 });
    await waitFor(() => events.filter((e) => e.kind === 'model').length === 2);
    const p = tw.startPosition();
    tw.world.arena.emitSound({ name: sound.name, category: 'hostile', position: { x: p.x + sound.position.dx, y: p.y, z: p.z + sound.position.dz } });
    const { report } = await running;
    assert.equal(report.rows.filter((r) => r.reflex).length, 0, name);
    assert.equal(report.summary.status, 'PASS', name);
  }
});

test('a fight rule below min_health flees instead of fighting; above it the bot attacks', async () => {
  const outcomes = {};
  for (const health of [6, 15]) {
    const clock = fakeClock(), events = [];
    const tw = threatWorld(slowWorld(600), { clock, events, health, mobs: [{ id: 9, type: 'zombie', ox: 5, oz: 0 }] });
    const model = actor(events, planWith(PLANNED_POLICY), (prompt) => tag(prompt.includes(REPORTED) ? ENTER : WOOD), clock);
    const { report } = await play(model, { world: tw.world, threatPollMs: 20, reactionClock: clock.now, primitiveClock: { now: clock.now, sleep: clock.sleep } });
    const row = report.rows.find((r) => r.reflex);
    outcomes[health] = { name: row.decision.name, args: row.decision.args, swung: events.some((e) => e.a?.attack_entity === 9), why: report.threat.events[0].why };
    assert.equal(row.assisted, false);
    assert.equal(report.summary.status, 'PASS');
  }
  assert.deepEqual(outcomes[6], { name: 'flee', args: { from_mob_id: 9, blocks: 12 }, swung: false, why: 'health_below_min_health' });
  assert.deepEqual([outcomes[15].name, outcomes[15].args, outcomes[15].swung], ['attack', { mob_id: 9 }, true]);
});

test('a decision made while a threat response ran is discarded, and the model is asked again with what happened', async () => {
  const clock = fakeClock(), events = [];
  const tw = threatWorld(slowWorld(300), { clock, events, health: 15, mobs: [{ id: 9, type: 'zombie', ox: 5, oz: 0 }] });
  const inner = actor(events, planWith(PLANNED_POLICY), (prompt) => tag(prompt.includes(REPORTED) ? ENTER : WOOD), clock);
  const slow = async (prompt) => { if (!prompt.includes('FIRST make a plan') && !prompt.includes(REPORTED)) await sleepMs(250); return inner(prompt); };
  const { report } = await play(slow, { world: tw.world, threatPollMs: 20, reactionClock: clock.now, primitiveClock: { now: clock.now, sleep: clock.sleep } });
  const discarded = report.rows.find((r) => r.outcome === 'discarded');
  assert.equal(discarded.reason, 'threat_response_ran_during_this_decision');
  assert.ok(report.rows.indexOf(discarded) > report.rows.findIndex((r) => r.reflex));
  const again = report.rows[report.rows.indexOf(discarded) + 1];
  assert.equal(again.trigger, 'threat_response');
  assert.equal(again.summary_sent.threat_report.what_happened[0].kind, 'hostile_close');
  assert.equal(report.summary.status, 'PASS');
});

test('a hostile the policy ignores interrupts a running skill with a hostile_close call; nothing is forced', async () => {
  const events = [];
  const tw = threatWorld(slowWorld(5000), { events });
  const policy = { creeper_fuse: { action: 'flee', flee_distance: 10 }, other_hostile: { action: 'ignore', flee_distance: 8 } };
  const model = actor(events, planWith(policy), (prompt) => tag(prompt.includes('hostile_close') || prompt.includes('"id":4') ? ENTER : WOOD));
  const running = play(model, { world: tw.world, threatPollMs: 20 });
  await waitFor(() => events.filter((e) => e.kind === 'model').length === 2);
  tw.st.mobs.push({ id: 4, type: 'zombie', ox: 5, oz: 0 });
  const { report } = await running;
  assert.equal(report.rows[2].trigger, 'hostile_close');
  assert.deepEqual([report.rows[1].outcome, report.rows[1].reason], ['aborted', 'planner_replaced']);
  assert.equal(report.rows.filter((r) => r.reflex).length, 0, 'an ignore rule forces nothing');
  assert.deepEqual(report.rows[2].summary_sent.hostiles.map((h) => [h.id, h.type]), [[4, 'zombie']]);
  assert.equal(report.summary.status, 'PASS');
});

test('set_threat_policy is validated, logged with its reason, and shown back to the model; a bad one changes nothing', async () => {
  const events = [];
  const NEW = { ...PLANNED_POLICY, zombie_like: { action: 'flee', flee_distance: 20 } };
  const set = { type: 'set_threat_policy', why: 'a zombie hit hard, so I flee from them from now on', policy: NEW };
  const bad = { type: 'set_threat_policy', why: 'forgot the fuse', policy: { zombie_like: { action: 'fight', flee_distance: 8 } } };
  const prompts = [];
  const model = actor(events, planWith(PLANNED_POLICY), (prompt, n) => { prompts.push(prompt); return n === 1 ? set : n === 2 ? bad : tag(ENTER); });
  const { report, lines } = await play(model, { world: threatWorld(createCiWorld({ region, username: 'Ben_bot' }), { events }).world, threatPollMs: 20 });
  assert.deepEqual(report.threat.policy_changes.map((c) => [c.n, c.why, c.policy]), [[2, set.why, NEW]]);
  assert.deepEqual(report.threat.policy, NEW);
  assert.equal(report.summary.threat_policy_changes, 1);
  assert.equal(report.rows[1].reason, 'policy_set');
  assert.equal(report.rows[1].trigger, 'plan_made');
  assert.equal(report.rows[2].trigger, 'policy_set');
  assert.match(lines.find((l) => l.startsWith('THREAT_POLICY_SET 1 ')), /why="a zombie hit hard/);
  assert.ok(lines.some((l) => l.startsWith('THREAT_POLICY {')));
  assert.match(prompts[1], /"threat_policy":\{"zombie_like":\{"action":"flee","flee_distance":20\}/);
  assert.match(prompts[2], /threat_policy_needs_creeper_fuse/);
  assert.equal(report.rows.length, 3, 'the rejected policy was retried, not applied');
  assert.equal(report.summary.status, 'PASS');
  assert.equal(report.rows[1].assisted, false);
});

test('one invalid reply does not end a run, and three in a row do', async () => {
  const survive = await play(rawScript(ONE_PLAN, 'not json', tag(ENTER)));
  assert.equal(survive.report.summary.status, 'PASS');
  assert.deepEqual([survive.report.rows[1].attempts, survive.report.rows[1].fallback], [2, false]);
  const prompts = [];
  const inner = rawScript(ONE_PLAN, 'a', 'b', 'c', tag(ENTER));
  const dead = await play(async (p) => { prompts.push(p); return inner(); });
  assert.equal(dead.report.rows[1].attempts, 3);
  assert.deepEqual(dead.report.rows[1].decision, { type: 'done', reason: 'invalid_model_output', fallback: true });
  assert.equal(dead.report.summary.status, 'FAIL');
  assert.equal(prompts.length, 4, 'plan plus three tries, then the run ends');
});

test('the retreat reflex is off in planned runs and unchanged at the default everywhere else', async () => {
  assert.deepEqual({ ...PLANNED_RUNTIME_OPTIONS }, { retreatHealth: 0 });
  let seen;
  const arena = await openPlannedArena(env, 'dir', region, true, async (...args) => { seen = args; return 'arena'; });
  assert.equal(arena, 'arena');
  assert.deepEqual(seen.slice(0, 4), [env, 'dir', region, true]);
  assert.deepEqual(seen[4], { retreatHealth: 0 });
  const { createRuntime } = await import('../server.js');
  const { fakeWorldBot } = await import('../fixtures/observation/fake-world.js');
  const dirs = [], runtimes = [];
  const make = async (extra) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-retreat-'));
    dirs.push(dataDir);
    const rt = await createRuntime({ bot: fakeWorldBot(), webPort: 0, dataDir, session: 'retreat', ...extra });
    runtimes.push(rt);
    return rt;
  };
  try {
    const planned = await make({ ...PLANNED_RUNTIME_OPTIONS }), normal = await make({});
    assert.deepEqual([planned.arbiter.retreatHealth, normal.arbiter.retreatHealth], [0, 4]);
    for (const rt of [planned, normal]) rt.arbiter.set('skill', { forward: true }, 'test');
    assert.equal(planned.arbiter.tick({ health: 2 }).source, 'skill', 'low health does not take control from the skill');
    const forced = normal.arbiter.tick({ health: 2 });
    assert.deepEqual([forced.source, forced.reason], ['survival', 'retreat_health']);
  } finally { for (const rt of runtimes) rt.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
});

test('a Jev danger of 0.6 now interrupts a running skill, and 0.45 does not', async () => {
  const at = (level) => { const t0 = Date.now(); return { read: () => ({ enabled: true, stale: false, age_ms: 5, latency_ms: 5, errors: 0, last_error: null,
    hints: { situation: 'on_tree', situation_confidence: 0.9, danger: Date.now() - t0 > 60 ? level : 0.1, nearest_hostile: null } }) }; };
  const hot = at(0.6);
  const up = await play(script(WOOD, { type: 'request_assist', assist: 'give_wood' }, ENTER), { world: slowWorld(5000), jev: true, getJev: () => hot, allowAssists: true });
  assert.deepEqual([up.report.rows[1].outcome, up.report.rows[2].trigger], ['aborted', 'jev_danger']);
  const warm = at(0.45);
  const calm = await play(script(WOOD, ENTER), { world: slowWorld(400), jev: true, getJev: () => warm });
  assert.ok(calm.report.rows.every((r) => r.trigger !== 'jev_danger'));
  assert.equal(calm.report.rows[1].outcome, 'success');
});

test('the combat skill is offered with its limit stated, and a combat run takes only zombies', async () => {
  const world = createCiWorld({ region, username: 'Ben_bot' });
  const { candidates } = await buildCandidates(makeSkillLoader(world.resolve));
  assert.match(candidates.skills['combat.kill_hostile'].description, /Only zombies are trained/);
  assert.deepEqual(candidates.skills['combat.kill_hostile'].input, {});
  assert.ok(candidates.primitives.attack && candidates.primitives.flee);
  const { report } = await play(script({ type: 'run_skill', skill: 'combat.kill_hostile', input: {} }, ENTER));
  assert.equal(report.rows[1].outcome, 'success');
  assert.deepEqual(report.rows[1].input, { target_type: 'zombie' });
});
