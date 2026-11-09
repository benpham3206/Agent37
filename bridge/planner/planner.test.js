import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { CI_POLICY } from '../eval/planned.mjs';
import { createPlanner, shouldDecide, removedOptions, validateDecision, parseReply, buildPrompt, DEFAULT_LIMITS, conditionMet, countItem, validateObjectives } from './planner.mjs';
import { PRIMITIVE_SPECS, createPrimitiveRunner } from './primitives.mjs';
import { cliArgs, childEnv, createCliModel } from './model-cli.mjs';

const candidates = {
  allowAssists: true, primitives: PRIMITIVE_SPECS,
  skills: {
    'resource.collect_wood': { input: {}, requires: (s) => !s.inventory.oak_log },
    'resource.mine_iron_ore': { input: { descent: 'boolean' }, requires: (s) => Boolean(s.inventory.stone_pickaxe) },
  },
  assists: { give_wood: { requires: () => true }, give_tools: { requires: () => true } },
  order: [{ kind: 'skill', name: 'resource.collect_wood' }, { kind: 'assist', name: 'give_tools' },
    { kind: 'skill', name: 'resource.mine_iron_ore' }],
};
const reply = (obj, extra = {}) => ({ text: typeof obj === 'string' ? obj : JSON.stringify(obj),
  usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  cost_usd: 0.001, model: 'fake', ...extra });
const scripted = (...items) => { const calls = []; let i = 0;
  const fn = async (prompt) => { calls.push(prompt); const x = items[Math.min(i++, items.length - 1)]; if (x instanceof Error) throw x; return x; };
  fn.calls = calls; return fn; };
const obs = { position: { x: 1, y: 70, z: 2 }, dimension: 'overworld', health: 20, inventory: { oak_log: 0 }, facts: { nearest_blocks: {} } };
const plan = (callModel, limits) => createPlanner({ callModel, candidates, limits });
const decide = (planner, extra = {}) => planner.decide({ observation: obs, jev: null, history: [], trigger: 'test', ...extra });

test('all four decision types pass validation', async () => {
  for (const d of [
    { type: 'run_skill', skill: 'resource.collect_wood', input: {} },
    { type: 'run_skill', skill: 'resource.mine_iron_ore', input: { descent: true } },
    { type: 'request_assist', assist: 'give_wood' },
    { type: 'request_new_skill', name: 'crafting.craft_stone_axe', goal: 'craft', why: 'none exists' },
    { type: 'done', reason: 'finished' }]) {
    const planner = plan(scripted(reply(d)));
    const out = await decide(planner);
    assert.equal(out.fallback, undefined, JSON.stringify(d));
    assert.equal(out.type, d.type);
  }
});

test('invalid replies are each rejected by the validator', () => {
  const bad = [
    [{ type: 'run_skill', skill: 'resource.dance' }, /unknown_skill/],
    [{ type: 'request_assist', assist: 'give_diamonds' }, /unknown_assist/],
    [{ type: 'done', reason: 'x', extra: 1 }, /unknown_field:extra/],
    [{ type: 'run_skill', skill: 'resource.collect_wood', input: { descent: true } }, /input_field_not_allowed/],
    [{ type: 'run_skill', skill: 'resource.mine_iron_ore', input: { descent: 'yes' } }, /wrong_type/],
    [{ type: 'run_skill', skill: 'resource.mine_iron_ore', input: { bounds: {} } }, /input_field_not_allowed/],
    [{ type: 'teleport' }, /unknown_type/],
    [{ type: 'request_new_skill', name: 'resource.collect_wood', goal: 'g', why: 'w' }, /skill_already_exists/],
    [{ type: 'request_new_skill', name: 'Bad Name!', goal: 'g', why: 'w' }, /invalid_skill_name/],
    [{ type: 'run_skill' }, /missing_field:skill/],
  ];
  for (const [value, pattern] of bad) assert.throws(() => validateDecision(value, candidates), pattern, JSON.stringify(value));
  assert.throws(() => parseReply('sure, collect wood'), /reply_not_json/);
  assert.throws(() => parseReply('[1]'), /not_an_object/);
});

test('an invalid reply is retried once with the error, then a valid retry is used', async () => {
  const model = scripted(reply('collect some wood please'), reply({ type: 'done', reason: 'ok' }));
  const out = await decide(plan(model));
  assert.deepEqual(out, { type: 'done', reason: 'ok' });
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1], /previous reply was rejected: reply_not_json/);
});

test('three invalid replies in a row fall back to the first candidate whose requirements are met', async () => {
  const planner = plan(scripted(reply('nope'), reply({ type: 'run_skill', skill: 'bogus' }), reply('nope again')));
  const out = await decide(planner);
  assert.deepEqual(out, { type: 'run_skill', skill: 'resource.collect_wood', input: {}, fallback: true });
  const withLogs = await createPlanner({ callModel: scripted(reply('x'), reply('y'), reply('z')), candidates })
    .decide({ observation: { ...obs, inventory: { oak_log: 5 } }, history: [] });
  assert.deepEqual(withLogs, { type: 'request_assist', assist: 'give_tools', fallback: true });
  assert.equal(planner.traceOf(out).fallback, true);
});

test('a throwing model call also falls back after three tries', async () => {
  const model = scripted(new Error('boom'), new Error('boom'), new Error('boom'));
  const out = await decide(plan(model));
  assert.equal(out.fallback, true);
  assert.equal(model.calls.length, 3);
});

test('the decision budget ends the run with budget:decisions', async () => {
  const planner = plan(scripted(reply({ type: 'request_assist', assist: 'give_wood' })), { decisions: 2 });
  await decide(planner); await decide(planner);
  assert.deepEqual(await decide(planner), { type: 'done', reason: 'budget:decisions' });
});

test('the token budget ends the run with budget:tokens and totals are tracked per model', async () => {
  const planner = plan(scripted(reply({ type: 'request_assist', assist: 'give_wood' }, { usage: { input_tokens: 900, output_tokens: 100 } })), { tokens: 1500 });
  await decide(planner); await decide(planner);
  assert.deepEqual(await decide(planner), { type: 'done', reason: 'budget:tokens' });
  const totals = planner.totals();
  assert.equal(totals.tokens, 2000);
  assert.equal(totals.by_model.fake.calls, 2);
  assert.ok(Math.abs(totals.by_model.fake.cost_usd - 0.002) < 1e-9);
});

test('an option that failed twice in a row with the same input is removed', async () => {
  const d = { type: 'run_skill', skill: 'resource.mine_iron_ore', input: { descent: true } };
  const failed = (n) => ({ n, decision: d, outcome: 'failure', reason: 'x' });
  assert.equal(removedOptions([failed(1)]).size, 0);
  assert.equal(removedOptions([failed(1), failed(2)]).size, 1);
  assert.equal(removedOptions([failed(1), { n: 2, decision: { type: 'done', reason: 'x' }, outcome: 'done' }, failed(3)]).size, 0);
  assert.equal(removedOptions([failed(1), { ...failed(2), decision: { ...d, input: {} } }]).size, 0);
  const model = scripted(reply(d), reply({ type: 'done', reason: 'gave up' }));
  const out = await decide(plan(model), { history: [failed(1), failed(2)] });
  assert.deepEqual(out, { type: 'done', reason: 'gave up' });
  assert.match(model.calls[1], /option_removed_after_repeated_failure/);
  assert.match(model.calls[0], /unavailable_options.*iron_ore/);
});

test('when every option is removed the run ends with budget:options', async () => {
  const only = { skills: { a: { input: {} } }, assists: {}, order: [] };
  const planner = createPlanner({ callModel: scripted(reply('x')), candidates: only });
  const f = (n) => ({ n, decision: { type: 'run_skill', skill: 'a', input: {} }, outcome: 'failure' });
  const out = await planner.decide({ observation: obs, history: [f(1), f(2)] });
  assert.deepEqual(out, { type: 'done', reason: 'budget:options' });
});

test('a null or stale Jev does not crash and the summary says so', async () => {
  const model = scripted(reply({ type: 'done', reason: 'ok' }));
  const planner = plan(model);
  await decide(planner, { jev: null });
  assert.equal(planner.traceOf(await decide(planner, { jev: null })).summary.jev.available, false);
  assert.match(model.calls[0], /Jev is not running/);
  const stale = await decide(planner, { jev: { enabled: true, stale: true, situation: 'on_tree', danger: 0.9, age_ms: 9000 } });
  assert.match(planner.traceOf(stale).summary.jev.note, /stale/);
  assert.equal(planner.traceOf(stale).summary.jev.stale, true);
});

test('the summary is compact: last 8 decisions, nearest blocks only, no raw observation', async () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, decision: { type: 'done', reason: 'r' }, outcome: 'done' }));
  const facts = { nearest_blocks: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`b${i}`, { type: `b${i}`, distance: 10 - i, dx: 1, dy: 1, dz: 1 }])) };
  const planner = plan(scripted(reply({ type: 'done', reason: 'ok' })));
  const out = await decide(planner, { history, observation: { ...obs, facts, terrain: { big: 'x'.repeat(5000) } } });
  const s = planner.traceOf(out).summary;
  assert.equal(s.recent_decisions.length, 8);
  assert.equal(s.recent_decisions[0].n, 5);
  assert.equal(s.nearest_blocks.length, 6);
  assert.equal(s.nearest_blocks[0].type, 'b9');
  assert.ok(!JSON.stringify(s).includes('xxxxx'));
});

const base = { now: 100000, lastDecisionAt: 0, skillActive: true, jev: null, prevJev: null };
const fresh = (o) => ({ enabled: true, stale: false, danger: 0, situation: 'on_tree', ...o });

test('shouldDecide: a finished skill decides at once, even inside the 5 second window', () => {
  assert.deepEqual(shouldDecide({ ...base, now: 1000, skillEnded: true }), { decide: true, trigger: 'skill_ended', deferred: false });
  assert.equal(shouldDecide({ ...base, skillActive: false }).trigger, 'no_active_skill');
  assert.equal(shouldDecide({ ...base, skillActive: false, now: 3000 }).decide, false);
});

test('shouldDecide: danger triggers once per upward crossing of 0.5', () => {
  const up = shouldDecide({ ...base, jev: fresh({ danger: 0.55 }), prevJev: { danger: 0.3, situation: 'on_tree' } });
  assert.deepEqual([up.decide, up.trigger], [true, 'jev_danger']);
  const stay = shouldDecide({ ...base, jev: fresh({ danger: 0.9 }), prevJev: { danger: 0.55, situation: 'on_tree' } });
  assert.equal(stay.decide, false);
  const down = shouldDecide({ ...base, jev: fresh({ danger: 0.3 }), prevJev: { danger: 0.9, situation: 'on_tree' } });
  const below = shouldDecide({ ...base, jev: fresh({ danger: 0.45 }), prevJev: { danger: 0.1, situation: 'on_tree' } });
  assert.equal(below.decide, false, 'under 0.5 does not interrupt');
  assert.equal(down.decide, false);
  const again = shouldDecide({ ...base, jev: fresh({ danger: 0.51 }), prevJev: { danger: 0.3, situation: 'on_tree' } });
  assert.equal(again.trigger, 'jev_danger');
});

test('shouldDecide: a Jev situation change never triggers a call, and jev_goal_change is gone', () => {
  const changed = shouldDecide({ ...base, jev: fresh({ situation: 'on_flat_ground' }), prevJev: { danger: 0, situation: 'on_tree' } });
  assert.deepEqual([changed.decide, changed.trigger], [false, null]);
  assert.ok(!fs.readFileSync(new URL('./planner.mjs', import.meta.url), 'utf8').includes('jev_situation_change'));
  assert.equal(shouldDecide({ ...base, jev: fresh({ situation: 'on_tree' }), prevJev: { danger: 0, situation: 'on_tree' } }).decide, false);
  assert.equal(shouldDecide({ ...base, jev: fresh({ next_goal: 'iron', situation: 'on_tree' }), prevJev: { danger: 0, next_goal: 'wood', situation: 'on_tree' } }).decide, false);
  assert.ok(!fs.readFileSync(new URL('./planner.mjs', import.meta.url), 'utf8').includes('jev_goal_change'));
});

test('shouldDecide: a missing plan, a new plan, a finished objective or a finished action each decide at once', () => {
  for (const [flag, trigger] of [['planNeeded', 'plan_needed'], ['planMade', 'plan_made'], ['objectiveDone', 'objective_done'], ['skillEnded', 'skill_ended']]) {
    const r = shouldDecide({ ...base, now: 10, skillActive: false, [flag]: true });
    assert.deepEqual([r.decide, r.trigger], [true, trigger]);
  }
  assert.equal(shouldDecide({ ...base, now: 10 }).decide, false, 'a running skill with a quiet Jev is left alone');
});

test('shouldDecide: stale or disabled Jev never triggers', () => {
  const prevJev = { danger: 0, situation: 'on_tree' };
  assert.equal(shouldDecide({ ...base, jev: fresh({ stale: true, danger: 0.99, situation: 'in_water' }), prevJev }).decide, false);
  assert.equal(shouldDecide({ ...base, jev: { enabled: false }, prevJev }).decide, false);
  assert.equal(shouldDecide({ ...base, jev: null, prevJev }).decide, false);
});

test('shouldDecide: a Jev trigger inside 5 seconds is deferred, then fires once spacing allows', () => {
  const j = fresh({ danger: 0.95 }), prevJev = { danger: 0.1, situation: 'on_tree' };
  const early = shouldDecide({ ...base, now: 3000, jev: j, prevJev });
  assert.deepEqual([early.decide, early.trigger, early.deferred], [false, 'jev_danger', true]);
  const later = shouldDecide({ ...base, now: 5000, jev: j, prevJev: { danger: 0.95, situation: 'on_tree' }, pendingTrigger: 'jev_danger' });
  assert.deepEqual([later.decide, later.trigger], [true, 'jev_danger']);
});

test('cli args disable tools, MCP, hooks and sessions and select the model', () => {
  const args = cliArgs('haiku');
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes('-p'));
  assert.equal(at('--model'), 'haiku');
  assert.equal(at('--output-format'), 'json');
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(at('--tools'), '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--mcp-config'));
  assert.equal(JSON.parse(at('--settings')).disableAllHooks, true);
  assert.equal(at('--setting-sources'), '');
  assert.throws(() => cliArgs('haiku; rm -rf /'), /model must be/);
  assert.equal(cliArgs('claude-sonnet-4-5')[2], 'claude-sonnet-4-5');
});

test('the child environment is an allow-list with no session id, key, token or password', () => {
  const env = childEnv({ PATH: '/bin', Path: 'C:\\x', USERPROFILE: 'C:\\u', CLAUDE_CODE_SESSION_ID: 's', JEV_API_KEY: 'k',
    A37_RCON_PASSWORD: 'p', GITHUB_TOKEN: 't', ANTHROPIC_API_KEY: 'a', RANDOM_VAR: '1', MY_KEYBOARD: 'x' });
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'Path', 'USERPROFILE']);
  for (const name of Object.keys(env)) assert.doesNotMatch(name, /KEY|TOKEN|PASSWORD|SESSION/i);
});

const fakeSpawn = (behaviour) => { const spawned = [];
  const impl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end(text) { child.stdinText = text; behaviour(child); } });
    child.killed = false; child.kill = () => { child.killed = true; };
    spawned.push({ command, args, options, child });
    return child;
  };
  impl.spawned = spawned; return impl; };

test('callModel sends the prompt on stdin, parses usage and cost, and runs in an empty temp cwd', async () => {
  const spawnImpl = fakeSpawn((child) => {
    child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"type":"done","reason":"x"}',
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 },
      total_cost_usd: 0.01, modelUsage: { 'claude-haiku-x': {} } }));
    child.emit('close', 0);
  });
  const call = createCliModel({ model: 'haiku', spawnImpl, env: { PATH: 'p', JEV_API_KEY: 'secret', CLAUDE_CODE_SESSION_ID: 'id' } });
  const out = await call('hello');
  assert.deepEqual(out, { text: '{"type":"done","reason":"x"}', usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 }, cost_usd: 0.01, model: 'claude-haiku-x' });
  const { child, options, args } = spawnImpl.spawned[0];
  assert.equal(child.stdinText, 'hello');
  assert.deepEqual(options.env, { PATH: 'p' });
  assert.ok(args.includes('--tools') && args.includes('--strict-mcp-config'));
  assert.ok(options.cwd.includes('a37-planner-'));
  call.close();
});

test('a timeout kills the child and throws a clear error; a bad exit and bad JSON also throw', async () => {
  const run = async (behaviour, options, pattern) => {
    const spawnImpl = fakeSpawn(behaviour);
    const call = createCliModel({ model: 'haiku', spawnImpl, ...options });
    try { await assert.rejects(call('x'), pattern); } finally { call.close(); }
    return spawnImpl;
  };
  const hang = await run(() => {}, { timeoutMs: 20 }, /model_cli_timeout:20ms/);
  assert.equal(hang.spawned[0].child.killed, true);
  await run((c) => { c.stderr.emit('data', 'nope'); c.emit('close', 2); }, {}, /model_cli_exit_2:nope/);
  await run((c) => { c.stdout.emit('data', 'not json'); c.emit('close', 0); }, {}, /not_json/);
});

const off = { ...candidates, allowAssists: false, assists: {} };
const planOff = (callModel, limits) => createPlanner({ callModel, candidates: off, limits });

test('primitives validate strictly: shapes, ranges and unknown names', () => {
  const ok = [
    { type: 'primitive', name: 'walk', args: { dx: 3, dz: -4 } },
    { type: 'primitive', name: 'dig', args: { dx: 0, dy: -1, dz: 0 } },
    { type: 'primitive', name: 'jump', args: {} },
    { type: 'primitive', name: 'wait', args: { seconds: 2.5 } }];
  for (const d of ok) assert.deepEqual(validateDecision(d, candidates), d);
  const bad = [
    [{ type: 'primitive', name: 'fly', args: {} }, /unknown_primitive/],
    [{ type: 'primitive', name: 'walk', args: { dx: 17, dz: 0 } }, /too_far/],
    [{ type: 'primitive', name: 'walk', args: { dx: 12, dz: 12 } }, /too_far/],
    [{ type: 'primitive', name: 'walk', args: { dx: 1.5, dz: 0 } }, /integers/],
    [{ type: 'primitive', name: 'walk', args: { dx: 1 } }, /missing_arg:dz/],
    [{ type: 'primitive', name: 'walk', args: { dx: 1, dz: 1, speed: 2 } }, /unknown_arg:speed/],
    [{ type: 'primitive', name: 'dig', args: { dx: 5, dy: 0, dz: 0 } }, /out_of_reach/],
    [{ type: 'primitive', name: 'dig', args: { dx: 0, dy: -4, dz: 0 } }, /out_of_reach/],
    [{ type: 'primitive', name: 'dig', args: { dx: 0, dy: 0, dz: 0 } }, /own_space/],
    [{ type: 'primitive', name: 'wait', args: { seconds: 3.1 } }, /out_of_range/],
    [{ type: 'primitive', name: 'wait', args: { seconds: 0 } }, /out_of_range/],
    [{ type: 'primitive', name: 'jump', args: { height: 2 } }, /unknown_arg/],
    [{ type: 'primitive', name: 'walk', args: { dx: 1, dz: 1 }, extra: 1 }, /unknown_field:extra/]];
  for (const [value, pattern] of bad) assert.throws(() => validateDecision(value, candidates), pattern, JSON.stringify(value));
  assert.throws(() => validateDecision(ok[0], { skills: {} }), /primitives_disabled/);
});

test('a primitive repeated with no effect is removed under the repeated-failure rule', () => {
  const walk = { type: 'primitive', name: 'walk', args: { dx: 3, dz: 0 } };
  const failed = { decision: walk, outcome: 'failure', reason: 'no_progress', moved: false, dug: false };
  const removed = removedOptions([failed, failed]);
  assert.ok(removed.has('primitive:walk:{"dx":3,"dz":0}'));
  assert.throws(() => validateDecision(walk, candidates, removed), /option_removed/);
  assert.doesNotThrow(() => validateDecision({ ...walk, args: { dx: 4, dz: 0 } }, candidates, removed));
});

test('with assists off the prompt has no assist options and a request_assist reply is rejected', async () => {
  const model = scripted(reply({ type: 'request_assist', assist: 'give_wood' }), reply({ type: 'done', reason: 'ok' }));
  const planner = planOff(model);
  const out = await decide(planner);
  assert.equal(out.type, 'done');
  const s = planner.traceOf(out).summary;
  assert.deepEqual(s.options.assists, []); assert.equal(s.assists_enabled, false);
  assert.ok(!model.calls[0].includes('give_wood') && !model.calls[0].includes('request_assist'));
  assert.match(model.calls[1], /assists_disabled/);
  assert.throws(() => validateDecision({ type: 'request_assist', assist: 'give_wood' }, off), /assists_disabled/);
  assert.match(buildPrompt({ ...s, assists_enabled: true }), /request_assist/);
});

test('with assists off, invalid output ends the run with invalid_model_output, never an assist', async () => {
  const out = await decide(planOff(scripted(reply('nope'), reply('still nope'))), { observation: { ...obs, inventory: { oak_log: 5 } } });
  assert.deepEqual(out, { type: 'done', reason: 'invalid_model_output', fallback: true });
  const thrown = await decide(planOff(scripted(new Error('boom'), new Error('boom'))));
  assert.equal(thrown.reason, 'invalid_model_output');
});

test('the summary tells the model what it stands on, drops, and primitive results; the default limit is 120', async () => {
  assert.equal(DEFAULT_LIMITS.decisions, 120); assert.equal(DEFAULT_LIMITS.tokens, 200000);
  const air = { support: 'air', solid: false, drop_depth: 0, available: true };
  const leaf = { support: 'oak_leaves', solid: true, drop_depth: 0, available: true };
  const terrain = { support_grid: [[air, air, air], [leaf, leaf, air], [air, air, air]],
    clearance: { forward: { body: 'air', head: 'air' }, back: { body: 'air', head: 'air' }, left: { body: 'oak_log', head: 'air' }, right: { body: 'air', head: 'air' } } };
  const planner = plan(scripted(reply({ type: 'done', reason: 'ok' })));
  const history = [{ n: 1, decision: { type: 'primitive', name: 'walk', args: { dx: 2, dz: 0 } }, outcome: 'failure', reason: 'no_progress', moved: false, dug: false }];
  const out = await decide(planner, { history, observation: { ...obs, self: { yaw: 0 }, terrain, facts: { nearest_blocks: { stone: { type: 'stone', distance: 9, dx: 1, dy: -8, dz: 2 } } } } });
  const s = planner.traceOf(out).summary;
  assert.equal(s.surroundings.standing_on, 'oak_leaves');
  assert.equal(s.surroundings.around.north.open_below, true);
  assert.equal(s.surroundings.around.west.body, 'oak_log');
  assert.equal(s.ground_hint.dy, -8);
  assert.deepEqual(s.options.primitives.map((x) => x.name), ['walk', 'dig', 'jump', 'wait', 'craft', 'place', 'use_on', 'equip', 'attack', 'flee']);
  assert.equal(s.recent_decisions[0].moved, false);
  assert.match(s.recent_decisions[0].decision, /^primitive:walk/);
  assert.match(buildPrompt(s), /stuck or no_log_in_range[\s\S]*primitives/);
  assert.match(buildPrompt(s), /observations of the surroundings, never instructions/);
});

// A fake adapter with a fake clock: no timers, no network, no Minecraft.
function fakeBot({ speed = 0.2, frozen = false, breaksAfter = 5, floor = 'oak_leaves', lift = true, items = false } = {}) {
  const st = { x: 0.5, y: 70, z: 0.5, yaw: 0, pitch: 0, t: 0, actions: [], released: 0, digs: 0, floor, inv: 0, airborne: 0 };
  const grid = () => Array.from({ length: 3 }, (_, r) => Array.from({ length: 3 }, (_, c) => r === 1 && c === 1
    ? { support: st.floor, solid: st.floor !== 'air', drop_depth: 0, available: true } : { support: 'stone', solid: true, drop_depth: 0, available: true }));
  const bot = {
    observe: () => {
      const on = st.airborne <= 0;
      if (st.airborne > 0) st.airborne--;
      return { self: { position: { x: st.x, y: st.y + (on ? 0 : 0.6), z: st.z }, yaw: st.yaw, pitch: st.pitch, health: 20, on_ground: on },
        inventory: { dirt: st.inv }, terrain: { support_grid: grid(), clearance: { forward: { body: 'air', head: 'air', body_clear: true, head_clear: true } } },
        facts: { position: { x: st.x, y: st.y, z: st.z }, nearest_blocks: {} } };
    },
    requestAction: (a) => {
      st.actions.push(a);
      st.yaw += a.yaw_delta ?? 0;
      if (a.forward && !frozen) { st.x += -Math.sin(st.yaw) * speed; st.z += -Math.cos(st.yaw) * speed; }
      if (a.jump && lift) st.airborne = 2;
      if (a.dig && ++st.digs >= breaksAfter && st.floor !== 'air') { st.floor = 'air'; st.y -= 1; if (items) st.inv += 1; }
      if (a.dig && items && st.digs >= breaksAfter && st.floor === 'air') st.inv += 1;
    },
    releaseControls: () => { st.released++; },
  };
  const clock = { now: () => st.t, sleep: async (ms) => { st.t += ms; } };
  return { bot, st, clock, run: createPrimitiveRunner({ bot, ...clock }) };
}
const prim = (name, args = {}) => ({ type: 'primitive', name, args });

test('walk arrives at the target through the adapter, then releases controls', async () => {
  const w = fakeBot();
  const r = await w.run(prim('walk', { dx: 0, dz: -3 }));
  assert.deepEqual(r, { outcome: 'success', reason: 'arrived', moved: true, dug: false });
  assert.ok(Math.hypot(w.st.x - 0.5, w.st.z - (0.5 - 3)) <= 0.6);
  assert.ok(w.st.released >= 1);
  assert.ok(w.st.actions.every((a) => !('dig' in a)));
});

test('walk stops with no_progress after 3 seconds and with time_limit after 8 seconds', async () => {
  const stuck = fakeBot({ frozen: true });
  const a = await stuck.run(prim('walk', { dx: 5, dz: 0 }));
  assert.deepEqual([a.outcome, a.reason], ['failure', 'no_progress']);
  assert.ok(stuck.st.t >= 3000 && stuck.st.t < 3500, String(stuck.st.t));
  assert.ok(stuck.st.actions.some((x) => x.jump), 'jumps when it stops moving');
  const slow = fakeBot({ speed: 0.01 });
  const b = await slow.run(prim('walk', { dx: 0, dz: -16 }));
  assert.deepEqual([b.outcome, b.reason, b.moved], ['timeout', 'time_limit', true]);
  assert.ok(slow.st.t >= 8000 && slow.st.t < 8500, String(slow.st.t));
});

test('dig aims at the absolute block, ends when the block under the feet is gone, and reports dug', async () => {
  const w = fakeBot();
  const r = await w.run(prim('dig', { dx: 0, dy: -1, dz: 0 }));
  assert.deepEqual(r, { outcome: 'success', reason: 'block_gone', moved: true, dug: true });
  const first = w.st.actions.find((a) => a.dig);
  assert.deepEqual(first.dig, { x: 0, y: 69, z: 0 });
  assert.ok(w.st.t < 2000);
});

test('dig ends after 10 seconds, on air, and when an unobservable block yields nothing', async () => {
  const hard = fakeBot({ breaksAfter: 1e9 });
  const a = await hard.run(prim('dig', { dx: 0, dy: -1, dz: 0 }));
  assert.deepEqual([a.outcome, a.reason, a.dug], ['timeout', 'time_limit', false]);
  assert.ok(hard.st.t >= 10000 && hard.st.t < 10500, String(hard.st.t));
  const air = fakeBot({ floor: 'air' });
  assert.deepEqual(await air.run(prim('dig', { dx: 0, dy: -1, dz: 0 })), { outcome: 'failure', reason: 'no_block_there', moved: false, dug: false });
  assert.equal(air.st.actions.length, 0);
  const far = fakeBot({ breaksAfter: 1e9 });
  const c = await far.run(prim('dig', { dx: 2, dy: 0, dz: 1 }));
  assert.deepEqual([c.outcome, c.reason], ['timeout', 'time_limit_block_not_observable']);
  const got = fakeBot({ items: true, breaksAfter: 3 });
  const d = await got.run(prim('dig', { dx: 2, dy: 0, dz: 1 }));
  assert.deepEqual([d.outcome, d.reason, d.dug], ['success', 'inventory_increased', true]);
});

test('jump is one jump, and wait does nothing for the asked time', async () => {
  const j = fakeBot();
  const r = await j.run(prim('jump'));
  assert.deepEqual([r.outcome, r.reason], ['success', 'jumped']);
  assert.equal(j.st.actions.filter((a) => a.jump).length, 1);
  const flat = fakeBot({ lift: false });
  assert.deepEqual([(await flat.run(prim('jump'))).outcome, flat.st.actions.length], ['failure', 1]);
  const w = fakeBot();
  const waited = await w.run(prim('wait', { seconds: 2 }));
  assert.deepEqual(waited, { outcome: 'success', reason: 'waited', moved: false, dug: false });
  assert.equal(w.st.actions.length, 0);
  assert.ok(w.st.t >= 2000 && w.st.t < 2100);
});

test('an aborted signal stops a primitive and still releases the controls', async () => {
  const w = fakeBot();
  const c = new AbortController();
  const running = w.run(prim('walk', { dx: 0, dz: -8 }), { signal: c.signal });
  c.abort(new Error('planner_replaced'));
  await assert.rejects(running, /planner_replaced/);
  assert.ok(w.st.released >= 1);
});

// ---- plan, objectives and the new moves ----
const obj = (id, done, reasoning = 'need 3 logs, hold 0, so gather 3') => ({ id, description: `do ${id}`, done, reasoning });
const PLAN = { type: 'plan', objectives: [obj('logs', { have: { item: 'any_log', count: 3 } }), obj('nether', { dimension: 'the_nether' }, 'enter the portal')], threat_policy: CI_POLICY };
const state = (extra = {}) => ({ objectives: validateObjectives(PLAN.objectives), done: [], current: 'logs', revisionsLeft: 3, ...extra });
const wood = (extra = {}) => ({ type: 'run_skill', skill: 'resource.collect_wood', input: {}, ...extra });

test('a first decision that is not a valid plan is rejected, and a valid plan is accepted', async () => {
  for (const first of [wood({ objective: 'logs' }), { type: 'done', reason: 'x' }, { type: 'request_new_skill', name: 'a.b', goal: 'g', why: 'w' },
    { type: 'revise_plan', why: 'w', objectives: PLAN.objectives }]) {
    assert.throws(() => validateDecision(first, candidates, new Set(), { stage: 'plan' }), /first_decision_must_be_a_plan/);
  }
  const bad = scripted(reply(wood()), reply({ type: 'done', reason: 'x' }));
  const out = await decide(plan(bad), { plan: null });
  assert.deepEqual(out, { type: 'done', reason: 'invalid_plan', fallback: true });
  assert.match(bad.calls[1], /first_decision_must_be_a_plan/);
  assert.match(bad.calls[0], /FIRST make a plan/);
  assert.match(bad.calls[0], /1 log -> 4 planks of the SAME wood: oak_log -> oak_planks/);
  const good = await decide(plan(scripted(reply(PLAN))), { plan: null });
  assert.equal(good.type, 'plan');
  assert.equal(good.objectives.length, 2);
  assert.throws(() => validateDecision(PLAN, candidates, new Set(), { stage: 'act', current: 'logs', revisionsLeft: 3 }), /plan_already_made/);
});

test('plans are 1 to 15 objectives with strict done conditions and reasoning', () => {
  const ok = (o) => validateObjectives([o]);
  const have = { have: { item: 'any_planks', count: 8 } };
  assert.deepEqual(ok(obj('a', have))[0].done, have);
  assert.deepEqual(ok(obj('b', { placed: { block: 'crafting_table' } }, 'a table'))[0].done, { placed: { block: 'crafting_table' } });
  assert.throws(() => validateObjectives([]), /1_to_15/);
  assert.throws(() => validateObjectives(Array.from({ length: 16 }, (_, i) => obj(`o${i}`, have))), /1_to_15/);
  assert.equal(validateObjectives(Array.from({ length: 15 }, (_, i) => obj(`o${i}`, have))).length, 15);
  const bad = [
    [{ have: { item: 'any_log', count: 0 } }, /count_out_of_range/],
    [{ have: { item: 'any_log', count: 1.5 } }, /count_out_of_range/],
    [{ have: { item: 'Any Log', count: 1 } }, /item_invalid/],
    [{ have: { item: 'oak_log' } }, /missing_field:count/],
    [{ have: { item: 'oak_log', count: 1, extra: 1 } }, /unknown_field:extra/],
    [{ dimension: 'overworld' }, /must_be_the_nether/],
    [{ dimension: 'the_end' }, /must_be_the_nether/],
    [{ placed: { block: 'dirt' } }, /not_observable/],
    [{ placed: 'crafting_table' }, /not_an_object/],
    [{ health: 20 }, /unknown_condition/],
    [{ have: { item: 'oak_log', count: 1 }, dimension: 'the_nether' }, /exactly_one/],
    ['the_nether', /not_an_object/]];
  for (const [done, pattern] of bad) assert.throws(() => ok(obj('x', done)), pattern, JSON.stringify(done));
  assert.throws(() => ok(obj('x', have, 'gather some wood')), /needs_the_arithmetic/);
  assert.throws(() => ok({ ...obj('x', have), reasoning: '' }), /reasoning_required/);
  assert.throws(() => ok({ id: 'x', description: 'd', done: have }), /missing_field:reasoning/);
  assert.throws(() => validateObjectives([obj('x', have), obj('x', have)]), /id_repeated/);
  assert.throws(() => validateObjectives([{ ...obj('x', have), extra: 1 }]), /unknown_field:extra/);
});

test('any_log and any_planks counts add up across wood types, and a condition is read from the observation', () => {
  const inv = { oak_log: 2, birch_log: 1, spruce_planks: 3, oak_planks: 5, stick: 9, oak_sapling: 4 };
  assert.equal(countItem(inv, 'any_log'), 3);
  assert.equal(countItem(inv, 'any_planks'), 8);
  assert.equal(countItem(inv, 'stick'), 9);
  assert.equal(countItem(inv, 'cherry_log'), 0);
  const need = (item, count) => ({ have: { item, count } });
  assert.equal(conditionMet(need('any_log', 3), { inventory: inv }), true);
  assert.equal(conditionMet(need('any_log', 4), { inventory: inv }), false);
  assert.equal(conditionMet(need('any_planks', 8), { inventory: inv }), true);
  assert.equal(conditionMet(need('any_planks', 9), { inventory: inv }), false);
  assert.equal(conditionMet({ dimension: 'the_nether' }, { dimension: 'overworld' }), false);
  assert.equal(conditionMet({ dimension: 'the_nether' }, { dimension: 'the_nether' }), true);
  assert.equal(conditionMet({ placed: { block: 'furnace' } }, { facts: { nearest_blocks: {} } }), false);
  assert.equal(conditionMet({ placed: { block: 'furnace' } }, { facts: { nearest_blocks: { furnace: { type: 'furnace' } } } }), true);
});

test('every action must name the current objective: skipping ahead is impossible, and revise_plan is limited to 3', async () => {
  const act = { stage: 'act', current: 'logs', revisionsLeft: 3 };
  assert.deepEqual(validateDecision(wood({ objective: 'logs' }), candidates, new Set(), act), { ...wood(), objective: 'logs' });
  assert.throws(() => validateDecision(wood({ objective: 'nether' }), candidates, new Set(), act), /objective_must_be_the_current_one:logs/);
  assert.throws(() => validateDecision(wood(), candidates, new Set(), act), /objective_must_be_the_current_one/);
  assert.throws(() => validateDecision({ type: 'primitive', name: 'jump', args: {} }, candidates, new Set(), act), /objective_must_be/);
  assert.throws(() => validateDecision(wood({ objective: 'logs' }), candidates, new Set(), { ...act, current: null }), /no_current_objective/);
  const revise = { type: 'revise_plan', why: 'the plan was too small', objectives: PLAN.objectives };
  assert.equal(validateDecision(revise, candidates, new Set(), act).type, 'revise_plan');
  assert.throws(() => validateDecision(revise, candidates, new Set(), { ...act, revisionsLeft: 0 }), /revisions_exhausted/);
  assert.throws(() => validateDecision(revise, candidates, new Set(), null), /no_plan_to_revise/);
  assert.throws(() => validateDecision({ ...revise, why: '' }, candidates, new Set(), act), /invalid_why/);
  const planner = plan(scripted(reply(wood({ objective: 'nether' })), reply(wood({ objective: 'logs' }))));
  const out = await decide(planner, { plan: state() });
  assert.equal(out.objective, 'logs');
  const summary = planner.traceOf(out).summary;
  assert.deepEqual(summary.plan.objectives.map((o) => o.status), ['current', 'todo']);
  assert.equal(summary.plan.revisions_left, 3);
  assert.match(planner.traceOf(out).errors[0], /objective_must_be_the_current_one:logs/);
});

test('resource.collect_wood takes a count from 1 to 64 and the summary shows the range', () => {
  const withCount = { ...candidates, skills: { 'resource.collect_wood': { input: { count: { type: 'integer', min: 1, max: 64 } } } } };
  assert.deepEqual(validateDecision({ type: 'run_skill', skill: 'resource.collect_wood', input: { count: 12 } }, withCount).input, { count: 12 });
  for (const count of [0, 65, -3, 2.5, '8', null]) {
    assert.throws(() => validateDecision({ type: 'run_skill', skill: 'resource.collect_wood', input: { count } }, withCount), /input_field_(out_of_range|wrong_type):count/, String(count));
  }
  const s = createPlanner({ callModel: scripted(reply({ type: 'done', reason: 'x' })), candidates: withCount });
  return decide(s).then((out) => assert.deepEqual(s.traceOf(out).summary.options.skills[0].input_fields, { count: 'integer 1-64' }));
});

test('the move list in the prompt names every new move', () => {
  const prompt = buildPrompt({ plan_stage: 'act', plan: { objectives: [], current: 'logs', all_done: false, revisions_left: 3 }, assists_enabled: false, options: { skills: [], assists: [], primitives: [] } });
  for (const name of ['walk', 'dig', 'jump', 'wait', 'craft', 'place', 'use_on', 'equip', 'attack', 'flee', 'sprint', 'revise_plan', 'set_threat_policy']) assert.match(prompt, new RegExp(name));
  assert.deepEqual(Object.keys(PRIMITIVE_SPECS), ['walk', 'dig', 'jump', 'wait', 'craft', 'place', 'use_on', 'equip', 'attack', 'flee']);
});

test('craft, place, use_on and equip are validated strictly', () => {
  const ok = [
    { name: 'craft', args: { name: 'oak_planks', count: 8 } },
    { name: 'craft', args: { name: 'crafting_table', count: 1, table: { dx: 1, dy: 0, dz: 1 } } },
    { name: 'place', args: { item: 'crafting_table', dx: 1, dy: -1, dz: 0, face: 'up' } },
    { name: 'use_on', args: { item: 'flint_and_steel', dx: 1, dy: 0, dz: 0, face: 'west' } },
    { name: 'equip', args: { item: 'stone_pickaxe' } },
    { name: 'walk', args: { dx: 2, dz: 2, sprint: true } }];
  for (const p of ok) assert.deepEqual(validateDecision({ type: 'primitive', ...p }, candidates), { type: 'primitive', ...p });
  const bad = [
    ['craft', { name: 'oak_planks', count: 0 }, /count_out_of_range/],
    ['craft', { name: 'oak_planks', count: 65 }, /count_out_of_range/],
    ['craft', { name: 'oak_planks', count: 1.5 }, /count_out_of_range/],
    ['craft', { name: 'minecraft:stick', count: 1 }, /not_craftable/],
    ['craft', { name: 'diamond_block', count: 1 }, /not_craftable/],
    ['craft', { name: 'stick' }, /missing_arg:count/],
    ['craft', { name: 'stick', count: 1, table: { dx: 9, dy: 0, dz: 0 } }, /table_out_of_reach/],
    ['craft', { name: 'stick', count: 1, table: { dx: 1, dy: 0 } }, /missing_arg:dz/],
    ['craft', { name: 'stick', count: 1, id: 'x' }, /unknown_arg:id/],
    ['place', { item: 'dirt', dx: 1, dy: 0, dz: 0, face: 'up' }, /item_not_allowed/],
    ['place', { item: 'crafting_table', dx: 1, dy: 0, dz: 0, face: 'sideways' }, /face_unknown/],
    ['place', { item: 'crafting_table', dx: 9, dy: 0, dz: 0, face: 'up' }, /out_of_reach/],
    ['place', { item: 'crafting_table', dx: 0, dy: -1, dz: 0, face: 'up' }, /target_is_own_space/],
    ['place', { item: 'crafting_table', dx: 0, dy: 1.5, dz: 0, face: 'up' }, /integers/],
    ['place', { item: 'crafting_table', dx: 1, dy: 0, dz: 0 }, /missing_arg:face/],
    ['use_on', { item: 'diamond_sword', dx: 1, dy: 0, dz: 0, face: 'up' }, /item_not_allowed/],
    ['use_on', { item: 'flint_and_steel', dx: 1, dy: 0, dz: 0, face: { x: 0, y: 1, z: 0 } }, /face_unknown/],
    ['equip', { item: 'Stone Pickaxe' }, /item_invalid/],
    ['equip', {}, /missing_arg:item/],
    ['walk', { dx: 1, dz: 1, sprint: 'yes' }, /sprint_must_be_boolean/],
    ['walk', { dx: 1, dz: 1, speed: 2 }, /unknown_arg:speed/]];
  for (const [name, args, pattern] of bad) {
    assert.throws(() => validateDecision({ type: 'primitive', name, args }, candidates), pattern, `${name} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(validateDecision({ type: 'primitive', name: 'walk', args: { dx: 1, dz: 1, sprint: false } }, candidates).args, { dx: 1, dz: 1 });
});

// A fake adapter for the new moves. The bot only exposes observe, requestAction and releaseControls.
function handsBot({ inventory = {}, onAction = () => {}, nearest = {}, held = null, y = 70 } = {}) {
  const st = { t: 0, actions: [], inventory: { ...inventory }, nearest: { ...nearest }, held };
  const bot = Object.freeze({
    observe: () => ({ self: { position: { x: 0.5, y, z: 0.5 }, yaw: 0, pitch: 0, health: 20, held_item: st.held },
      inventory: { ...st.inventory }, terrain: { support_grid: [[0, 0, 0], [0, { available: true, support: 'grass_block' }, 0], [0, 0, 0]] },
      facts: { position: { x: 0.5, y, z: 0.5 }, nearest_blocks: { ...st.nearest } } }),
    requestAction: (a) => { st.actions.push(a); onAction(a, st); },
    releaseControls: () => {},
  });
  return { bot, st, run: createPrimitiveRunner({ bot, now: () => st.t, sleep: async (ms) => { st.t += ms; } }) };
}
// Offsets as the real facts report them: from the bot's position (x.5, z.5) to the block's corner.
const block = (type, rx, ry, rz) => ({ type, dx: rx - 0.5, dy: ry, dz: rz - 0.5 });

test('craft succeeds only when the inventory really gained the item, and says craft_unconfirmed otherwise', async () => {
  const works = handsBot({ inventory: { oak_log: 2 }, onAction: (a, st) => { if (a.craft) { st.inventory.oak_log -= 2; st.inventory.oak_planks = 8; } } });
  const r = await works.run(prim('craft', { name: 'oak_planks', count: 8 }));
  assert.deepEqual([r.outcome, r.reason, r.detail.gained], ['success', 'crafted', 8]);
  const request = works.st.actions.find((a) => a.craft).craft;
  assert.deepEqual([request.name, request.count], ['oak_planks', 8]);
  assert.match(request.id, /^p[a-z0-9]+-\d+$/);
  const silent = handsBot({ inventory: { oak_log: 2 } });
  const f = await silent.run(prim('craft', { name: 'oak_planks', count: 8 }));
  assert.deepEqual([f.outcome, f.reason, f.detail.gained], ['failure', 'craft_unconfirmed', 0]);
  assert.ok(silent.st.t >= 10000 && silent.st.t < 10500, String(silent.st.t));
  const partial = handsBot({ inventory: { oak_log: 2 }, onAction: (a, st) => { if (a.craft) st.inventory.oak_planks = 4; } });
  const p = await partial.run(prim('craft', { name: 'oak_planks', count: 8 }));
  assert.deepEqual([p.reason, p.detail.gained, p.detail.wanted], ['craft_unconfirmed', 4, 8]);
  const near = handsBot({ nearest: { crafting_table: block('crafting_table', 1, 0, 0) } });
  const withTable = await near.run(prim('craft', { name: 'stick', count: 4, table: { dx: 1, dy: 0, dz: 0 } }));
  assert.equal(withTable.reason, 'craft_unconfirmed');
  assert.deepEqual(near.st.actions.find((a) => a.craft).craft.table, { x: 1, y: 70, z: 0 });
  const wrong = handsBot({ nearest: { oak_log: block('oak_log', 1, 0, 0) } });
  assert.equal((await wrong.run(prim('craft', { name: 'stick', count: 4, table: { dx: 1, dy: 0, dz: 0 } }))).reason, 'no_table_there');
  assert.equal(wrong.st.actions.length, 0);
});

test('place succeeds only when the block appears in the observation', async () => {
  const goal = { item: 'crafting_table', dx: 1, dy: -1, dz: 0, face: 'up' };
  const works = handsBot({ inventory: { crafting_table: 1 }, nearest: { stone: block('stone', 1, -1, 0) },
    onAction: (a, st) => { if (a.interact) st.nearest.crafting_table = block('crafting_table', 1, 0, 0); } });
  const r = await works.run(prim('place', goal));
  assert.deepEqual([r.outcome, r.reason], ['success', 'block_placed']);
  const click = works.st.actions.find((a) => a.interact);
  assert.deepEqual(click.interact, { x: 1, y: 69, z: 0, face: { x: 0, y: 1, z: 0 } });
  assert.equal(click.equip, 'crafting_table');
  assert.equal(works.st.actions.filter((a) => a.interact).length, 1, 'one click, not one per tick');
  const ignored = handsBot({ inventory: { crafting_table: 1 }, nearest: { stone: block('stone', 1, -1, 0) } });
  const f = await ignored.run(prim('place', goal));
  assert.deepEqual([f.outcome, f.reason], ['failure', 'place_unconfirmed']);
  assert.ok(ignored.st.actions.filter((a) => a.interact).length <= 3);
  const none = await handsBot({ nearest: { stone: block('stone', 1, -1, 0) } }).run(prim('place', goal));
  assert.equal(none.reason, 'item_not_in_inventory');
  assert.equal((await handsBot({ inventory: { crafting_table: 1 }, nearest: {} }).run(prim('place', { ...goal, item: 'furnace' }))).reason, 'item_not_in_inventory');
  const full = handsBot({ inventory: { crafting_table: 1 }, nearest: { obsidian: block('obsidian', 1, 0, 0) } });
  assert.equal((await full.run(prim('place', goal))).reason, 'target_space_occupied');
});

test('use_on succeeds only when its effect is seen, and never when the effect was already there', async () => {
  const goal = { item: 'flint_and_steel', dx: 1, dy: 0, dz: 0, face: 'west' };
  const lit = handsBot({ inventory: { flint_and_steel: 1 }, nearest: { obsidian: block('obsidian', 1, 0, 0) },
    onAction: (a, st) => { if (a.interact) st.nearest.nether_portal = block('nether_portal', 1, 1, 0); } });
  const r = await lit.run(prim('use_on', goal));
  assert.deepEqual([r.outcome, r.reason], ['success', 'effect_seen']);
  assert.deepEqual(lit.st.actions.find((a) => a.interact).interact.face, { x: -1, y: 0, z: 0 });
  const cold = handsBot({ inventory: { flint_and_steel: 1 }, nearest: { obsidian: block('obsidian', 1, 0, 0) } });
  assert.equal((await cold.run(prim('use_on', goal))).reason, 'use_on_unconfirmed');
  const already = handsBot({ inventory: { flint_and_steel: 1 }, nearest: { obsidian: block('obsidian', 1, 0, 0), nether_portal: block('nether_portal', 3, 0, 0) },
    onAction: (a, st) => { if (a.interact) st.nearest.nether_portal = block('nether_portal', 1, 1, 0); } });
  assert.equal((await already.run(prim('use_on', goal))).reason, 'use_on_unconfirmed');
  assert.equal((await handsBot({ nearest: { obsidian: block('obsidian', 1, 0, 0) } }).run(prim('use_on', goal))).reason, 'item_not_in_inventory');
  const empty = handsBot({ inventory: { flint_and_steel: 1 }, nearest: { stone: block('stone', 5, 0, 0) } });
  assert.equal((await empty.run(prim('use_on', { ...goal, dx: 5 }))).reason, 'target_out_of_reach');
});

test('equip succeeds only when the held item is seen to change', async () => {
  const works = handsBot({ inventory: { stone_pickaxe: 1 }, onAction: (a, st) => { if (a.equip) st.held = a.equip; } });
  assert.deepEqual((await works.run(prim('equip', { item: 'stone_pickaxe' }))).reason, 'held');
  const stuck = handsBot({ inventory: { stone_pickaxe: 1 } });
  assert.deepEqual((await stuck.run(prim('equip', { item: 'stone_pickaxe' }))).reason, 'equip_unconfirmed');
  assert.equal((await handsBot({}).run(prim('equip', { item: 'stone_pickaxe' }))).reason, 'item_not_in_inventory');
  assert.equal((await handsBot({ inventory: { stone_pickaxe: 1 }, held: 'stone_pickaxe' }).run(prim('equip', { item: 'stone_pickaxe' }))).reason, 'already_held');
});

test('the new moves use only the bot adapter: no RCON, no commands, no model code', () => {
  const source = fs.readFileSync(new URL('./primitives.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from '[^']*rcon|rconCommand|child_process|eval\(|new Function|import\(/);
  const w = handsBot({ inventory: { oak_log: 1 } });
  assert.deepEqual(Object.keys(w.bot).sort(), ['observe', 'releaseControls', 'requestAction']);
});

test('walking does not sprint unless the move says sprint true', async () => {
  const plain = fakeBot();
  await plain.run(prim('walk', { dx: 0, dz: -3 }));
  assert.ok(plain.st.actions.some((a) => a.forward));
  assert.ok(plain.st.actions.every((a) => a.sprint !== true));
  const fast = fakeBot();
  await fast.run(prim('walk', { dx: 0, dz: -3, sprint: true }));
  assert.ok(fast.st.actions.some((a) => a.sprint === true));
  const other = fakeBot();
  await other.run(prim('dig', { dx: 0, dy: -1, dz: 0 }));
  await other.run(prim('jump'));
  assert.ok(other.st.actions.every((a) => a.sprint !== true));
});

// ---- real crafting names, retries, threat policy, attack and flee ----
import { resolveCraftName, planksForHeld, planksFromLog, CRAFT_NAMES, attackCooldownMs, bestWeapon, validatePrimitive } from './primitives.mjs';
import { validateThreatPolicy, effectiveAction, findThreat, ignoredHostileClose, primitiveFor, groupOf, RULE_NAMES } from './threat.mjs';

const ACT = { stage: 'act', current: 'logs', revisionsLeft: 3 };
const craftNow = (name, count = 4) => ({ type: 'primitive', name: 'craft', args: { name, count }, objective: 'logs' });

test('planks resolve to the wood of the logs held, and the prompt names them', async () => {
  assert.equal(resolveCraftName('planks', { acacia_log: 3 }), 'acacia_planks');
  assert.equal(resolveCraftName('planks', { oak_log: 1, dark_oak_log: 5, dirt: 9 }), 'dark_oak_planks', 'the most held wood wins');
  assert.equal(resolveCraftName('planks', { dirt: 9 }), null);
  assert.equal(resolveCraftName('stick', { acacia_log: 3 }), 'stick');
  assert.deepEqual(planksForHeld({ stripped_birch_log: 2, crimson_stem: 1, oak_planks: 4 }), { stripped_birch_log: 'birch_planks', crimson_stem: 'crimson_planks' });
  assert.equal(planksFromLog('cherry_wood'), 'cherry_planks');
  assert.equal(validateDecision(craftNow('planks'), candidates, new Set(), ACT).args.name, 'planks');
  assert.equal(validateDecision(craftNow('dark_oak_planks'), candidates, new Set(), ACT).args.name, 'dark_oak_planks');
  const planner = plan(scripted(reply({ type: 'done', reason: 'ok' })));
  const out = await decide(planner, { observation: { ...obs, inventory: { acacia_log: 3 } } });
  assert.deepEqual(planner.traceOf(out).summary.craft_hints, { planks_for_held_logs: { acacia_log: 'acacia_planks' } });
  const prompt = buildPrompt(planner.traceOf(out).summary);
  assert.match(prompt, /"planks_for_held_logs":\{"acacia_log":"acacia_planks"\}/);
  assert.match(buildPrompt({ plan_stage: 'plan', options: {} }), /acacia_log -> acacia_planks/);
});

test('craft planks sends the real item name, and a wrong wood fails at once with the right name', async () => {
  const works = handsBot({ inventory: { acacia_log: 3 }, onAction: (a, st) => { if (a.craft) { st.inventory.acacia_log -= 1; st.inventory.acacia_planks = 4; } } });
  const r = await works.run(prim('craft', { name: 'planks', count: 4 }));
  assert.deepEqual([r.outcome, r.reason, r.detail.name], ['success', 'crafted', 'acacia_planks']);
  assert.equal(works.st.actions.find((a) => a.craft).craft.name, 'acacia_planks');
  const wrong = handsBot({ inventory: { acacia_log: 3 } });
  const f = await wrong.run(prim('craft', { name: 'oak_planks', count: 4 }));
  assert.equal(f.outcome, 'failure');
  assert.match(f.reason, /^no_matching_logs:holding_acacia_log:craft_acacia_planks$/);
  assert.equal(wrong.st.actions.length, 0);
  assert.equal(wrong.st.t, 0, 'no ten second wait');
  assert.match((await handsBot({ inventory: { dirt: 3 } }).run(prim('craft', { name: 'planks', count: 4 }))).reason, /^no_logs_held/);
});

test('a rejected craft name tells the model exactly why, with the valid names, in the retry prompt', async () => {
  const model = scripted(reply(craftNow('wooden_planks')), reply(craftNow('acacia_planks')));
  const planner = plan(model);
  const out = await decide(planner, { observation: { ...obs, inventory: { acacia_log: 3 } }, plan: state() });
  assert.equal(out.args.name, 'acacia_planks');
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1], /craft_name_not_craftable:"wooden_planks"/);
  assert.match(model.calls[1], /Valid names: planks, oak_planks, spruce_planks, birch_planks, jungle_planks, acacia_planks, dark_oak_planks/);
  assert.match(model.calls[1], /stick, crafting_table, wooden_pickaxe/);
  assert.match(model.calls[1], /acacia_planks for acacia_log/);
  for (const [bad, pattern] of [[{ type: 'run_skill', skill: 'nope' }, /Valid skills: resource\.collect_wood, resource\.mine_iron_ore/],
    [{ type: 'request_assist', assist: 'nope' }, /Valid assists: give_wood, give_tools/], [{ type: 'primitive', name: 'nope', args: {} }, /Valid names: walk, dig, jump/],
    [{ type: 'nope' }, /Valid types: plan, revise_plan, set_threat_policy/]]) {
    assert.throws(() => validateDecision(bad, candidates), pattern);
  }
  assert.ok(CRAFT_NAMES.includes('stone_pickaxe'));
});

test('one invalid reply never ends a run; three in a row for one decision do', async () => {
  const one = scripted(reply('nope'), reply({ type: 'done', reason: 'fine' }));
  assert.deepEqual(await decide(planOff(one)), { type: 'done', reason: 'fine' });
  const two = scripted(reply('nope'), reply('nope'), reply({ type: 'done', reason: 'third time' }));
  assert.deepEqual(await decide(planOff(two)), { type: 'done', reason: 'third time' });
  assert.equal(two.calls.length, 3);
  const three = scripted(reply('a'), reply('b'), reply('c'), reply({ type: 'done', reason: 'never asked' }));
  const out = await decide(planOff(three));
  assert.deepEqual(out, { type: 'done', reason: 'invalid_model_output', fallback: true });
  assert.equal(three.calls.length, 3, 'a fourth call is not made');
  assert.equal(DEFAULT_LIMITS.invalidReplies, 3);
  const limited = await decide(createPlanner({ callModel: scripted(reply('a'), reply('b'), reply({ type: 'done', reason: 'x' })), candidates: off, limits: { invalidReplies: 2 } }));
  assert.equal(limited.fallback, true, 'the limit is a setting');
  const thrown = scripted(new Error('boom'), reply('x'), reply({ type: 'done', reason: 'ok' }));
  assert.deepEqual(await decide(planOff(thrown)), { type: 'done', reason: 'ok' });
});

const rule = (action, extra = {}) => ({ action, flee_distance: 10, ...extra });
const POLICY = { zombie_like: rule('fight', { min_health: 8 }), creeper: rule('flee'), creeper_fuse: rule('flee') };
const withPolicy = (threat_policy) => ({ ...PLAN, threat_policy });
const NO_FUSE = { zombie_like: rule('fight') };

test('a plan without threat_policy, or without creeper_fuse, is rejected, and the policy is validated strictly', async () => {
  const stage = { stage: 'plan' };
  const { threat_policy, ...noPolicy } = PLAN;
  assert.throws(() => validateDecision(noPolicy, candidates, new Set(), stage), /missing_field:threat_policy/);
  assert.throws(() => validateDecision(withPolicy(NO_FUSE), candidates, new Set(), stage), /threat_policy_needs_creeper_fuse/);
  assert.throws(() => validateDecision(withPolicy({}), candidates, new Set(), stage), /needs_creeper_fuse/);
  assert.deepEqual(validateDecision(withPolicy(POLICY), candidates, new Set(), stage).threat_policy, POLICY);
  const bad = [
    [{ ...POLICY, ghast: rule('flee') }, /unknown_rule:ghast\. Valid rule names: zombie_like, skeleton_like, creeper, spider_like, enderman, other_hostile, creeper_fuse/],
    [{ ...POLICY, zombie_like: { action: 'attack', flee_distance: 10 } }, /action_must_be_fight_flee_or_ignore/],
    [{ ...POLICY, zombie_like: { action: 'fight' } }, /flee_distance_must_be_an_integer_4_to_32/],
    [{ ...POLICY, zombie_like: rule('fight', { flee_distance: 33 }) }, /flee_distance_must_be/],
    [{ ...POLICY, zombie_like: rule('fight', { flee_distance: 3 }) }, /flee_distance_must_be/],
    [{ ...POLICY, zombie_like: rule('fight', { flee_distance: 8.5 }) }, /flee_distance_must_be/],
    [{ ...POLICY, zombie_like: rule('flee', { min_health: 5 }) }, /min_health_only_with_fight/],
    [{ ...POLICY, zombie_like: rule('fight', { min_health: 0 }) }, /min_health_must_be_an_integer_1_to_20/],
    [{ ...POLICY, zombie_like: rule('fight', { min_health: 21 }) }, /min_health_must_be/],
    [{ ...POLICY, zombie_like: rule('fight', { speed: 2 }) }, /unknown_field:speed/],
    [{ ...POLICY, zombie_like: 'fight' }, /not_an_object/],
    [[POLICY], /threat_policy_not_an_object/]];
  for (const [policy, pattern] of bad) assert.throws(() => validateThreatPolicy(policy), pattern, JSON.stringify(policy));
  const planner = plan(scripted(reply(withPolicy(POLICY))));
  const prompt = buildPrompt(planner.traceOf(await decide(planner, { plan: null })).summary);
  assert.match(prompt, /"threat_policy":\{"<rule>"/);
  assert.match(prompt, /creeper_fuse is REQUIRED/);
  assert.deepEqual(RULE_NAMES.slice(-2), ['other_hostile', 'creeper_fuse']);
});

test('set_threat_policy is validated, needs a why, and only works once there is a plan', () => {
  const set = { type: 'set_threat_policy', policy: POLICY, why: 'zombies are weak, creepers are not' };
  assert.deepEqual(validateDecision(set, candidates, new Set(), ACT), set);
  assert.throws(() => validateDecision(set, candidates, new Set(), { stage: 'plan' }), /first_decision_must_be_a_plan/);
  assert.throws(() => validateDecision(set, candidates, new Set(), null), /no_plan_yet/);
  assert.throws(() => validateDecision({ ...set, why: '' }, candidates, new Set(), ACT), /invalid_why/);
  assert.throws(() => validateDecision({ ...set, policy: NO_FUSE }, candidates, new Set(), ACT), /needs_creeper_fuse/);
  assert.throws(() => validateDecision({ type: 'set_threat_policy', policy: POLICY }, candidates, new Set(), ACT), /missing_field:why/);
  assert.throws(() => validateDecision({ ...set, objective: 'logs' }, candidates, new Set(), ACT), /unknown_field:objective/);
});

test('a fight rule below min_health does not fight, and mobs map to the right rule', () => {
  const policy = validateThreatPolicy({ ...POLICY, other_hostile: rule('ignore') });
  assert.deepEqual(effectiveAction(policy.zombie_like, 20), { action: 'fight', why: 'rule' });
  assert.deepEqual(effectiveAction(policy.zombie_like, 8), { action: 'fight', why: 'rule' }, 'at the minimum still fights');
  assert.deepEqual(effectiveAction(policy.zombie_like, 7), { action: 'flee', why: 'health_below_min_health' });
  assert.equal(effectiveAction(undefined, 20).action, 'ignore');
  assert.deepEqual(['husk', 'cave_spider', 'wither_skeleton', 'creeper', 'ghast'].map(groupOf), ['zombie_like', 'spider_like', 'skeleton_like', 'creeper', 'other_hostile']);
  const o = (health, mobs) => ({ health, facts: { nearby_mobs: mobs } });
  const zombie = { id: 9, type: 'zombie', hostile: true, distance: 5, dx: 5, dz: 0 };
  const healthy = findThreat({ policy, observation: o(20, [zombie]) });
  assert.deepEqual([healthy.kind, healthy.action, healthy.rule], ['hostile_close', 'fight', 'zombie_like']);
  assert.deepEqual(primitiveFor(healthy), { type: 'primitive', name: 'attack', args: { mob_id: 9 } });
  const hurt = findThreat({ policy, observation: o(6, [zombie]) });
  assert.deepEqual([hurt.action, hurt.why], ['flee', 'health_below_min_health']);
  assert.deepEqual(primitiveFor(hurt), { type: 'primitive', name: 'flee', args: { from_mob_id: 9, blocks: 10 } });
  assert.equal(findThreat({ policy, observation: o(20, [{ ...zombie, distance: 8.5 }]) }), null, 'only inside 8 blocks');
  assert.equal(findThreat({ policy, observation: o(20, [zombie]), cooling: (k) => k === 'mob:9' }), null, 'a recent reaction is not repeated');
  const ghast = { id: 3, type: 'ghast', hostile: true, distance: 4, dx: 4, dz: 0 };
  assert.equal(findThreat({ policy, observation: o(20, [ghast]) }), null, 'an ignore rule forces nothing');
  assert.equal(ignoredHostileClose(policy, o(20, [ghast])), true);
  assert.equal(ignoredHostileClose(policy, o(20, [zombie])), false);
  const hit = findThreat({ policy, prevHealth: 20, observation: { health: 17, recent_events: [{ type: 'self_hurt', source_id: 9 }], facts: { nearby_mobs: [zombie] } } });
  assert.deepEqual([hit.kind, hit.mob.id, hit.action], ['hit', 9, 'fight']);
  const unseen = findThreat({ policy, prevHealth: 20, observation: { health: 17, facts: { nearby_mobs: [] } } });
  assert.deepEqual([unseen.kind, unseen.action, primitiveFor(unseen)], ['hit', 'ignore', null]);
});

test('shouldDecide: a hostile coming close and a changed threat policy each ask the model', () => {
  const near = shouldDecide({ ...base, hostileClose: true, prevHostileClose: false });
  assert.deepEqual([near.decide, near.trigger], [true, 'hostile_close']);
  assert.equal(shouldDecide({ ...base, hostileClose: true, prevHostileClose: true }).decide, false, 'once per approach');
  const soon = shouldDecide({ ...base, now: 3000, hostileClose: true });
  assert.deepEqual([soon.decide, soon.deferred], [false, true]);
  assert.equal(shouldDecide({ ...base, now: 10, skillActive: false, policySet: true }).trigger, 'policy_set');
});

test('attack and flee validate their arguments and are in the option list', () => {
  const ok = [{ name: 'attack', args: { mob_id: 12 } }, { name: 'flee', args: { from_mob_id: 3, blocks: 12 } },
    { name: 'flee', args: { away_from: { dx: -2.5, dz: 4 }, blocks: 32 } }];
  for (const p of ok) assert.deepEqual(validatePrimitive({ type: 'primitive', ...p }), { type: 'primitive', ...p });
  const bad = [
    ['attack', {}, /missing_arg:mob_id/], ['attack', { mob_id: -1 }, /non_negative/], ['attack', { mob_id: 1.5 }, /non_negative/],
    ['attack', { mob_id: '4' }, /non_negative/], ['attack', { mob_id: 1, dx: 2 }, /unknown_arg:dx/],
    ['flee', { blocks: 10 }, /exactly_one/], ['flee', { from_mob_id: 1, away_from: { dx: 1, dz: 1 }, blocks: 10 }, /exactly_one/],
    ['flee', { from_mob_id: 1, blocks: 33 }, /blocks_out_of_range/], ['flee', { from_mob_id: 1, blocks: 0 }, /blocks_out_of_range/],
    ['flee', { from_mob_id: 1 }, /missing_arg:blocks/], ['flee', { from_mob_id: 1.5, blocks: 5 }, /non_negative/],
    ['flee', { away_from: { dx: 0, dz: 0 }, blocks: 5 }, /is_here/], ['flee', { away_from: { dx: 99, dz: 0 }, blocks: 5 }, /within_64/],
    ['flee', { away_from: { dx: 1 }, blocks: 5 }, /missing_arg:dz/], ['flee', { away_from: 'north', blocks: 5 }, /not_an_object/],
    ['flee', { from_mob_id: 1, blocks: 5, sprint: true }, /unknown_arg:sprint/]];
  for (const [name, args, pattern] of bad) assert.throws(() => validatePrimitive({ type: 'primitive', name, args }), pattern, `${name} ${JSON.stringify(args)}`);
  assert.equal(validateDecision({ ...ok[0], type: 'primitive' }, candidates).args.mob_id, 12);
});

// A fake adapter with mobs and a fake clock. It exposes only observe, requestAction and releaseControls.
function mobBot({ mobs = [{ id: 5, type: 'zombie', hostile: true, x: 3.5, z: 0.5 }], health = 20, inventory = {}, held = null,
  speed = 0.2, frozen = false, blocked = false, killAfter = Infinity, hurtPerSwing = 0, minHealth = null } = {}) {
  const st = { x: 0.5, y: 70, z: 0.5, yaw: 0, t: 0, health, held, actions: [], swings: [], mobs: mobs.map((m) => ({ ...m })) };
  const bot = Object.freeze({
    observe: () => ({ self: { position: { x: st.x, y: st.y, z: st.z }, yaw: st.yaw, pitch: 0, health: st.health, held_item: st.held },
      inventory, terrain: { clearance: { forward: { body_clear: !blocked, head_clear: true } } },
      facts: { position: { x: st.x, y: st.y, z: st.z }, nearest_blocks: {}, nearby_mobs: st.mobs.map((m) => ({ id: m.id, type: m.type, hostile: m.hostile,
        dx: m.x - st.x, dy: 0, dz: m.z - st.z, distance: Math.hypot(m.x - st.x, m.z - st.z) })) } }),
    requestAction: (a) => {
      st.actions.push({ ...a, t: st.t });
      st.yaw += a.yaw_delta ?? 0;
      if (a.equip) st.held = a.equip;
      if (a.forward && !frozen) { st.x += -Math.sin(st.yaw) * speed; st.z += -Math.cos(st.yaw) * speed; }
      if (a.attack_entity != null) {
        st.swings.push(st.t); st.health -= hurtPerSwing;
        if (st.swings.length >= killAfter) st.mobs = st.mobs.filter((m) => m.id !== a.attack_entity);
      }
    },
    releaseControls: () => {},
  });
  const run = createPrimitiveRunner({ bot, now: () => st.t, sleep: async (ms) => { st.t += ms; }, minHealthFor: () => minHealth });
  return { bot, st, run };
}
const adjacent = { id: 5, type: 'zombie', hostile: true, x: 1.9, z: 0.5 };

test('attack faces the mob, walks into reach, and ends when the mob is gone', async () => {
  const w = mobBot({ mobs: [{ id: 5, type: 'zombie', hostile: true, x: 8.5, z: 0.5 }], killAfter: 3 });
  const r = await w.run(prim('attack', { mob_id: 5 }));
  assert.deepEqual([r.outcome, r.reason, r.detail.swings, r.moved], ['success', 'mob_gone', 3, true]);
  assert.ok(w.st.actions.some((a) => a.yaw_delta < 0), 'turns toward a mob to the east');
  assert.ok(w.st.actions.some((a) => a.forward) && w.st.actions.some((a) => a.sprint), 'walks, and sprints while far');
  assert.ok(w.st.x > 5.5, 'ended inside reach of the mob');
  assert.deepEqual(Object.keys(w.bot).sort(), ['observe', 'releaseControls', 'requestAction']);
  assert.equal(w.st.actions.filter((a) => 'attack_entity' in a).every((a) => a.attack_entity === 5), true);
});

test('attack swings no faster than the 1.21 cooldown of what is held, and takes up the best weapon', async () => {
  const fists = mobBot({ mobs: [adjacent] });
  await fists.run(prim('attack', { mob_id: 5 }));
  const sword = mobBot({ mobs: [adjacent], inventory: { stone_axe: 1, iron_sword: 1, diamond_pickaxe: 1 }, held: 'iron_sword' });
  await sword.run(prim('attack', { mob_id: 5 }));
  const gaps = (s) => s.swings.slice(1).map((t, i) => t - s.swings[i]);
  assert.equal(attackCooldownMs(null), 300);
  assert.equal(attackCooldownMs('iron_sword'), 675);
  assert.equal(attackCooldownMs('wooden_axe'), 1300);
  assert.ok(gaps(fists.st).every((g) => g >= 300) && gaps(fists.st).length > 20, String(gaps(fists.st).slice(0, 4)));
  assert.ok(gaps(sword.st).every((g) => g >= 675 && g < 760), String(gaps(sword.st).slice(0, 4)));
  assert.ok(sword.st.swings.length < fists.st.swings.length);
  assert.equal(bestWeapon({ stone_axe: 1, iron_sword: 1, diamond_pickaxe: 1, wooden_sword: 2 }), 'iron_sword');
  assert.equal(bestWeapon({ diamond_pickaxe: 1, dirt: 3 }), null);
  const unarmed = mobBot({ mobs: [adjacent], inventory: { stone_sword: 1 } });
  await unarmed.run(prim('attack', { mob_id: 5 }));
  assert.equal(unarmed.st.actions.find((a) => a.equip).equip, 'stone_sword');
});

test('attack stops at each limit: mob gone, 15 seconds, health under the rule minimum, and bad targets', async () => {
  const slow = mobBot({ mobs: [adjacent] });
  const t = await slow.run(prim('attack', { mob_id: 5 }));
  assert.deepEqual([t.outcome, t.reason], ['timeout', 'time_limit']);
  assert.ok(slow.st.t >= 15000 && slow.st.t < 15200, String(slow.st.t));
  const low = mobBot({ mobs: [adjacent], health: 5, minHealth: 8 });
  const h = await low.run(prim('attack', { mob_id: 5 }));
  assert.deepEqual([h.outcome, h.reason], ['failure', 'health_below_min_health']);
  assert.equal(low.st.swings.length, 0, 'it never swings below the minimum');
  const drops = mobBot({ mobs: [adjacent], health: 12, minHealth: 8, hurtPerSwing: 3 });
  const d = await drops.run(prim('attack', { mob_id: 5 }));
  assert.deepEqual([d.reason, drops.st.swings.length], ['health_below_min_health', 2]);
  const fine = mobBot({ mobs: [adjacent], health: 12, minHealth: null, killAfter: 2 });
  assert.equal((await fine.run(prim('attack', { mob_id: 5 }))).reason, 'mob_gone');
  assert.equal((await mobBot().run(prim('attack', { mob_id: 77 }))).reason, 'mob_not_found');
  assert.equal((await mobBot({ mobs: [{ id: 6, type: 'cow', hostile: false, x: 2, z: 0.5 }] }).run(prim('attack', { mob_id: 6 }))).reason, 'mob_not_hostile');
  const dead = mobBot({ mobs: [adjacent], health: 0 });
  assert.equal((await dead.run(prim('attack', { mob_id: 5 }))).reason, 'bot_death');
});

test('flee runs directly away with sprint, jumps when blocked, and stops at blocks, 15 s, or no progress', async () => {
  const w = mobBot();
  const r = await w.run(prim('flee', { from_mob_id: 5, blocks: 8 }));
  assert.deepEqual([r.outcome, r.reason, r.moved], ['success', 'fled', true]);
  assert.ok(w.st.x < 0.5 - 6, `moved west, away from a mob to the east: x=${w.st.x}`);
  assert.ok(Math.abs(w.st.z - 0.5) < 2.5, 'not sideways');
  assert.ok(w.st.actions.every((a) => a.sprint === true) && w.st.actions.some((a) => a.forward));
  assert.ok(w.st.actions.every((a) => !('attack_entity' in a)));
  const dir = mobBot({ mobs: [] });
  await dir.run(prim('flee', { away_from: { dx: 0, dz: -4 }, blocks: 6 }));
  assert.ok(dir.st.z > 0.5 + 4, `threat to the north, so it ran south: z=${dir.st.z}`);
  const wall = mobBot({ blocked: true, frozen: true });
  const stuck = await wall.run(prim('flee', { from_mob_id: 5, blocks: 10 }));
  assert.deepEqual([stuck.outcome, stuck.reason], ['failure', 'no_progress']);
  assert.ok(wall.st.t >= 3000 && wall.st.t < 3200, String(wall.st.t));
  assert.ok(wall.st.actions.some((a) => a.jump), 'jumps when blocked');
  const slow = mobBot({ speed: 0.02 });
  const t = await slow.run(prim('flee', { from_mob_id: 5, blocks: 32 }));
  assert.deepEqual([t.outcome, t.reason], ['timeout', 'time_limit']);
  assert.ok(slow.st.t >= 15000 && slow.st.t < 15200, String(slow.st.t));
  assert.equal((await mobBot().run(prim('flee', { from_mob_id: 99, blocks: 5 }))).reason, 'mob_not_found');
});

test('attack and flee use only the bot adapter: no RCON, no commands, no model code', () => {
  const source = fs.readFileSync(new URL('./primitives.mjs', import.meta.url), 'utf8') + fs.readFileSync(new URL('./threat.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from '[^']*rcon|rconCommand|child_process|eval\(|new Function|import\(/);
  const w = mobBot();
  assert.deepEqual(Object.keys(w.bot).sort(), ['observe', 'releaseControls', 'requestAction']);
});
