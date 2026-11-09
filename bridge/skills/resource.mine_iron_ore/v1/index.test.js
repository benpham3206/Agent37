import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, createDescentRun } from './index.js';
import { buildTerrainObservation } from '../../../observation.js';
import { SkillRegistry } from '../../registry.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { ActionArbiter } from '../../../arbiter.js';
import { createLiveArena } from '../../../eval/arena.mjs';
import { evaluateIron, parseOptions } from '../../../e2e/iron.e2e.mjs';

process.env.A37_EVAL_SEED = '424242';

const ore = (type = 'iron_ore', dx = 3, dy = 0, dz = 0) => ({ type, distance: Math.hypot(dx, dy, dz), dx, dy, dz });
function state(blocks = { iron_ore: ore() }, x = 0) {
  return { self: { position: { x, y: 64, z: 0 }, health: 20, yaw: -Math.PI / 2,
    pitch: 0, held_item: 'stone_pickaxe', hotbar_slot: 2 }, inventory: { stone_pickaxe: 1 },
  facts: { position: { x, y: 64, z: 0 }, nearest_blocks: blocks } };
}
function fakeBot(initial, next = (o) => o) {
  let current = initial, releases = 0;
  const actions = [];
  return { actions, releases: () => releases, observe: () => structuredClone(current),
    requestAction(a) { actions.push(a); current = next(current, a); }, releaseControls() { releases++; } };
}
const signal = () => AbortSignal.timeout(1000);

test('surface holds still until grounded before starting a dig', async () => {
  const initial = state(); initial.self.on_ground = false;
  const bot = fakeBot(initial, (o, action) => {
    if (bot.actions.length === 1) {
      assert.equal(action.dig, undefined);
      assert.equal(action.forward, false);
      return { ...o, self: { ...o.self, on_ground: true } };
    }
    assert.ok(action.dig);
    return { ...o, inventory: { raw_iron: 1 } };
  });
  assert.equal((await createRun({ tickMs: 0 })(bot, {}, { signal: signal() })).outcome, 'success');
  assert.equal(bot.releases(), 1);
});

function voxelBot({ iron = { x: 8, y: 58, z: 0 }, clockStep = 100, override = () => null } = {}) {
  const removed = new Set(), attempts = new Map(), actions = [];
  let clock = 0, releases = 0, rawIron = 0;
  const entity = { position: { x: 0.5, y: 64, z: 0.5 }, yaw: -Math.PI / 2, pitch: 0, onGround: true };
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const material = (p) => {
    const cell = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    return removed.has(key(cell)) ? 'air' : override(cell) ?? (key(cell) === key(iron) ? 'iron_ore' : cell.y < 64 ? 'stone' : 'air');
  };
  const raw = { entity, game: { dimension: 'overworld' }, blockAt(p) {
    const name = material({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    return { name, boundingBox: ['air', 'water', 'lava'].includes(name) ? 'empty' : 'block' };
  } };
  const arbiter = new ActionArbiter({ now: () => clock });
  const bot = { actions, removed, material, now: () => clock, releases: () => releases, moveTo: (position) => { entity.position = position; },
    observe() {
      const p = entity.position, near = ore('iron_ore', iron.x - p.x, iron.y - p.y, iron.z - p.z);
      return { self: { position: { ...p }, yaw: entity.yaw, pitch: entity.pitch, on_ground: entity.onGround,
        health: 20, hunger: 20, held_item: 'stone_pickaxe', hotbar_slot: 0 }, inventory: { stone_pickaxe: 1, raw_iron: rawIron },
      facts: { position: { ...p }, nearest_blocks: !removed.has(key(iron)) && near.distance <= 16 ? { iron_ore: near } : {} },
      terrain: buildTerrainObservation(raw) };
    },
    requestAction(action) {
      clock += clockStep;
      arbiter.set('skill', action, 'evaluation');
      const applied = arbiter.tick({ health: 20, terrain: bot.observe().terrain });
      actions.push({ requested: action, applied: applied.action, source: applied.source, position: { ...entity.position } });
      const a = applied.action, p = entity.position;
      entity.yaw += a.yaw_delta; entity.pitch += a.pitch_delta;
      if (a.dig) {
        assert.ok(!(a.dig.x === Math.floor(p.x) && a.dig.z === Math.floor(p.z) && a.dig.y < p.y), 'never dig the support under the bot');
        const count = (attempts.get(key(a.dig)) ?? 0) + 1;
        attempts.set(key(a.dig), count);
        if (count >= 3) removed.add(key(a.dig));
      }
      if (a.forward) {
        const next = { x: p.x - Math.sin(entity.yaw) * 0.2, y: p.y, z: p.z - Math.cos(entity.yaw) * 0.2 };
        if (material(next) === 'air' && material({ ...next, y: next.y + 1 }) === 'air') {
          for (let depth = 0; depth < 10 && material({ ...next, y: next.y - 1 }) === 'air'; depth++) next.y--;
          entity.position = next;
        }
      }
      if (removed.has(key(iron)) && Math.hypot(entity.position.x - iron.x - 0.5, entity.position.y - iron.y, entity.position.z - iron.z - 0.5) < 0.3) rawIron = 1;
    },
    releaseControls() { releases++; arbiter.release(); },
  };
  return bot;
}

test('descent carves one-block stairs, reaches buried iron, enters the ore cell, and preserves a climbable return route', async () => {
  const bot = voxelBot();
  const result = await createDescentRun({ tickMs: 0, now: bot.now })(bot, {}, { signal: AbortSignal.timeout(15000) });
  assert.equal(result.outcome, 'success', result.reason);
  assert.equal(result.after.inventory.raw_iron, 1);
  assert.ok(result.navigation.route.length > 6);
  assert.ok(bot.actions.some((a) => a.requested.dig?.y === 63));
  assert.ok(bot.actions.filter((a) => a.requested.dig).every((a) => !a.requested.forward));
  const firstDig = bot.actions.find((a) => a.requested.dig).requested.dig;
  assert.ok(bot.actions.filter((a) => JSON.stringify(a.requested.dig) === JSON.stringify(firstDig)).length >= 3);
  const route = result.navigation.route;
  for (let i = 0; i < route.length; i++) {
    const cell = route[i];
    assert.equal(bot.material({ ...cell, y: cell.y - 1 }), 'stone', 'every return waypoint retains a floor');
    assert.equal(bot.material(cell), 'air');
    assert.equal(bot.material({ ...cell, y: cell.y + 1 }), 'air');
    if (i) {
      assert.equal(Math.abs(route[i - 1].x - cell.x) + Math.abs(route[i - 1].z - cell.z), 1);
      assert.ok([0, 1].includes(route[i - 1].y - cell.y), 'reverse route needs at most a one-block jump');
      if (route[i - 1].y > cell.y) assert.equal(bot.material({ ...cell, y: cell.y + 2 }), 'air', 'jump back has headroom');
    }
  }
  assert.equal(bot.releases(), 1);
});

test('descent searches before ore enters the 16-block scan and renews the actual arbiter lease beyond 120 seconds', async () => {
  const bot = voxelBot({ iron: { x: 22, y: 42, z: 0 }, clockStep: 1000 });
  assert.deepEqual(bot.observe().facts.nearest_blocks, {});
  const result = await createDescentRun({ tickMs: 0, now: bot.now })(bot, {}, { signal: AbortSignal.timeout(15000) });
  assert.equal(result.outcome, 'success', result.reason);
  assert.ok(result.elapsed_ms > 120000);
  assert.ok(result.navigation.lease_renewals >= 1);
  assert.ok(bot.actions.every((a) => a.source === 'skill'));
  assert.equal(bot.releases(), result.navigation.lease_renewals + 1);
});

test('descent goes around ore below a future stair support instead of undermining the return path', async () => {
  const bot = voxelBot({ iron: { x: 1, y: 62, z: 0 } });
  const result = await createDescentRun({ tickMs: 0, now: bot.now })(bot, {}, { signal: AbortSignal.timeout(5000) });
  assert.equal(result.outcome, 'success', result.reason);
  assert.ok(result.navigation.route.some((p) => p.z !== 0));
  assert.ok(!result.navigation.route.some((p) => p.x === 1 && p.y === 63 && p.z === 0));
});

test('descent stops for lava, an open floor, and an unexpected cave fall, releasing controls', async () => {
  for (const [override, expected] of [
    [(p) => p.x === 1 && p.y === 63 && p.z === 0 ? 'lava' : null, 'hazard:lava_or_fire'],
    [(p) => p.y === 63 && Math.abs(p.x) + Math.abs(p.z) === 1 ? 'air' : null, 'no_safe_stair_route'],
    [(p) => p.x === 1 && p.z === 0 && p.y <= 62 && p.y >= 58 ? 'air' : null, 'unexpected_drop'],
  ]) {
    const bot = voxelBot({ iron: { x: 22, y: 42, z: 0 }, override });
    const result = await createDescentRun({ tickMs: 0, now: bot.now })(bot, {}, { signal: AbortSignal.timeout(5000) }).catch((error) => {
      assert.fail(`${expected}: ${error.message}; last actions ${JSON.stringify(bot.actions.slice(-5))}`);
    });
    assert.equal(result.reason, expected);
    assert.equal(bot.releases(), 1);
  }
});

test('descent rejects an open edge and tries another stair direction', async () => {
  const bot = voxelBot({ iron: { x: 22, y: 42, z: 0 }, override: (p) => p.x === 1 && p.y === 63 && p.z === 0 ? 'air' : null });
  const result = await createDescentRun({ tickMs: 0, now: bot.now })(bot, {}, { signal: AbortSignal.timeout(5000) });
  assert.equal(result.outcome, 'success', result.reason);
  assert.equal(result.navigation.rejected_steps[0].reason, 'unsafe_descent_open_floor');
  assert.ok(!result.navigation.route.some((p) => p.x === 1 && p.y === 63 && p.z === 0));
});

test('descent bounds a blocked dig and abort always releases controls', async () => {
  const bot = voxelBot();
  const request = bot.requestAction;
  bot.requestAction = (action) => request({ ...action, dig: undefined });
  const result = await createDescentRun({ tickMs: 0, now: bot.now, phaseLimitMs: 1000 })(bot, {}, { signal: AbortSignal.timeout(5000) });
  assert.match(result.reason, /^descent_stuck:/);
  assert.equal(bot.releases(), 1);
  const aborted = voxelBot();
  await assert.rejects(createDescentRun()(aborted, {}, { signal: AbortSignal.abort(new Error('stopped')) }), /stopped/);
  assert.equal(aborted.releases(), 1);
  const controller = new AbortController(), duringDig = voxelBot();
  const act = duringDig.requestAction;
  duringDig.requestAction = (action) => { act(action); if (action.dig) controller.abort(new Error('stopped')); };
  await assert.rejects(createDescentRun({ tickMs: 0, now: duringDig.now })(duringDig, {}, { signal: controller.signal }), /stopped|aborted/);
  assert.equal(duringDig.releases(), 1);
});

test('descent refuses a floor dig if knockback moves the bot over its target', async () => {
  const bot = voxelBot(), observe = bot.observe;
  let moved = false;
  bot.observe = () => {
    if (!moved && bot.actions.at(-1)?.requested.dig?.y === 63) {
      moved = true;
      bot.moveTo({ x: 1.5, y: 64, z: 0.5 });
    }
    return observe();
  };
  const result = await createDescentRun({ tickMs: 0, now: bot.now })(bot, {}, { signal: AbortSignal.timeout(5000) });
  assert.equal(result.reason, 'position_changed_during_dig');
  assert.equal(bot.releases(), 1);
});

test('SkillRegistry loads the seven-field manifest with standalone resets and no evaluation claim', () => {
  const skill = new SkillRegistry().load('resource.mine_iron_ore', 1);
  assert.equal(skill.name, 'resource.mine_iron_ore');
  assert.equal(skill.version, 1);
  assert.equal(Object.keys(skill).length, 7);
  assert.equal(skill.evaluation, null);
  assert.deepEqual(skill.success_check.condition, { path: 'inventory.raw_iron', increase_by: 1 });
  for (const step of skill.reset_steps) assert.ok(step.command && step.verify);
  assert.ok(skill.reset_steps.some((step) => step.command.includes('3 64 0 minecraft:iron_ore')));
});

test('chooses the nearer ore type and keeps the selected pickaxe hotbar slot', async () => {
  for (const [normal, deep, expected] of [[2, 3, 2], [3, 2, 2]]) {
    const bot = fakeBot(state({ iron_ore: ore('iron_ore', normal), deepslate_iron_ore: ore('deepslate_iron_ore', deep, -1) }), (o) => ({ ...o, inventory: { raw_iron: 1 } }));
    assert.equal((await createRun({ tickMs: 0 })(bot, {}, { signal: signal() })).outcome, 'success');
    assert.equal(bot.actions[0].dig.x, expected);
    assert.equal(bot.actions[0].dig.y, normal < deep ? 64 : 63);
    assert.equal(bot.actions[0].hotbar, 2);
    assert.equal(bot.releases(), 1);
  }
});

test('no suitable pickaxe fails before requesting any action, including wooden and gold picks', async () => {
  for (const held of [null, 'wooden_pickaxe', 'golden_pickaxe']) {
    const initial = state(); initial.self.held_item = held; initial.inventory = held ? { [held]: 1 } : {};
    const bot = fakeBot(initial);
    assert.equal((await createRun()(bot, {}, { signal: signal() })).reason, 'requirement_unmet:no_pickaxe');
    assert.equal(bot.actions.length, 0);
    assert.equal(bot.releases(), 1);
  }
});

test('repeats the same dig while holding still until the block breaks', async () => {
  const bot = fakeBot(state(), (o) => bot.actions.length < 4 ? o : { ...o, inventory: { raw_iron: 1 } });
  await createRun({ tickMs: 0 })(bot, {}, { signal: signal() });
  assert.equal(bot.actions.length, 4);
  for (const action of bot.actions) {
    assert.deepEqual(action.dig, { x: 3, y: 64, z: 0 });
    assert.equal(action.forward, false);
  }
  assert.equal(bot.releases(), 1);
});

test('walks fully into the mined cell to collect the drop', async () => {
  const aligned = (blocks, x) => {
    const o = state(blocks, x);
    o.self.position.z = 0.5;
    o.facts.position.z = 0.5;
    return o;
  };
  const initial = aligned({ iron_ore: ore('iron_ore', 3, 0, -0.5) }, 0);
  const bot = fakeBot(initial, (o, action) => {
    if (action.dig) return aligned({}, 2.7);
    assert.equal(action.forward, true, 'must keep walking when only 0.8 blocks from cell center');
    return { ...aligned({}, 3.5), inventory: { raw_iron: 1 } };
  });
  const result = await createRun({ tickMs: 0 })(bot, {}, { signal: signal() });
  assert.equal(result.outcome, 'success');
  assert.equal(bot.actions.length, 2);
  assert.equal(bot.actions[1].dig, undefined);
  assert.equal(bot.releases(), 1);
});

test('no ore and missing facts fail without moving and release controls', async () => {
  for (const [initial, reason] of [[state({}), 'no_ore_in_range'], [{ ...state(), facts: null }, 'requirement_unmet:no_block_facts']]) {
    const bot = fakeBot(initial);
    assert.equal((await createRun()(bot, {}, { signal: signal() })).reason, reason);
    assert.equal(bot.actions.length, 0);
    assert.equal(bot.releases(), 1);
  }
});

test('releases controls on death, action errors, observation errors, and abort', async () => {
  const dead = state(); dead.self.health = 0;
  const death = fakeBot(dead);
  assert.equal((await createRun()(death, {}, { signal: signal() })).reason, 'bot_death');
  assert.equal(death.releases(), 1);
  for (const kind of ['action', 'observe', 'abort', 'already_aborted']) {
    const controller = new AbortController();
    const bot = fakeBot(state(), () => { controller.abort(new Error('stopped')); return state(); });
    if (kind === 'action') bot.requestAction = () => { throw new Error('action failed'); };
    if (kind === 'observe') bot.observe = () => { throw new Error('observe failed'); };
    if (kind === 'already_aborted') controller.abort(new Error('stopped'));
    await assert.rejects(createRun({ tickMs: 0 })(bot, {}, { signal: controller.signal }));
    assert.equal(bot.releases(), 1, kind);
  }
});

const testEnv = { A37_MC_HOST: '127.0.0.1', A37_MC_PORT: '25565', A37_MC_VERSION: '1.21.1',
  A37_EVAL_USERNAME: 'ReplayBot', A37_RCON_HOST: '127.0.0.1', A37_RCON_PORT: '25575',
  A37_EVAL_WEB_PORT: '8742', A37_EVAL_APPROVED_RESET: '1', A37_RCON_PASSWORD: 'synthetic-test-value' };

function surfaceFixture({ completeEvent = true, failTeleport = false, failTickAfter = false, seed = '424242' } = {}) {
  const base = fileURLToPath(new URL('../../../work/iron-unit/', import.meta.url));
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'a37-iron-fake-'));
  const bot = new EventEmitter(), ws = new EventEmitter(), arbiter = new ActionArbiter();
  ws.clients = new Set();
  let position = { x: 0, y: 64, z: 0 }, inventory = {}, held = null, block = null, mined = false, ticks = 0, closed = false;
  const commands = [], lines = [], settings = [];
  bot.game = { gameMode: 'creative' };
  bot.inventory = { items: () => Object.entries(inventory).map(([name, count]) => ({ name, count })) };
  bot.clearControlStates = () => {};
  bot.deactivateItem = () => {};
  bot.quit = () => bot.emit('end');
  const runtime = { bot, ws, arbiter, recorder: { stop() {} },
    close() { closed = true; bot.quit(); },
    state: () => ({ spawned: true, observation: { self: { position: { ...position }, health: 20, hunger: 20,
      yaw: -Math.PI / 2, pitch: 0, on_ground: true, held_item: held, hotbar_slot: 0 }, terrain: { hazards: {}, support_center: 1 }, hostiles: [] } }),
    facts: () => ({ position: { ...position }, dimension: 'overworld', nearest_blocks: block && !mined ? { iron_ore: ore('iron_ore', block.x - position.x, block.y - position.y, block.z - position.z) } : {} }),
  };
  const set = arbiter.set.bind(arbiter);
  arbiter.set = (source, action, reason) => {
    set(source, action, reason);
    if (action.dig && !mined) {
      mined = true;
      if (completeEvent) bot.emit('diggingCompleted', { name: 'air', position: { ...block } });
    } else if (action.forward && mined) {
      position = { x: block.x + 0.5, y: block.y, z: block.z + 0.5 };
      inventory.raw_iron = 1;
    }
  };
  const options = { trials: 1, env: testEnv, resultsDirectory: directory, synthetic: true,
    writeLine: (line) => lines.push(line), skillRunner: createRun({ tickMs: 0 }),
    runtimeFactory: async (config) => { settings.push(config); return runtime; },
    command: async (_config, text) => {
      commands.push(text);
      if (text === 'seed') return `Seed: [${seed}]`;
      if (text === 'tick query') {
        if (++ticks === 2 && failTickAfter) {
          const filename = fs.readdirSync(directory).find((name) => name.startsWith('surface-'));
          assert.equal(JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8')).trials.length, 1, 'trial must be saved before a health query can fail');
          throw new Error('rcon_timeout');
        }
        return 'Target tick rate: 20.0 per second. Average time per tick: 0.3ms';
      }
      const parts = text.split(' ');
      if (parts[0] === 'tp') {
        if (failTeleport) throw new Error('rcon_timeout');
        position = { x: Number(parts[2]), y: Number(parts[3]), z: Number(parts[4]) };
      }
      if (parts[0] === 'spreadplayers') position = { x: Number(parts[1]) + 0.5, y: 64, z: Number(parts[2]) + 0.5 };
      if (parts[0] === 'gamemode') bot.game.gameMode = parts[1];
      if (parts[0] === 'clear') { inventory = {}; held = null; }
      if (parts[0] === 'item') { inventory.stone_pickaxe = 1; held = 'stone_pickaxe'; }
      if (parts[0] === 'setblock') { block = { x: Number(parts[1]), y: Number(parts[2]), z: Number(parts[3]) }; mined = false; }
      return 'OK';
    },
  };
  return { directory, runtime, options, commands, lines, settings, closed: () => closed };
}

test('live CLI refuses non-loopback hosts and wrong bot settings before any connection', () => {
  const args = ['--milestone', 'surface', '--trials', '5'];
  assert.deepEqual(parseOptions(args, testEnv), { milestone: 'surface', trials: 5 });
  for (const name of ['A37_MC_HOST', 'A37_RCON_HOST']) assert.throws(() => parseOptions(args, { ...testEnv, [name]: 'example.invalid' }), /must_be_loopback/);
  assert.throws(() => parseOptions(args, { ...testEnv, A37_EVAL_USERNAME: 'OtherBot' }), /must_match_iron_packet/);
  assert.throws(() => parseOptions(args, { ...testEnv, A37_EVAL_APPROVED_RESET: '0' }), /approved_reset_required/);
  assert.deepEqual(parseOptions(['--milestone', 'real', '--trials', '3'], testEnv), { milestone: 'real', trials: 3 });
});

test('surface runner uses survival staging, recognizes Mineflayer air completion, and closes its fake bot', async () => {
  const f = surfaceFixture();
  const { report, output, exitCode } = await evaluateIron(f.options);
  assert.equal(exitCode, 0);
  assert.equal(report.synthetic, true);
  assert.equal(report.summary.successes, 1);
  assert.equal(report.summary.raw_iron_collected, 1);
  assert.equal(report.trials[0].broken[0].type, 'iron_ore');
  assert.equal(report.trials[0].broken[0].completed_as, 'air');
  assert.equal(report.trials[0].reset_observation.game_mode, 'survival');
  assert.equal(report.trials[0].synthetic, true);
  assert.ok(report.cleanup.bot_end_observed);
  assert.ok(f.closed());
  assert.equal(f.settings[0].viewerPort, 3742);
  const firstBlockCommand = f.commands.findIndex((text) => /^(fill|setblock) /.test(text));
  assert.ok(firstBlockCommand > f.commands.findIndex((text) => text.startsWith('tp ReplayBot ')));
  assert.ok(f.commands.indexOf('gamemode survival ReplayBot') < firstBlockCommand);
  assert.ok(f.commands.includes('effect clear ReplayBot minecraft:slow_falling'));
  assert.ok(!f.commands.some((text) => /^give /.test(text) || /@/.test(text)));
  assert.equal(f.lines.filter((line) => /^PASS surface trial=/.test(line)).length, 1);
  assert.match(f.lines.at(-1), /^SUMMARY PASS/);
  const persisted = fs.readFileSync(output, 'utf8');
  assert.ok(!persisted.includes(testEnv.A37_RCON_PASSWORD));
  assert.equal(JSON.parse(persisted).summary.status, 'PASS');
  const second = surfaceFixture();
  const rerun = await evaluateIron({ ...second.options, resultsDirectory: f.directory });
  assert.notEqual(rerun.report.sites[0].slot, report.sites[0].slot, 'every run reserves a fresh pad');
});

test('surface runner refuses inventory success without a matching bot ore-break event', async () => {
  const f = surfaceFixture({ completeEvent: false });
  const { report, exitCode } = await evaluateIron(f.options);
  assert.equal(exitCode, 1);
  assert.equal(report.trials[0].raw_iron_collected, 1);
  assert.equal(report.trials[0].reason, 'no_bot_ore_break_evidence');
  assert.match(f.lines[0], /^FAIL surface trial=1/);
  assert.ok(f.closed());
});

test('surface runner saves RCON reset failures, stops later trials, and releases the bot', async () => {
  const f = surfaceFixture({ failTeleport: true });
  const { report, output, exitCode } = await evaluateIron({ ...f.options, trials: 2 });
  assert.equal(exitCode, 1);
  assert.equal(report.trials[0].reason, 'rcon_timeout');
  assert.equal(report.trials[1].reason, 'not_run:rcon_timeout');
  assert.equal(report.trials[0].commands.find((entry) => entry.error)?.command.split(' ')[0], 'tp');
  assert.ok(!f.commands.some((text) => /^(fill|setblock) /.test(text)));
  assert.equal(f.lines.filter((line) => /^FAIL surface trial=/.test(line)).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).trials.length, 2);
  assert.ok(f.closed());
});

test('surface runner preserves a trial if its follow-up tick query times out', async () => {
  const f = surfaceFixture({ failTickAfter: true });
  const { report, exitCode } = await evaluateIron({ ...f.options, trials: 2 });
  assert.equal(exitCode, 1);
  assert.equal(report.trials[0].outcome, 'success');
  assert.equal(report.trials[0].tick_after_error, 'rcon_timeout');
  assert.equal(report.trials[1].reason, 'not_run:rcon_timeout');
  assert.match(f.lines.at(-1), /^SUMMARY FAIL/);
  assert.ok(f.closed());
});

test('wrong live seed records startup failures and the original default seed guard stays intact', async () => {
  const f = surfaceFixture({ seed: '37001' });
  const { report, exitCode } = await evaluateIron({ ...f.options, trials: 2 });
  assert.equal(exitCode, 1);
  assert.equal(report.trials.length, 2);
  assert.match(report.trials[0].reason, /approved world must use seed 424242/);
  assert.deepEqual(f.commands, ['seed']);
  assert.ok(f.closed());
  const defaultGuard = surfaceFixture();
  await assert.rejects(createLiveArena({ skill: new SkillRegistry().load('resource.mine_iron_ore', 1), env: testEnv,
    runtimeFactory: defaultGuard.options.runtimeFactory, command: defaultGuard.options.command }), /approved world must use seed 37001/);
  assert.ok(defaultGuard.closed());
});

test('real runner starts on natural surface, places nothing, mines underground iron through the adapter, and persists the route', async () => {
  const base = fileURLToPath(new URL('../../../work/iron-unit/', import.meta.url));
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'a37-real-fake-'));
  const model = voxelBot(), bot = new EventEmitter(), ws = new EventEmitter(), arbiter = new ActionArbiter();
  const commands = [], lines = [];
  let origin = { x: 0, z: 0 };
  const observe = () => {
    const o = model.observe();
    o.self.position.x += origin.x; o.self.position.z += origin.z;
    o.facts.position.x += origin.x; o.facts.position.z += origin.z;
    o.facts.dimension = 'overworld';
    return o;
  };
  bot.game = { gameMode: 'creative' };
  bot.inventory = { items: () => Object.entries(model.observe().inventory).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) };
  bot.clearControlStates = () => model.releaseControls();
  bot.deactivateItem = () => {};
  bot.quit = () => bot.emit('end');
  ws.clients = new Set();
  const runtime = { bot, ws, arbiter, recorder: { stop() {} }, state: () => ({ spawned: true, observation: observe() }),
    facts: () => observe().facts, close: () => bot.quit() };
  const set = arbiter.set.bind(arbiter);
  arbiter.set = (source, action, reason) => {
    set(source, action, reason);
    const before = new Set(model.removed);
    model.requestAction({ ...action, ...(action.dig ? { dig: { x: action.dig.x - origin.x, y: action.dig.y, z: action.dig.z - origin.z } } : {}) });
    for (const key of model.removed) {
      if (before.has(key)) continue;
      const [x, y, z] = key.split(',').map(Number);
      bot.emit('diggingCompleted', { name: 'air', position: { x: x + origin.x, y, z: z + origin.z } });
    }
  };
  const { report, output, exitCode } = await evaluateIron({ milestone: 'real', trials: 1, env: testEnv,
    resultsDirectory: directory, synthetic: true, runtimeFactory: async () => runtime,
    skillRunner: createDescentRun({ tickMs: 0, now: model.now }), writeLine: (line) => lines.push(line),
    command: async (_config, text) => {
      commands.push(text);
      if (text === 'seed') return 'Seed: [424242]';
      if (text.startsWith('spreadplayers')) {
        const parts = text.split(' ');
        origin = { x: Number(parts[1]), z: Number(parts[2]) };
        return `Spread 1 player(s) around ${parts[1]}.5, ${parts[2]}.5 with an average distance of 0.00 blocks apart`;
      }
      if (text.startsWith('gamemode survival')) bot.game.gameMode = 'survival';
      return 'OK';
    } });
  assert.equal(exitCode, 0, JSON.stringify(report.summary));
  assert.equal(report.milestone, 'real');
  assert.equal(report.limits.total_trial_cap_ms, 600000);
  assert.ok(report.limits.execution_ms + report.limits.reset_ms + report.limits.rcon_command_ms * 2 < 600000);
  assert.equal(report.trials[0].raw_iron_collected, 1);
  assert.ok(report.trials[0].broken.some((b) => b.type === 'stone'));
  assert.ok(report.trials[0].broken.some((b) => b.type === 'iron_ore'));
  assert.ok(report.trials[0].navigation.route.some((p) => p.y < 64));
  assert.ok(commands.some((text) => text.startsWith('spreadplayers ')));
  assert.ok(!commands.some((text) => /^(fill|setblock|give|forceload) /.test(text)));
  assert.ok(report.cleanup.bot_end_observed);
  assert.match(lines[0], /^PASS real trial=1/);
  assert.match(lines.at(-1), /^SUMMARY PASS milestone=real/);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).summary.status, 'PASS');
});
