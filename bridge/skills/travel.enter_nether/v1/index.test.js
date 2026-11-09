import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun } from './index.js';
import { SkillRegistry } from '../../registry.js';
import { EventEmitter } from 'node:events';
import { ActionArbiter } from '../../../arbiter.js';
import { main, parseOptions } from '../../../e2e/portal.e2e.mjs';
import { createLiveArena } from '../../../eval/arena.mjs';

process.env.A37_EVAL_SEED = '424242';

const state = (x = 1.5, z = -3.5, dimension = 'overworld') => ({ self: { position: { x, y: 64, z }, health: 20, yaw: Math.PI, pitch: 0 }, facts: { position: { x, y: 64, z }, dimension, nearest_blocks: { nether_portal: { dx: 1 - x, dy: 0, dz: -z } } } });
function fixture(initial, next = (o) => o) {
  let current = initial, releases = 0;
  const actions = [];
  return { actions, releases: () => releases, observe: () => structuredClone(current), requestAction(a) { actions.push(a); current = next(current, a, actions.length); }, releaseControls() { releases++; } };
}

test('registry loads an unevaluated runnable portal entry skill', () => {
  const skill = new SkillRegistry().load('travel.enter_nether', 1);
  assert.equal(skill.evaluation, null);
  assert.deepEqual(skill.success_check.condition, { path: 'facts.dimension', equals: 'the_nether' });
  assert.ok(skill.reset_steps.every((s) => s.command && s.verify));
});

test('approaches a portal then stays inside for multiple observations until Nether arrival', async () => {
  const bot = fixture(state(), (_o, _a, n) => state(1.5, 0.5, n >= 6 ? 'the_nether' : 'overworld'));
  const result = await createRun({ tickMs: 0 })(bot, {}, { signal: AbortSignal.timeout(1000) });
  assert.equal(result.outcome, 'success');
  assert.equal(bot.actions[0].forward, true);
  assert.ok(bot.actions.slice(1).every((a) => !a.forward && !a.back && !a.left && !a.right && !a.jump));
  assert.equal(bot.actions.length, 6);
  assert.equal(bot.releases(), 1);
});

test('missing portal, missing position, death, existing arrival and abort all release controls', async () => {
  for (const [initial, outcome] of [[{ ...state(), facts: { position: { x: 0, y: 64, z: 0 }, nearest_blocks: {} } }, 'failure'], [{ self: { health: 20 } }, 'failure'], [{ ...state(), self: { health: 0 } }, 'failure'], [state(1.5, 0.5, 'the_nether'), 'success']]) {
    const bot = fixture(initial);
    assert.equal((await createRun()(bot, {}, { signal: AbortSignal.timeout(1000) })).outcome, outcome);
    assert.equal(bot.releases(), 1);
    assert.equal(bot.actions.length, 0);
  }
  const bot = fixture(state());
  await assert.rejects(createRun()(bot, {}, { signal: AbortSignal.abort(new Error('stopped')) }), /stopped/);
  assert.equal(bot.releases(), 1);
  const controller = new AbortController();
  const walking = fixture(state(), (o) => { controller.abort(); return o; });
  await assert.rejects(createRun({ tickMs: 0 })(walking, {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(walking.releases(), 1);
  const broken = fixture(state()); broken.observe = () => { throw new Error('observation failed'); };
  await assert.rejects(createRun()(broken, {}, { signal: AbortSignal.timeout(1000) }), /observation failed/);
  assert.equal(broken.releases(), 1);
});

test('turns toward the portal before moving and does not jump or sprint', async () => {
  const controller = new AbortController();
  const initial = state(); initial.self.yaw = 0;
  const bot = fixture(initial, (o, _a, n) => { if (n === 3) controller.abort(); return o; });
  await assert.rejects(createRun({ tickMs: 0 })(bot, {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.ok(bot.actions.every((a) => a.forward === false && !a.jump && !a.sprint && a.yaw_delta !== 0));
  assert.equal(bot.releases(), 1);
});

const liveEnv = {
  A37_MC_HOST: '127.0.0.1', A37_MC_PORT: '25565', A37_MC_VERSION: '1.21.1',
  A37_EVAL_USERNAME: 'Ben_bot', A37_RCON_HOST: '127.0.0.1', A37_RCON_PORT: '25575',
  A37_EVAL_APPROVED_RESET: '1', A37_EVAL_WEB_PORT: '8741', A37_RCON_PASSWORD: 'unit-test-only-password',
};
const args = (trials = 1) => ['--milestone', 'enter', '--trials', String(trials)];

function fakeLive(overrides = {}) {
  const lines = [], commands = [], reports = [];
  let current = atSpawn(), closes = 0, quits = 0;
  const arbiter = new ActionArbiter();
  const rawBot = new EventEmitter();
  rawBot.quit = () => { quits++; rawBot.emit('end'); };
  rawBot.viewer = { close() {} };
  const runtime = { bot: rawBot, recorder: { stop() {} }, ws: { clients: [] }, close() { closes++; rawBot.quit(); } };
  const arena = {
    events: new EventEmitter(), arbiter, synthetic: false,
    observe: () => structuredClone(current), release: () => arbiter.release(),
    close: () => runtime.close(),
    bot: (signal) => ({
      observe: () => structuredClone(current),
      requestAction(action) { signal.throwIfAborted(); arbiter.set('skill', action); if (action.forward) current.facts.dimension = 'the_nether'; },
      releaseControls() { arena.release(); },
    }),
  };
  function atSpawn() {
    const position = { x: 5001.5, y: 101, z: 4996.5 };
    return { self: { position, health: 20, yaw: Math.PI, pitch: 0 }, facts: { position, dimension: 'overworld', nearest_blocks: { nether_portal: { dx: -0.5, dy: 0, dz: 3.5 } } } };
  }
  const dependencies = {
    mkdir() {}, write(_filename, report) { reports.push(structuredClone(report)); }, log(line) { lines.push(line); },
    makeRuntime: async () => runtime,
    async makeArena(options) {
      assert.equal(options.expectedSeed, '424242');
      assert.equal(options.env.A37_RCON_PASSWORD, liveEnv.A37_RCON_PASSWORD);
      await options.runtimeFactory({ webPort: 8741 });
      await options.command({}, 'seed');
      return arena;
    },
    async command(config, text) {
      assert.equal(config.host, '127.0.0.1');
      assert.equal(config.timeoutMs, 5000);
      commands.push(text);
      if (text.includes('tp Ben_bot 5001.5 101 4996.5')) current = atSpawn();
      if (text.startsWith('execute in minecraft:the_nether')) return overrides.confirm === false ? 'Test failed' : 'Test passed, count: 1';
      return text === 'seed' ? 'Seed: [424242]' : 'Test passed';
    },
    ...overrides.dependencies,
  };
  return { dependencies, commands, reports, lines, runtime, arena, closes: () => closes, quits: () => quits };
}

test('e2e rejects unsafe settings and later milestones before any side effects', async () => {
  for (const patch of [{ A37_MC_HOST: 'invalid.example' }, { A37_RCON_HOST: 'invalid.example' }, { A37_EVAL_USERNAME: 'SomeoneElse' }, { A37_EVAL_APPROVED_RESET: '0' }, { A37_MC_VERSION: '1.20.4' }, { AGENT37_JEV: '1' }]) {
    await assert.rejects(main(args(), { ...liveEnv, ...patch }, { command() { assert.fail('preflight must not connect'); }, mkdir() { assert.fail('preflight must not write'); } }));
  }
  assert.deepEqual(parseOptions(['--milestone', 'light', '--trials', '1'], liveEnv), { milestone: 'light', trials: 1 });
  assert.throws(() => parseOptions(['--milestone', 'build', '--trials', '1'], liveEnv), /milestone_not_implemented/);
  assert.throws(() => parseOptions(args(0), liveEnv), /invalid_arguments/);
});

test('e2e runs five fake trials, scopes setup to its region, confirms arrival twice and closes the bot', async () => {
  const fake = fakeLive();
  const result = await main(args(5), liveEnv, fake.dependencies);
  assert.equal(result.passed, true);
  assert.equal(result.report.summary.trials, 5);
  assert.equal(result.report.summary.nether_arrivals, 5);
  assert.equal(fake.lines.filter((line) => line.startsWith('PASS portal enter trial ')).length, 5);
  assert.match(fake.lines.at(-1), /^SUMMARY PASS/);
  assert.equal(fake.commands.filter((c) => c === 'gamemode survival Ben_bot').length, 5);
  const firstFill = fake.commands.findIndex((c) => c.includes('fill '));
  const teleport = fake.commands.findIndex((c) => c.includes('tp Ben_bot 5001.5 140 4996.5'));
  const verification = fake.commands.findIndex((c) => c.includes('if entity @a[name=Ben_bot,x=4994,'));
  assert.ok(teleport < verification && verification < firstFill);
  assert.ok(fake.commands.filter((c) => c.includes('fill ')).every((c) => c.startsWith('execute in minecraft:overworld run fill ')));
  assert.ok(fake.commands.filter((c) => c.includes('tp ')).every((c) => c.startsWith('execute in minecraft:overworld run tp Ben_bot ')));
  assert.ok(fake.commands.filter((c) => c.includes('the_nether')).every((c) => c.endsWith('@a[name=Ben_bot,limit=1,distance=0..]')));
  assert.equal(fake.closes(), 1);
  assert.ok(fake.quits() >= 1);
  assert.ok(!JSON.stringify(fake.reports).includes(liveEnv.A37_RCON_PASSWORD));
  assert.equal(fake.arena.arbiter.tick().source, 'idle');
});

test('e2e cannot pass on a dimension observation without independent RCON confirmation', async () => {
  const fake = fakeLive({ confirm: false });
  const result = await main(args(), liveEnv, fake.dependencies);
  assert.equal(result.passed, false);
  assert.equal(result.report.trials[0].reason, 'nether_arrival_not_confirmed');
  assert.equal(result.report.summary.nether_arrivals, 0);
  assert.match(fake.lines[0], /^FAIL portal enter trial 1\/1/);
  assert.equal(fake.closes(), 1);
});

test('e2e writes startup failures and cleans up a runtime after arena creation fails', async () => {
  const fake = fakeLive();
  fake.dependencies.makeArena = async (options) => { await options.runtimeFactory({}); throw new Error('approved world must use seed 424242'); };
  const result = await main(args(5), liveEnv, fake.dependencies);
  assert.equal(result.passed, false);
  assert.equal(result.report.trials.length, 1);
  assert.equal(result.report.trials[0].reason, 'seed_mismatch');
  assert.equal(result.report.trials[0].phase, 'startup');
  assert.equal(fake.closes(), 1);
  assert.match(fake.lines.at(-1), /^SUMMARY FAIL/);
});

test('e2e stops reset commands after abort and never starts another trial after an RCON timeout', async () => {
  const fake = fakeLive();
  const controller = new AbortController();
  const send = fake.dependencies.command;
  fake.dependencies.command = async (config, text) => {
    const reply = await send(config, text);
    if (text === 'gamemode survival Ben_bot') controller.abort(new Error('reset_timeout'));
    return reply;
  };
  fake.dependencies.trialRunner = async ({ arena }) => {
    await assert.rejects(arena.reset([], { signal: controller.signal }), /reset_timeout/);
    return { trial: 1, outcome: 'failure', reason: 'reset_timeout', elapsed_ms: 0, after: arena.observe() };
  };
  const result = await main(args(5), liveEnv, fake.dependencies);
  assert.equal(result.passed, false);
  assert.equal(result.report.trials.length, 1);
  assert.ok(!fake.commands.some((c) => c.includes('tp ') || c.includes('fill ')));
  assert.equal(fake.closes(), 1);

  const timedOut = fakeLive();
  timedOut.dependencies.command = async () => { throw new Error('rcon_timeout'); };
  const startup = await main(args(5), liveEnv, timedOut.dependencies);
  assert.equal(startup.report.trials[0].reason, 'rcon_timeout');
  assert.equal(startup.report.summary.trials, 1);
});

test('e2e command allowlist rejects any command that could move a bot into the Nether', async () => {
  const fake = fakeLive();
  fake.dependencies.makeArena = async (options) => {
    await options.runtimeFactory({});
    await options.command({}, 'execute in minecraft:the_nether run tp Ben_bot 625 100 625');
  };
  const result = await main(args(), liveEnv, fake.dependencies);
  assert.equal(result.report.trials[0].reason, 'unapproved_rcon_command');
  assert.ok(!fake.commands.some((c) => c.includes('the_nether run tp')));
  assert.equal(fake.closes(), 1);
});

test('e2e respects an existing human controller before making reset changes', async () => {
  const fake = fakeLive();
  fake.arena.arbiter.set('human', { forward: true });
  const result = await main(args(5), liveEnv, fake.dependencies);
  assert.equal(result.passed, false);
  assert.equal(result.report.trials[0].reason, 'human_takeover');
  assert.ok(!fake.commands.some((c) => c.includes('tp ') || c.includes('fill ') || c.includes('gamemode ')));
  assert.equal(fake.closes(), 1);
});

test('e2e run deadline aborts the active trial and disconnects without running another reset', async () => {
  const fake = fakeLive({ dependencies: { runBudgetMs: 10 } });
  const result = await main(args(5), liveEnv, fake.dependencies);
  assert.equal(result.passed, false);
  assert.equal(result.report.trials.length, 1);
  assert.equal(result.report.trials[0].reason, 'run_deadline');
  assert.equal(fake.closes(), 1);
  assert.ok(fake.quits() >= 1);
});

test('e2e refuses to change blocks when the bot cannot be confirmed in its region', async () => {
  const fake = fakeLive();
  const send = fake.dependencies.command;
  fake.dependencies.command = async (config, text) => text.includes('if entity @a[name=Ben_bot,x=4994,') ? 'Test failed' : send(config, text);
  const result = await main(args(5), liveEnv, fake.dependencies);
  assert.equal(result.passed, false);
  assert.equal(result.report.trials.length, 1);
  assert.equal(result.report.trials[0].reason, 'bot_not_in_region');
  assert.ok(!fake.commands.some((c) => c.includes('fill ')));
  assert.equal(fake.closes(), 1);
});

test('real arena honors the explicit team seed and preserves the default seed guard without connecting', async () => {
  for (const [expectedSeed, reply, accepted] of [[undefined, '37001', true], [undefined, '424242', false], ['424242', '424242', true], ['424242', '37001', false]]) {
    const rawBot = new EventEmitter();
    const runtime = {
      bot: rawBot, arbiter: new ActionArbiter(), recorder: { stop() {} }, ws: new EventEmitter(),
      state: () => ({ spawned: true, observation: state() }), close() {},
    };
    runtime.ws.clients = [];
    const options = {
      skill: new SkillRegistry().load('travel.enter_nether', 1), dataDir: 'unused-fake-path', env: liveEnv,
      runtimeFactory: async () => runtime, command: async () => `Seed: [${reply}]`,
      ...(expectedSeed === undefined ? {} : { expectedSeed }),
    };
    if (accepted) (await createLiveArena(options)).close();
    else await assert.rejects(createLiveArena(options), /approved world must use seed/);
  }
});
