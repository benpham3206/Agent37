import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { createRun } from './index.js';
import { SkillRegistry } from '../../registry.js';
import { createLiveArena } from '../../../eval/arena.mjs';
import { ActionArbiter } from '../../../arbiter.js';
import { interactAt } from '../../../interact.js';
import { main, FRAME } from '../../../e2e/portal.e2e.mjs';

process.env.A37_EVAL_SEED = '424242';

const frame = { x: 0, y: 63, z: 0 };
function state({ z = -2, lit = false, slot = 4 } = {}) {
  const position = { x: 1.5, y: 64, z };
  return { self: { position, health: 20, yaw: Math.PI, pitch: 0, hotbar_slot: slot, held_item: 'flint_and_steel' }, inventory: { flint_and_steel: 1 }, facts: { position, dimension: 'overworld', nearest_blocks: {
    obsidian: { type: 'obsidian', dx: -0.5, dy: -1, dz: -z },
    ...(lit ? { nether_portal: { type: 'nether_portal', dx: -0.5, dy: 0, dz: -z } } : {}),
  } } };
}

function fixture(initial = state(), next = (o) => o) {
  let current = initial, releases = 0;
  const actions = [];
  return { actions, releases: () => releases, observe: () => structuredClone(current), requestAction(action) { actions.push(action); current = next(current, action, actions.length); }, releaseControls() { releases++; } };
}
const signal = () => AbortSignal.timeout(2000);

test('registry loads the unevaluated light skill with standalone flat-world resets', () => {
  const skill = new SkillRegistry().load('portal.light', 1);
  assert.equal(skill.evaluation, null);
  assert.equal(skill.implementation.entry_point, 'run');
  assert.deepEqual(skill.requirements.input, { frame });
  assert.deepEqual(skill.success_check.condition, { path: 'facts.nearest_blocks.nether_portal.type', equals: 'nether_portal' });
  assert.ok(skill.reset_steps.every((step) => step.command && step.verify));
});

test('lights the top face of the interior bottom obsidian and explicitly preserves a nonzero hotbar slot', async () => {
  const bot = fixture(state(), () => state({ lit: true }));
  const result = await createRun({ tickMs: 0 })(bot, { frame }, { signal: signal() });
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'portal_lit');
  assert.deepEqual(bot.actions, [{ hotbar: 4, interact: { x: 1, y: 63, z: 0, face: { x: 0, y: 1, z: 0 } } }]);
  assert.equal(bot.releases(), 1);
});

test('approaches before interacting and retries until portal blocks are observed', async () => {
  const bot = fixture(state({ z: -6 }), (_o, _a, n) => n < 3 ? state() : state({ lit: true }));
  const result = await createRun({ tickMs: 0 })(bot, { frame }, { signal: signal() });
  assert.equal(result.outcome, 'success');
  assert.equal(bot.actions[0].forward, true);
  assert.equal(bot.actions[0].interact, undefined);
  assert.ok(bot.actions.every((a) => a.hotbar === 4 && !a.use && !a.attack && !a.jump));
  assert.deepEqual(bot.actions[1].interact, bot.actions[2].interact);
  assert.equal(bot.releases(), 1);
});

test('accepts an already lit target without controls and rejects a different nearby portal', async () => {
  const already = fixture(state({ lit: true }));
  assert.equal((await createRun()(already, { frame }, { signal: signal() })).reason, 'portal_already_lit');
  assert.equal(already.actions.length, 0);
  assert.equal(already.releases(), 1);
  const wrong = state({ lit: true }); wrong.facts.nearest_blocks.nether_portal.dx = 8;
  const bot = fixture(wrong);
  let time = 0;
  const result = await createRun({ tickMs: 0, lightingTimeoutMs: 3, now: () => ++time })(bot, { frame }, { signal: signal() });
  assert.equal(result.reason, 'portal_not_lit');
  assert.ok(bot.actions.length > 0);
  assert.equal(bot.releases(), 1);
});

test('a portal matching the frame in x and y but not z does not count as lit', async () => {
  const initial = state({ lit: true });
  initial.facts.nearest_blocks.nether_portal.dz = 0;
  const bot = fixture(initial);
  let time = 0;
  const result = await createRun({ tickMs: 0, lightingTimeoutMs: 3, now: () => ++time })(bot, { frame }, { signal: signal() });
  assert.equal(result.reason, 'portal_not_lit');
  assert.ok(bot.actions.length > 0);
  assert.equal(bot.releases(), 1);
});

test('invalid frames and unmet equipment or observation requirements release without actions', async () => {
  for (const value of [null, {}, { x: 0.5, y: 63, z: 0 }, { x: 0, y: Infinity, z: 0 }]) {
    const bot = fixture();
    assert.equal((await createRun()(bot, { frame: value }, { signal: signal() })).reason, 'requirement_unmet:invalid_frame');
    assert.equal(bot.actions.length, 0); assert.equal(bot.releases(), 1);
  }
  for (const [change, reason] of [
    [(o) => { o.self.held_item = 'obsidian'; }, 'requirement_unmet:flint_not_held'],
    [(o) => { o.self.hotbar_slot = null; }, 'requirement_unmet:unknown_hotbar'],
    [(o) => { o.self.position = null; }, 'requirement_unmet:no_position'],
    [(o) => { o.facts.position = null; }, 'requirement_unmet:no_position'],
    [(o) => { o.facts.nearest_blocks = {}; }, 'requirement_unmet:no_obsidian'],
    [(o) => { o.facts.dimension = 'the_nether'; }, 'requirement_unmet:not_overworld'],
  ]) {
    const initial = state(); change(initial); const bot = fixture(initial);
    assert.equal((await createRun()(bot, { frame }, { signal: signal() })).reason, reason);
    assert.equal(bot.actions.length, 0); assert.equal(bot.releases(), 1);
  }
});

test('death takes priority over a lit portal, including death during an attempt', async () => {
  const dead = state({ lit: true }); dead.self.health = 0;
  for (const bot of [fixture(dead), fixture(state(), () => dead)]) {
    assert.equal((await createRun({ tickMs: 0 })(bot, { frame }, { signal: signal() })).reason, 'bot_death');
    assert.equal(bot.releases(), 1);
  }
});

test('abort and observation or action errors always release controls', async () => {
  const aborted = fixture();
  await assert.rejects(createRun()(aborted, { frame }, { signal: AbortSignal.abort(new Error('stopped')) }), /stopped/);
  assert.equal(aborted.releases(), 1);
  const controller = new AbortController();
  const attempting = fixture(state(), (o) => { controller.abort(); return o; });
  await assert.rejects(createRun({ tickMs: 0 })(attempting, { frame }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(attempting.releases(), 1);
  for (const method of ['observe', 'requestAction']) {
    const bot = fixture(); bot[method] = () => { throw new Error('fixture error'); };
    await assert.rejects(createRun()(bot, { frame }, { signal: signal() }), /fixture error/);
    assert.equal(bot.releases(), 1);
  }
});

const env = {
  A37_MC_HOST: '127.0.0.1', A37_MC_PORT: '25565', A37_MC_VERSION: '1.21.1',
  A37_EVAL_USERNAME: 'Ben_bot', A37_RCON_HOST: '127.0.0.1', A37_RCON_PORT: '25575',
  A37_EVAL_APPROVED_RESET: '1', A37_EVAL_WEB_PORT: '8741', A37_RCON_PASSWORD: 'unit-test-only-password',
};

function fakeLive({ rejectUnlit = false, rejectLit = false, abortAfterLight = false } = {}) {
  const world = { position: { x: 5001.5, y: 101, z: 4996.5 }, lit: false, frame: false, tool: false, slot: 0, dimension: 'overworld', dwell: 0 };
  const commands = [], actions = [], activations = [], reports = [], lines = [];
  let closes = 0;
  const arbiter = new ActionArbiter(), bot = new EventEmitter();
  bot.entity = { get position() { return world.position; } };
  bot.inventory = { items: () => world.tool ? [{ name: 'flint_and_steel', count: 1 }] : [] };
  bot.quit = () => bot.emit('end');
  bot.blockAt = (position) => ({ name: world.frame ? 'obsidian' : 'air', position });
  bot.activateBlock = async (block, face, cursor) => { activations.push({ position: block.position, face, cursor, slot: world.slot }); assert.equal(world.tool, true); world.lit = true; };
  function observe() {
    const p = world.position;
    return { self: { position: { ...p }, yaw: Math.PI, pitch: 0, health: 20, hotbar_slot: world.slot, held_item: world.tool ? 'flint_and_steel' : null }, facts: { position: { ...p }, dimension: world.dimension, nearest_blocks: {
      ...(world.frame ? { obsidian: { type: 'obsidian', dx: FRAME.x + 1 - p.x, dy: FRAME.y - p.y, dz: FRAME.z - p.z } } : {}),
      ...(world.lit ? { nether_portal: { type: 'nether_portal', dx: FRAME.x + 1 - p.x, dy: FRAME.y + 1 - p.y, dz: FRAME.z - p.z } } : {}),
    } } };
  }
  const runtime = { bot, arbiter, recorder: { stop() {} }, ws: new EventEmitter(), state: () => ({ spawned: true, observation: observe() }), facts: () => observe().facts, close() { closes++; bot.quit(); } };
  runtime.ws.clients = [];
  const dependencies = {
    mkdir() {}, write(_path, report) { reports.push(structuredClone(report)); }, log: (line) => lines.push(line),
    makeRuntime: async (config) => { assert.equal(config.viewerPort, 3741); return runtime; },
    async makeArena(options) {
      const arena = await createLiveArena(options);
      const adapter = arena.bot;
      arena.bot = (signal) => {
        const base = adapter(signal);
        return { ...base, requestAction(action) {
          base.requestAction(action);
          const applied = arbiter.tick().action; actions.push(applied); world.slot = applied.hotbar;
          if (applied.interact) interactAt(bot, applied.interact);
          else if (applied.forward) {
            if (world.lit) world.position.z = FRAME.z + 0.5;
            else world.position.z += 0.6;
          } else if (world.lit && world.position.z === FRAME.z + 0.5 && ++world.dwell >= 5) world.dimension = 'the_nether';
        } };
      };
      return arena;
    },
    async command(_config, text) {
      commands.push(text);
      if (text === 'seed') return 'Seed: [424242]';
      if (text.includes('run tp Ben_bot')) { world.position = { x: 5001.5, y: text.includes(' 140 ') ? 140 : 101, z: 4996.5 }; world.dimension = 'overworld'; world.dwell = 0; }
      if (text.includes('run fill 4994 101')) { world.lit = false; world.frame = false; }
      if (text.includes('run fill 5000 100')) world.frame = true;
      if (text === 'clear Ben_bot') world.tool = false;
      if (text.startsWith('item replace entity Ben_bot')) { world.tool = true; world.slot = 0; }
      if (text.includes('if block 5000 100 5000 minecraft:obsidian')) return !world.lit && world.frame && !rejectUnlit ? 'Test passed' : 'Test failed';
      if (text === 'execute in minecraft:overworld if block 5001 101 5000 minecraft:nether_portal[axis=x]') {
        if (abortAfterLight) process.emit('SIGINT');
        return world.lit && !rejectLit ? 'Test passed' : 'Test failed';
      }
      if (text.startsWith('execute in minecraft:the_nether')) return world.dimension === 'the_nether' ? 'Test passed' : 'Test failed';
      return 'Test passed';
    },
  };
  return { dependencies, commands, actions, activations, reports, lines, world, closes: () => closes, arbiter };
}

test('light milestone runs five fake light-then-enter trials with unlit setup, real arbiter and real action helper', async () => {
  const fake = fakeLive();
  const result = await main(['--milestone', 'light', '--trials', '5'], env, fake.dependencies);
  assert.equal(result.passed, true);
  assert.equal(result.report.summary.nether_arrivals, 5);
  assert.equal(fake.activations.length, 5);
  assert.ok(fake.activations.every((a) => a.position.equals(new Vec3(5001, 100, 5000)) && a.face.equals(new Vec3(0, 1, 0)) && a.cursor.equals(new Vec3(0.5, 1, 0.5)) && a.slot === 0));
  assert.ok(!fake.commands.some((c) => c.includes('run fill ') && c.includes('minecraft:nether_portal')));
  const setupChecks = fake.commands.filter((c) => c.includes('if block 5000 100 5000 minecraft:obsidian'));
  assert.equal(setupChecks.length, 5);
  assert.ok(setupChecks.every((c) => c.match(/minecraft:obsidian/g).length === 14 && c.match(/minecraft:air/g).length === 6));
  for (const row of result.report.trials) {
    assert.deepEqual(row.stages.map((stage) => stage.skill), ['portal.light', 'travel.enter_nether']);
    assert.equal(row.stages[0].before.facts.nearest_blocks.nether_portal, undefined);
    assert.equal(row.stages[0].reason, 'portal_lit');
    assert.equal(row.stages[0].rcon_portal, 'Test passed');
    assert.equal(row.stages[1].after.facts.dimension, 'the_nether');
  }
  assert.equal(fake.lines.filter((line) => line.startsWith('PASS portal light trial ')).length, 5);
  assert.match(fake.lines.at(-1), /^SUMMARY PASS/);
  assert.equal(fake.closes(), 1);
  assert.equal(fake.arbiter.tick().source, 'idle');
  assert.ok(!JSON.stringify(fake.reports).includes(env.A37_RCON_PASSWORD));
});

test('unlit-frame rejection prevents lighting, and rejected lighting confirmation prevents entry', async () => {
  for (const [options, reason, activationCount] of [[{ rejectUnlit: true }, 'unlit_frame_not_verified', 0], [{ rejectLit: true }, 'portal_lighting_not_confirmed', 1]]) {
    const fake = fakeLive(options);
    const result = await main(['--milestone', 'light', '--trials', '5'], env, fake.dependencies);
    assert.equal(result.passed, false);
    assert.equal(result.report.trials.length, 1);
    assert.equal(result.report.trials[0].reason, reason);
    assert.equal(fake.activations.length, activationCount);
    assert.equal(fake.world.dimension, 'overworld');
    assert.equal(fake.closes(), 1);
  }
});

test('abort between lighting and entry releases controls, disconnects and does not enter', async () => {
  const fake = fakeLive({ abortAfterLight: true });
  const result = await main(['--milestone', 'light', '--trials', '5'], env, fake.dependencies);
  assert.equal(result.passed, false);
  assert.equal(result.report.trials.length, 1);
  assert.equal(result.report.trials[0].reason, 'interrupted');
  assert.equal(fake.world.dimension, 'overworld');
  assert.equal(fake.closes(), 1);
  assert.equal(fake.arbiter.tick().source, 'idle');
});
