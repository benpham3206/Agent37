import test from 'node:test';
import assert from 'node:assert/strict';
import { createChainCiArena, createChainRegion, holdArena, parseOptions, prepareChainRun, runChain } from './chain.mjs';

const missing = async (step) => ({ name: step.skills[0] ?? null,
  outcome: step.skills.length ? 'no_skill' : 'no_owner', reason: 'missing_fixture' });
const evaluate = (options = {}) => runChain({ arena: createChainCiArena(), resolveSkill: missing,
  onSummary() {}, ...options });

test('a missing skill is recorded as no_skill and later legs still run', async () => {
  const report = await evaluate();
  assert.equal(report.synthetic, true);
  assert.equal(report.rows.find((r) => r.step === 'wood').outcome, 'no_skill');
  assert.equal(report.rows.find((r) => r.step === 'enter').outcome, 'no_skill');
  assert.equal(report.rows.find((r) => r.step === 'obsidian').outcome, 'no_owner');
  assert.equal(report.runs[0].completed, true);
  assert.equal(report.runs[0].status, 'FAIL');
  assert.equal(report.passed, false);
});

test('a grant never counts as a pass even when it satisfies the scorer', async () => {
  const report = await evaluate();
  const wood = report.rows.find((r) => r.step === 'wood' && r.attempt === 'staged');
  const grant = wood.assistance.find((a) => a.kind === 'grant');
  assert.equal(grant.after.inventory.oak_log, 5);
  assert.equal(grant.scorer.status, 'demo-ready');
  assert.equal(grant.scorer.mismatch, true);
  assert.equal(wood.outcome, 'no_skill');
  assert.equal(report.runs[0].unassisted_depth, 1);
  assert.equal(report.runs[0].first_blocker.step, 'wood');
  assert.equal(report.rows.find((r) => r.step === 'tools').upstream_assisted, true);
});

test('--no-assist stops at the first natural failure without gifts or stages', async () => {
  const arena = createChainCiArena();
  const options = parseOptions(['--ci', '--runs', '1', '--no-assist']);
  const report = await evaluate({ arena, ...options });
  assert.deepEqual(report.rows.map((r) => [r.step, r.attempt]), [['spawn', 'natural'], ['wood', 'natural']]);
  assert.deepEqual(arena.commands, ['tick query']);
  assert.equal(report.runs[0].unassisted_depth, 1);
});

test('skills receive only the adapter and none of their reset_steps run', async () => {
  const arena = createChainCiArena();
  let executed = 0;
  const report = await evaluate({ arena, resolveSkill: async (step) => ({
    name: step.skills[0] ?? 'fixture',
    skill: { version: 1, reset_steps: [{ command: 'forbidden_reset' }],
      success_check: { time_limit_ms: 1000, condition: { path: 'self.health', equals: 20 } } },
    run: async (bot) => {
      executed++;
      assert.deepEqual(Object.keys(bot).sort(), ['observe', 'releaseControls', 'requestAction']);
      const before = bot.observe();
      bot.requestAction({});
      return { outcome: 'success', reason: 'fixture_ready', elapsed_ms: 0, before, after: bot.observe() };
    },
  }) });
  assert.ok(executed >= 6);
  assert.equal(arena.resetCalls, 0);
  assert.ok(!arena.commands.includes('forbidden_reset'));
  assert.equal(report.rows.find((r) => r.step === 'enter').reason, 'not_in_the_nether');
  assert.equal(report.rows.find((r) => r.step === 'light').reason, 'frame_interior_not_lit');
});

test('--live refuses a non-loopback host before opening connections', () => {
  assert.throws(() => parseOptions(['--live', '--runs', '1'], { A37_MC_HOST: 'not-loopback' }), /loopback A37_MC_HOST/);
  assert.throws(() => parseOptions(['--live', '--runs', '1'], {
    A37_MC_HOST: '127.0.0.1', A37_RCON_HOST: 'not-loopback',
  }), /loopback A37_RCON_HOST/);
});

test('a staged pass diagnoses navigation but does not restore natural depth', async () => {
  let woodAttempts = 0;
  const report = await evaluate({ resolveSkill: async (step) => step.id !== 'wood' ? missing(step) : ({
    name: 'resource.collect_oak_log',
    skill: { version: 1, success_check: { time_limit_ms: 1000, condition: { path: 'self.health', equals: 20 } } },
    run: async (bot) => {
      const before = bot.observe();
      const staged = ++woodAttempts === 2;
      return { outcome: staged ? 'success' : 'failure', reason: staged ? 'log_collected' : 'no_log_in_range',
        elapsed_ms: 0, before, after: bot.observe() };
    },
  }) });
  assert.equal(report.runs[0].unassisted_depth, 1);
  assert.deepEqual(report.runs[0].findings[0], { step: 'wood', classification: 'finding_or_navigation' });
  assert.equal(report.rows.find((r) => r.step === 'wood' && r.attempt === 'staged').assistance.length, 1);
});

test('a run deadline cancels a stuck skill and preserves its timeout row', async () => {
  const report = await evaluate({ runLimitMs: 200, noAssist: true, resolveSkill: async (step) => ({
    name: step.skills[0],
    skill: { success_check: { time_limit_ms: 1000, condition: { path: 'self.health', equals: 20 } } },
    run: () => new Promise(() => {}),
  }) });
  const wood = report.rows.find((r) => r.step === 'wood');
  assert.equal(wood.outcome, 'timeout');
  assert.equal(report.runs[0].unassisted_depth, 1);
  assert.equal(report.rows.length, 2);
});

test('RCON failure prevents later commands and marks unstarted runs as failures', async () => {
  const arena = createChainCiArena();
  const commands = [];
  arena.command = async (command) => { commands.push(command); throw new Error('rcon_unreachable'); };
  const report = await evaluate({ arena, runs: 3 });
  assert.deepEqual(commands, ['tick query']);
  assert.equal(report.rows.length, 3);
  assert.equal(report.rows[0].reason, 'rcon_unavailable');
  assert.equal(report.rows[1].reason, 'not_started:rcon_unavailable');
  assert.equal(report.runs.every((r) => r.status === 'FAIL'), true);
  assert.equal(report.tick_samples[0].error, 'rcon_unreachable');
});

test('human takeover interrupts the skill and suppresses assistance', async () => {
  const arena = createChainCiArena();
  const report = await evaluate({ arena, resolveSkill: async (step) => ({
    name: step.skills[0],
    skill: { success_check: { time_limit_ms: 1000, condition: { path: 'self.health', equals: 20 } } },
    run: async (bot) => {
      const before = bot.observe();
      arena.events.emit('human_takeover');
      return { outcome: 'success', reason: 'claimed_success', elapsed_ms: 0, before, after: bot.observe() };
    },
  }) });
  assert.equal(report.rows[1].reason, 'human_takeover');
  assert.deepEqual(arena.commands, ['tick query']);
  assert.equal(report.rows.length, 2);
});

test('staging waits for the target chunk and refreshed block facts before invoking wood', async () => {
  const arena = createChainCiArena();
  const originalObserve = arena.observe, originalCommand = arena.command;
  let polls = 0, written = false, wroteBeforeLoad = false, calls = 0;
  const blocks = new Map();
  arena.settle = async () => { polls++; };
  arena.inspectBlock = (position) => ({ position, loaded: polls >= 2,
    name: blocks.get(JSON.stringify(position)) ?? 'air' });
  arena.observe = () => {
    const state = originalObserve();
    if (written && polls >= 4) state.facts.nearest_blocks.oak_log = {
      type: 'oak_log', dx: 3, dy: 0, dz: 0,
    };
    else delete state.facts.nearest_blocks.oak_log;
    return state;
  };
  arena.command = async (command) => {
    const match = command.match(/^setblock (-?\d+) (-?\d+) (-?\d+) minecraft:(\w+)$/);
    if (match) {
      const position = { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
      if (match[4] === 'oak_log') {
        wroteBeforeLoad = polls < 2;
        written = !wroteBeforeLoad;
      }
      if (polls >= 2) blocks.set(JSON.stringify(position), match[4]);
      await originalCommand(command);
      return `Changed the block at ${position.x}, ${position.y}, ${position.z}`;
    }
    return originalCommand(command);
  };
  const report = await evaluate({ arena, stageTimeoutMs: 50, resolveSkill: async (step) =>
    step.id !== 'wood' ? missing(step) : ({
      name: 'resource.collect_oak_log',
      skill: { success_check: { time_limit_ms: 1000, condition: { path: 'self.health', equals: 20 } } },
      run: async (bot) => {
        calls++;
        const before = bot.observe();
        const seen = Boolean(before.facts.nearest_blocks.oak_log);
        return { outcome: seen ? 'success' : 'failure', reason: seen ? 'log_collected' : 'no_log_in_range',
          elapsed_ms: 0, before, after: bot.observe() };
      },
    }) });
  const row = report.rows.find((r) => r.step === 'wood' && r.attempt === 'staged');
  assert.equal(row.outcome, 'success');
  assert.equal(wroteBeforeLoad, false);
  assert.equal(calls, 2);
  assert.equal(row.assistance[0].status, 'ready');
  assert.equal(row.assistance[0].verification.samples[0].block.loaded, false);
  assert.equal(row.attempt_before.facts.nearest_blocks.oak_log.type, 'oak_log');
});

test('a rejected stage is reported as setup failure and never invokes the staged skill', async () => {
  const arena = createChainCiArena(), command = arena.command;
  arena.command = async (text) => text.startsWith('setblock ') && text.endsWith('minecraft:oak_log')
    ? 'Could not set the block' : command(text);
  let calls = 0;
  const report = await evaluate({ arena, stageTimeoutMs: 25, resolveSkill: async (step) =>
    step.id !== 'wood' ? missing(step) : ({
      name: 'resource.collect_oak_log',
      skill: { success_check: { time_limit_ms: 1000, condition: { path: 'self.health', equals: 20 } } },
      run: async (bot) => {
        calls++;
        const before = bot.observe();
        return { outcome: 'failure', reason: 'no_log_in_range', elapsed_ms: 0, before, after: bot.observe() };
      },
    }) });
  const row = report.rows.find((r) => r.step === 'wood' && r.attempt === 'staged');
  assert.equal(row.reason, 'stage_failed:command_rejected');
  assert.equal(row.failure_type, 'stage_setup');
  assert.equal(row.skill_started, false);
  assert.equal(calls, 1);
  assert.equal(row.assistance[0].commands[0].accepted, false);
  assert.equal(report.runs[0].findings[0].classification, 'stage_setup');
});

test('accepted commands cannot launch a skill with an unloaded chunk, absent block, or stale facts', async () => {
  for (const cause of ['target_chunk_not_loaded', 'block_not_observed', 'target_not_in_facts']) {
    const arena = createChainCiArena(), inspect = arena.inspectBlock, observe = arena.observe;
    if (cause !== 'target_not_in_facts') arena.inspectBlock = (p) => ({
      ...inspect(p), loaded: cause !== 'target_chunk_not_loaded', name: 'air',
    });
    else arena.observe = () => {
      const state = observe();
      delete state.facts.nearest_blocks.oak_log;
      return state;
    };
    let calls = 0;
    const report = await evaluate({ arena, stageTimeoutMs: 15, resolveSkill: async (step) =>
      step.id !== 'wood' ? missing(step) : ({
        name: 'resource.collect_oak_log',
        skill: { success_check: { time_limit_ms: 1000, condition: { path: 'self.health', equals: 20 } } },
        run: async (bot) => {
          calls++;
          const before = bot.observe();
          return { outcome: 'failure', reason: 'no_log_in_range', elapsed_ms: 0, before, after: bot.observe() };
        },
      }) });
    const row = report.rows.find((r) => r.step === 'wood' && r.attempt === 'staged');
    assert.equal(row.reason, `stage_failed:${cause}`);
    assert.equal(row.failure_type, 'stage_setup');
    assert.equal(row.skill_started, false);
    assert.equal(calls, 1);
    assert.ok(row.assistance[0].verification.samples.length > 0);
    assert.equal(row.assistance[0].status, 'failed');
    if (cause !== 'target_chunk_not_loaded') assert.equal(row.assistance[0].commands[0].accepted, true);
  }
});

test('the chosen start accepts either owned bot and fractional hold minutes', () => {
  for (const username of ['Ben_bot', 'Vikram_bot']) {
    const options = parseOptions(['--live', '--runs', '1', '--start=-8048,-7984', '--hold-minutes', '0.5'], {
      A37_MC_HOST: '127.0.0.1', A37_RCON_HOST: 'localhost', A37_EVAL_USERNAME: username,
      A37_EVAL_APPROVED_RESET: '1',
    });
    assert.deepEqual(options.start, { x: -8048, z: -7984 });
    assert.equal(options.username, username);
    assert.equal(options.holdMinutes, 0.5);
  }
  assert.throws(() => parseOptions(['--ci', '--runs', '1'], { A37_EVAL_USERNAME: 'Other_bot' }), /owns only/);
  assert.deepEqual(parseOptions(['--ci', '--runs', '1', '--start', '-8048,-7984']).start,
    { x: -8048, z: -7984 });
  for (const start of ['', '1', '1,2,3', 'NaN,2', '1e309,2', '1;command,2', ',2']) {
    assert.throws(() => parseOptions(['--ci', '--runs', '1', `--start=${start}`]), /start/);
  }
  const defaults = createChainRegion();
  assert.deepEqual(defaults.center, { x: 11000, z: 5000 });
  assert.equal(defaults.plots.length, 25);
  const chosen = createChainRegion({ x: -8048, z: -7984 });
  assert.equal(chosen.radius, 400);
  assert.deepEqual(chosen.plots[0], chosen.center);
  assert.ok(chosen.plots.every((p) => Math.hypot(p.x + 8048, p.z + 7984) + 36 < 400));
});

function setupFixture({ failedSpreads = 0, relocate = true } = {}) {
  let spreads = 0;
  const state = { self: { position: { x: 0, y: 70, z: 0 }, health: 20, on_ground: true },
    dimension: 'the_nether', inventory: {}, facts: {} };
  const arena = {
    observe: () => structuredClone(state), commandBudgetMs: 0,
    gameMode: () => 'survival', waitForChunks: async () => {}, settle: async () => {},
    inspectBlock: () => ({ loaded: true, name: 'air' }),
    async command(command) {
      if (command.includes('spreadplayers ')) {
        if (++spreads <= failedSpreads) return 'Could not spread 1 entity/entities around the selected plot';
        const match = command.match(/spreadplayers (-?\d+) (-?\d+)/);
        if (relocate) {
          state.dimension = 'overworld';
          state.self.position = { x: Number(match[1]) + 0.5, y: 70, z: Number(match[2]) + 0.5 };
        }
        return `Spread 1 player(s) around ${match[1]}, ${match[2]} with an average distance of 0.00 blocks apart`;
      }
      return '';
    },
  };
  return arena;
}

test('setup retries a rejected ocean plot without teleporting into the sky, including later runs', async () => {
  const arena = setupFixture({ failedSpreads: 1 }), journal = [];
  const first = await prepareChainRun(arena, { journal, username: 'Ben_bot' });
  assert.equal(first.chunks_loaded, true);
  assert.equal(journal.filter((e) => e.command.includes('spreadplayers ')).length, 2);
  assert.equal(journal.find((e) => e.command.includes('spreadplayers ')).accepted, false);
  assert.ok(journal.every((e) => !/\btp\b/.test(e.command)));
  const previous = [arena.observe().self.position];
  await prepareChainRun(arena, { previous, journal, username: 'Ben_bot' });
  const second = arena.observe().self.position;
  assert.ok(Math.hypot(second.x - previous[0].x, second.z - previous[0].z) >= 200);
  assert.ok(journal.filter((e) => e.command.includes('spreadplayers '))
    .every((e) => e.command.startsWith('execute in minecraft:overworld run ') && e.command.endsWith(' Ben_bot')));
});

test('setup reports exhausted safe plots and rejects a spread reply without observed relocation', async () => {
  const region = { ...createChainRegion(), plots: [{ x: 11000, z: 5000 }] };
  await assert.rejects(prepareChainRun(setupFixture({ failedSpreads: 99 }), { region }), /no_safe_approved_plot/);
  await assert.rejects(prepareChainRun(setupFixture({ relocate: false }), {
    region, readinessTimeoutMs: 5,
  }), /no_safe_approved_plot/);
});

test('chosen-start stages and frame grants protect the ruined portal and name only the selected bot', async () => {
  const region = createChainRegion({ x: -8048, z: -7984 });
  const arena = createChainCiArena({ region, username: 'Ben_bot' });
  const report = await evaluate({ arena, region, username: 'Ben_bot' });
  assert.equal(report.username, 'Ben_bot');
  assert.deepEqual(report.runs[0].start.position, { x: -8048, y: 70, z: -7984 });
  const mutations = arena.commands.filter((c) => /^(fill|setblock) /.test(c));
  assert.ok(mutations.length > 0);
  for (const command of mutations) {
    const [verb, ...parts] = command.split(' ');
    const [x1, , z1, x2 = x1, , z2 = z1] = parts.slice(0, verb === 'fill' ? 6 : 3).map(Number);
    const closestX = Math.max(Math.min(x1, x2), Math.min(-8048, Math.max(x1, x2)));
    const closestZ = Math.max(Math.min(z1, z2), Math.min(-7984, Math.max(z1, z2)));
    assert.ok(Math.hypot(closestX + 8048, closestZ + 7984) >= 20, command);
    for (const x of [x1, x2]) for (const z of [z1, z2]) assert.ok(Math.hypot(x + 8048, z + 7984) <= 400, command);
  }
  assert.ok(arena.commands.filter((c) => /^(give|item replace|tp) /.test(c)).every((c) => c.includes('Ben_bot')));
  assert.ok(!arena.commands.some((c) => c.includes('Vikram_bot')));
  assert.equal(report.runs[0].unassisted_depth, 1);
});

test('stages and frame grants near the region edge relocate inside the region instead of aborting', async () => {
  const region = createChainRegion({ x: -8048, z: -7984 });
  region.plots[0] = { x: -7756, z: -8250 };
  const arena = createChainCiArena({ region, username: 'Ben_bot' });
  const report = await evaluate({ arena, region, username: 'Ben_bot' });
  assert.equal(report.runs[0].error, undefined);
  assert.ok(arena.commands.some((c) => c.includes('minecraft:obsidian')));
  for (const command of arena.commands.filter((c) => /^(fill|setblock) /.test(c))) {
    const [verb, ...parts] = command.split(' ');
    const [x1, , z1, x2 = x1, , z2 = z1] = parts.slice(0, verb === 'fill' ? 6 : 3).map(Number);
    for (const x of [x1, x2]) for (const z of [z1, z2]) assert.ok(Math.hypot(x + 8048, z + 7984) <= 400, command);
  }
});

test('wood collection success is checked from inventory and iron is called without descent', async () => {
  const arena = createChainCiArena();
  const report = await evaluate({ arena, resolveSkill: async (step) => {
    if (!['wood', 'iron'].includes(step.id)) return missing(step);
    return {
      name: step.id === 'wood' ? 'resource.collect_wood' : 'resource.mine_iron_ore',
      skill: { version: 1, requirements: { input: step.id === 'wood' ? { count: 5 } : {} },
        success_check: { time_limit_ms: 1000, condition: step.id === 'wood'
          ? { path: 'wood.goal_reached', equals: true } : { path: 'inventory.raw_iron', increase_by: 1 } } },
      run: async (bot, input) => {
        const before = bot.observe();
        assert.equal(input.descent, undefined);
        if (step.id === 'wood') await arena.command('give Vikram_bot minecraft:oak_log 5');
        return { outcome: 'success', reason: 'fixture', elapsed_ms: 0, before, after: bot.observe() };
      },
    };
  } });
  assert.equal(report.rows.find((r) => r.step === 'wood').outcome, 'success');
  assert.equal(report.rows.find((r) => r.step === 'iron').reason, 'success_check_not_met');
});

test('a fractional idle hold leaves an arrived bot in the Nether', async () => {
  const arena = createChainCiArena();
  await arena.prepare(1);
  const observe = arena.observe;
  arena.observe = () => ({ ...observe(), dimension: 'the_nether' });
  const report = { events: [], passed: false };
  await holdArena(arena, report, 0.001, { onMessage() {}, persist() {} });
  assert.equal(report.hold.status, 'finished');
  assert.equal(report.hold.dimension, 'the_nether');
  assert.equal(arena.observe().dimension, 'the_nether');
  assert.deepEqual(arena.commands, []);
});

test('partial natural wood collection cannot satisfy the staged one-log diagnostic', async () => {
  const arena = createChainCiArena();
  let attempts = 0;
  const report = await evaluate({ arena, resolveSkill: async (step) => step.id !== 'wood' ? missing(step) : ({
    name: 'resource.collect_wood',
    skill: { requirements: { input: { count: 5 } },
      success_check: { time_limit_ms: 1000, condition: { path: 'wood.goal_reached', equals: true } } },
    run: async (bot, input) => {
      const before = bot.observe();
      if (++attempts === 1) await arena.command('give Vikram_bot minecraft:oak_log 2');
      else assert.equal(input.count, 3);
      return { outcome: attempts === 1 ? 'failure' : 'success', reason: 'fixture',
        elapsed_ms: 0, before, after: bot.observe() };
    },
  }) });
  assert.equal(report.rows.find((r) => r.step === 'wood' && r.attempt === 'staged').reason, 'success_check_not_met');
});

test('a bot failure interrupts the idle hold and persists the reason', async () => {
  const arena = createChainCiArena();
  await arena.prepare(1);
  const report = { events: [], passed: true };
  const holding = holdArena(arena, report, 0.01, { onMessage() {}, persist() {} });
  arena.events.emit('failure', 'bot_end');
  await holding;
  assert.equal(report.hold.status, 'interrupted');
  assert.equal(report.hold.failure_reason, 'bot_end');
  assert.equal(report.passed, false);
  assert.equal(arena.events.listenerCount('failure'), 0);
});

const spyWatchdog = (events = []) => {
  const w = { events, arms: 0, disarms: 0,
    arm() { w.arms++; }, disarm() { w.disarms++; }, async tick() {} };
  return w;
};
const succeedingSkill = (step, run = async (bot) => {
  const before = bot.observe();
  return { outcome: 'success', reason: 'fixture', elapsed_ms: 0, before, after: bot.observe() };
}) => ({
  name: step.skills[0] ?? 'fixture',
  skill: { version: 1, success_check: { time_limit_ms: 1000, condition: { path: 'self.health', equals: 20 } } },
  run,
});

test('watchdog factories are never created while their flags are off', async () => {
  let created = 0;
  const factory = () => { created++; return spyWatchdog(); };
  await evaluate({ createUnstuckWatchdog: factory, createMobWatchdog: factory });
  assert.equal(created, 0);
});

test('a stuck reset during a natural success bars unassisted depth and records assistance', async () => {
  const event = { step: 'wood', at_ms: 1, reason: 'no_movement',
    from: { x: 0, y: 70, z: 0 }, to: { x: 3.5, y: 70, z: 0.5 }, distance: 3.5,
    attempt: 1, rcon_reply: 'Teleported Vikram_bot', confirmed: true };
  const stuck = spyWatchdog([event]);
  let mobCreated = 0;
  const lines = [];
  const report = await evaluate({
    unstuck: true,
    createUnstuckWatchdog: () => stuck,
    createMobWatchdog: () => { mobCreated++; return spyWatchdog(); },
    onSummary: (line) => lines.push(line),
    resolveSkill: async (step) => step.id === 'wood' ? succeedingSkill(step) : missing(step),
  });
  const wood = report.rows.find((r) => r.step === 'wood' && r.attempt === 'natural');
  assert.equal(wood.outcome, 'success');
  assert.equal(wood.watchdog_assisted, true);
  assert.ok(wood.assistance.some((a) => a.type === 'stuck_reset' && a.reason === 'no_movement' && a.confirmed === true));
  const run = report.runs[0];
  assert.equal(run.unassisted_depth, 1);
  assert.equal(run.assisted, true);
  assert.deepEqual(run.first_blocker, { step: 'wood', reason: 'watchdog_assist', outcome: 'assisted' });
  assert.deepEqual(run.watchdog, { stuck_resets: 1, mob_removals: 0 });
  assert.ok(lines.some((line) => line.includes('stuck_resets=1') && line.includes('mob_removals=0')));
  assert.equal(mobCreated, 0);
});

test('a mob removal during a natural success bars unassisted depth and records assistance', async () => {
  const event = { step: 'wood', at_ms: 1, reason: 'close_hostile', mob_type: 'zombie',
    mob_id: 7, uuid: '123e4567-e89b-42d3-a456-426614174000', distance: 4, health: 20,
    rcon_reply: 'Killed 123e4567-e89b-42d3-a456-426614174000', confirmed: true };
  const mob = spyWatchdog([event]);
  let unstuckCreated = 0;
  const report = await evaluate({
    mobWatch: true,
    createUnstuckWatchdog: () => { unstuckCreated++; return spyWatchdog(); },
    createMobWatchdog: () => mob,
    resolveSkill: async (step) => step.id === 'wood' ? succeedingSkill(step) : missing(step),
  });
  const wood = report.rows.find((r) => r.step === 'wood' && r.attempt === 'natural');
  assert.equal(wood.outcome, 'success');
  assert.equal(wood.watchdog_assisted, true);
  assert.ok(wood.assistance.some((a) => a.type === 'mob_removed' && a.reason === 'close_hostile' && a.uuid === event.uuid));
  const run = report.runs[0];
  assert.equal(run.unassisted_depth, 1);
  assert.equal(run.assisted, true);
  assert.deepEqual(run.first_blocker, { step: 'wood', reason: 'watchdog_assist', outcome: 'assisted' });
  assert.deepEqual(run.watchdog, { stuck_resets: 0, mob_removals: 1 });
  assert.equal(unstuckCreated, 0);
});

test('watchdogs disarm when a skill throws', async () => {
  const made = [];
  const create = () => { const w = spyWatchdog(); made.push(w); return w; };
  const report = await evaluate({
    unstuck: true, mobWatch: true,
    createUnstuckWatchdog: create, createMobWatchdog: create,
    resolveSkill: async (step) => step.id === 'wood' ? succeedingSkill(step,
      async () => { throw new Error('skill_boom'); }) : missing(step),
  });
  assert.equal(report.rows.find((r) => r.step === 'wood' && r.attempt === 'natural').reason, 'skill_boom');
  assert.equal(made.length, 2);
  for (const w of made) {
    assert.ok(w.arms > 0);
    assert.equal(w.arms, w.disarms);
  }
});

test('reaching the Nether below full unassisted depth still reports FAIL', async () => {
  const arena = createChainCiArena();
  const observe = arena.observe;
  let inNether = false;
  arena.observe = () => ({ ...observe(), dimension: inNether ? 'the_nether' : 'overworld' });
  const report = await evaluate({ arena, resolveSkill: async (step) => {
    if (step.id === 'obsidian' || step.id === 'light') return missing(step);
    return succeedingSkill(step, async (bot) => {
      const before = bot.observe();
      if (step.id === 'enter') inNether = true;
      return { outcome: 'success', reason: 'fixture', elapsed_ms: 0, before, after: bot.observe() };
    });
  } });
  const run = report.runs[0];
  assert.ok(run.unassisted_depth < 7);
  assert.equal(run.unassisted_depth, 4);
  assert.equal(run.end.dimension, 'the_nether');
  assert.equal(run.nether_reached, true);
  assert.equal(run.status, 'FAIL');
  assert.equal(report.passed, false);
});
