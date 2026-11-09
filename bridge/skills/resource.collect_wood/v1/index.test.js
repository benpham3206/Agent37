import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, countLogs } from './index.js';
import { SkillRegistry } from '../../registry.js';
import { ActionArbiter } from '../../../arbiter.js';
import { EventEmitter } from 'node:events';
import { main, parseOptions } from '../../../e2e/wood.e2e.mjs';

process.env.A37_EVAL_SEED = '424242';

function fixture({ blocks = [], inventory = {}, onAction = () => {}, stepMs = 100, terrain = null } = {}) {
  let time = 0, releases = 0, digs = 0, dropped = null;
  const p = { x: 0.5, y: 64, z: 0.5 }, actions = [];
  let yaw = -Math.PI / 2, pitch = 0;
  const arbiter = new ActionArbiter({ now: () => time });
  const bot = {
    observe() {
      const nearest = {};
      for (const b of blocks) {
        const distance = Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z);
        if (distance <= 16 && (!nearest[b.type] || distance < nearest[b.type].distance)) {
          nearest[b.type] = { type: b.type, distance, dx: b.x - p.x, dy: b.y - p.y, dz: b.z - p.z };
        }
      }
      return { self: { position: { ...p }, health: 20, yaw, pitch }, inventory: { ...inventory },
        facts: { position: { ...p }, nearest_blocks: nearest }, terrain };
    },
    requestAction(a) {
      actions.push({ ...a, at: time });
      arbiter.set('skill', a);
      arbiter.tick();
      yaw += a.yaw_delta ?? 0; pitch += a.pitch_delta ?? 0;
      if (a.forward) { p.x -= Math.sin(yaw) * 0.35; p.z -= Math.cos(yaw) * 0.35; }
      if (a.dig && ++digs >= 5) {
        const index = blocks.findIndex((b) => b.x === a.dig.x && b.y === a.dig.y && b.z === a.dig.z);
        if (index >= 0) { dropped = blocks.splice(index, 1)[0]; digs = 0; }
      }
      if (dropped && Math.hypot(p.x - dropped.x - 0.5, p.z - dropped.z - 0.5) < 1.3) {
        inventory[dropped.type] = (inventory[dropped.type] ?? 0) + 1; dropped = null;
      }
      onAction(a, { p, inventory, blocks, actions, arbiter });
      time += stepMs;
    },
    releaseControls() { releases++; arbiter.release(); },
  };
  return { bot, actions, now: () => time, releases: () => releases, arbiter };
}
const execute = (f, input = { count: 5 }, settings = {}, signal = AbortSignal.timeout(3000)) =>
  createRun({ tickMs: 0, now: f.now, ...settings })(f.bot, input, { signal });

test('SkillRegistry loads the seven fields, goal count, null evaluation and standalone flat resets', () => {
  const skill = new SkillRegistry().load('resource.collect_wood', 1);
  assert.equal(Object.keys(skill).length, 7);
  assert.deepEqual(skill.requirements.input, { count: 5 });
  assert.equal(skill.success_check.time_limit_ms, 180000);
  assert.equal(skill.evaluation, null);
  assert.ok(skill.reset_steps.some((s) => s.command.includes('63')));
  assert.ok(skill.reset_steps.some((s) => s.command.includes('64')));
  assert.ok(skill.reset_steps.every((s) => s.command && s.verify));
});

test('collects any reported log type and walks to each broken block for pickup', async () => {
  for (const type of ['birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'oak_log']) {
    const f = fixture({ blocks: [{ type, x: 4, y: 64, z: 0 }] });
    const result = await execute(f, { count: 1 });
    assert.equal(result.outcome, 'success', type);
    assert.equal(result.after.inventory[type], 1);
    const firstDig = f.actions.findIndex((a) => a.dig);
    assert.ok(f.actions.slice(firstDig + 5).some((a) => a.forward), 'moves toward the drop after breaking the log');
    assert.equal(f.releases(), 1);
    assert.equal(f.arbiter.tick().source, 'idle');
  }
});

test('the count is a total across log types and does not count planks', async () => {
  assert.equal(countLogs({ oak_log: 2, birch_log: 2, oak_planks: 64 }), 4);
  const f = fixture({ inventory: { oak_log: 2, birch_log: 2, oak_planks: 64 }, blocks: [{ type: 'spruce_log', x: 3, y: 64, z: 0 }] });
  const result = await execute(f);
  assert.equal(result.outcome, 'success');
  assert.equal(countLogs(result.after.inventory), 5);
  const complete = fixture({ inventory: { cherry_log: 6 } });
  assert.equal((await execute(complete)).outcome, 'success');
  assert.equal(complete.actions.length, 0);
  assert.equal(complete.releases(), 1);
});

test('explores when no logs are visible and finishes with an explicit timeout', async () => {
  const f = fixture();
  const result = await execute(f, {}, { timeLimitMs: 2500 });
  assert.equal(result.reason, 'explore_timeout');
  assert.ok(f.actions.some((a) => a.forward));
  assert.ok(f.actions.every((a) => !a.dig));
  assert.equal(f.releases(), 1);
});

test('turns at a gated drop, water, wall and a motionless obstacle', async () => {
  for (const terrain of [
    { support_grid: [[{}, {}, {}], [{}, {}, {}], [{}, { available: true, drop_depth: 5 }, {}]] },
    { support_grid: [[{}, {}, {}], [{}, {}, {}], [{}, { available: true, drop_depth: 0, support: 'air' }, {}]] },
    { clearance: { forward: { body: 'water', body_clear: true, head_clear: true } } },
    { clearance: { forward: { body_clear: false, head_clear: false } } },
  ]) {
    const f = fixture({ terrain });
    const result = await execute(f, {}, { timeLimitMs: 3000 });
    assert.equal(result.outcome, 'timeout');
    assert.ok(f.actions.some((a) => Math.abs(a.yaw_delta ?? 0) > 0));
    assert.ok(f.actions.every((a) => !a.forward));
    assert.equal(f.releases(), 1);
  }
  const f = fixture({ stepMs: 1000, onAction(_a, { p }) { p.x = 0.5; p.z = 0.5; } });
  assert.equal((await execute(f, {}, { timeLimitMs: 50000 })).reason, 'stuck');
  assert.ok(f.actions.some((a) => Math.abs(a.yaw_delta ?? 0) > 0));
});

test('jumps up a one-block step and never digs beyond eye reach', async () => {
  const f = fixture({ blocks: [{ type: 'oak_log', x: 9, y: 64, z: 0 }],
    terrain: { clearance: { forward: { body_clear: false, head_clear: true } } },
    onAction(a, { p }) {
      if (a.dig) assert.ok(Math.hypot(a.dig.x + 0.5 - p.x, a.dig.y + 0.5 - p.y - 1.62, a.dig.z + 0.5 - p.z) <= 4.5);
    } });
  assert.equal((await execute(f, { count: 1 })).outcome, 'success');
  assert.ok(f.actions.some((a) => a.forward && a.jump));
});

test('renews automated control before 120 seconds and keeps requesting afterward', async () => {
  const f = fixture({ stepMs: 10000, onAction(_a, { p, arbiter }) { p.x += 2; assert.equal(arbiter.tick().source, 'skill'); } });
  assert.equal((await execute(f)).reason, 'explore_timeout');
  assert.ok(f.releases() >= 2);
  assert.ok(f.actions.some((a) => a.at >= 130000));
  assert.equal(f.arbiter.tick().source, 'idle');
});

test('missing observations, invalid input, death, exceptions and abort all release controls', async () => {
  const missing = fixture(); missing.bot.observe = () => ({ inventory: {}, self: {} });
  assert.equal((await execute(missing)).reason, 'requirement_unmet:observations');
  assert.equal(missing.releases(), 1);
  const invalid = fixture();
  assert.equal((await execute(invalid, { count: 0 })).reason, 'requirement_unmet:count');
  assert.equal(invalid.releases(), 1);
  const dead = fixture(); const observe = dead.bot.observe;
  dead.bot.observe = () => ({ ...observe(), self: { ...observe().self, health: 0 } });
  assert.equal((await execute(dead)).reason, 'bot_death');
  assert.equal(dead.releases(), 1);
  const throws = fixture(); throws.bot.observe = () => { throw new Error('observation failed'); };
  await assert.rejects(execute(throws), /observation failed/);
  assert.equal(throws.releases(), 1);
  const actionThrows = fixture(); actionThrows.bot.requestAction = () => { throw new Error('action failed'); };
  await assert.rejects(execute(actionThrows), /action failed/);
  assert.equal(actionThrows.releases(), 1);
  for (const during of [false, true]) {
    const controller = new AbortController();
    const f = fixture({ onAction() { if (during) controller.abort(new Error('stopped')); } });
    if (!during) controller.abort(new Error('stopped'));
    await assert.rejects(execute(f, {}, {}, controller.signal), (error) => error.message === 'stopped' || error.cause?.message === 'stopped');
    assert.equal(f.releases(), 1);
  }
});

test('selects the lowest reported reachable log and returns to approach after displacement', async () => {
  let displaced = false;
  const f = fixture({ blocks: [{ type: 'birch_log', x: 4, y: 66, z: 0 }, { type: 'oak_log', x: 4, y: 64, z: 0 }],
    onAction(a, { p }) {
      if (a.dig && !displaced) { p.x = -5; displaced = true; }
    } });
  assert.equal((await execute(f, { count: 1 })).outcome, 'success');
  assert.equal(f.actions.find((a) => a.dig).dig.y, 64);
  const firstDig = f.actions.findIndex((a) => a.dig);
  assert.ok(f.actions.slice(firstDig + 1).some((a) => a.forward && !a.dig));
});

const liveEnv = () => ({ A37_MC_HOST: '127.0.0.1', A37_MC_PORT: '25565', A37_MC_VERSION: '1.21.1',
  A37_EVAL_USERNAME: 'SparPartner', A37_RCON_HOST: '127.0.0.1', A37_RCON_PORT: '25575',
  A37_EVAL_APPROVED_RESET: '1', A37_EVAL_WEB_PORT: '8743', A37_RCON_PASSWORD: 'fake-test-password', AGENT37_JEV: '0' });

function runnerFixture(mode = 'success') {
  const files = new Map(), logs = [], commands = [], commandOptions = [];
  const bot = new EventEmitter();
  const p = { x: 9000.5, y: 64, z: 5000.5 };
  let count = 0, digs = 0, closed = 0, yaw = -Math.PI / 2, pitch = 0;
  bot.entity = { position: p, onGround: true };
  bot.health = 20; bot.game = { gameMode: 'survival' };
  bot._client = { state: 'play', end() { bot._client.state = 'disconnected'; bot.emit('end'); } };
  bot.inventory = { items: () => count ? [{ name: 'birch_log', count }] : [] };
  bot.blockAt = (pos) => ({ name: pos.y < 64 ? 'grass_block' : 'air', boundingBox: pos.y < 64 ? 'block' : 'empty' });
  bot.clearControlStates = () => {}; bot.deactivateItem = () => {};
  const arbiter = new ActionArbiter(), ws = new EventEmitter(); ws.clients = new Set();
  const runtime = { bot, arbiter, ws, recorder: { stop() {} }, close() { closed++; bot._client.end(); },
    state() {
      const a = arbiter.tick().action;
      yaw += a.yaw_delta ?? 0; pitch += a.pitch_delta ?? 0;
      if (a.forward) { p.x -= Math.sin(yaw) * 0.2; p.z -= Math.cos(yaw) * 0.2; }
      if (a.dig && ++digs > 5) {
        if (mode === 'death') { bot.health = 0; bot.emit('death'); } else count = 1;
      }
      return { spawned: true, observation: { self: { position: { ...p }, health: bot.health, yaw, pitch }, terrain: null }, arbiter: arbiter.tick() };
    },
    facts: () => ({ position: { ...p }, nearest_blocks: count ? {} : { birch_log: { type: 'birch_log', dx: 2, dy: 0, dz: 0, distance: 2 } }, nearby_mobs: [] }),
  };
  return { files, logs, commands, commandOptions, closed: () => closed,
    services: { env: liveEnv(), resultsDir: 'D:/fake-wood-results', log: (line) => logs.push(line), wait: async () => {},
      files: { mkdirSync() {}, readdirSync: () => [...files.keys()].map((name) => name.split(/[\\/]/).at(-1)),
        readFileSync: (name) => files.get(name), writeFileSync: (name, body) => files.set(name, body) },
      makeRuntime: async (config) => { assert.equal(config.viewerPort, 3743); return runtime; },
      sendCommand: async (config, text) => {
        commands.push(text);
        commandOptions.push({ command: text, timeoutMs: config.timeoutMs });
        if (text === 'seed') return mode === 'wrong-seed' ? 'Seed: [123]' : 'Seed: [424242]';
        if (text === 'tick query') { if (mode === 'server-down') throw new Error('rcon_unreachable'); return 'The game is running normally at 20.0 ticks per second.'; }
        if (text.startsWith('clear ')) count = 0;
        if (mode === 'vanilla-spread' && text.startsWith('gamemode ')) return '';
        if (text.startsWith('spreadplayers ')) {
          if (mode === 'bad-spread') return 'Could not spread players';
          if (mode !== 'unmoved-spread') {
            const parts = text.split(' '); p.x = Number(parts[1]) + 0.5; p.z = Number(parts[2]) + 0.5;
          }
          if (mode === 'vanilla-spread' || mode === 'unmoved-spread') {
            return 'Spread 1 player(s) around 8730.5, 4730.5 with an average distance of 0.00 blocks apart';
          }
          return 'Successfully spread 1 entities';
        }
        return 'OK';
      },
    },
  };
}

test('live CLI validates loopback, bot, approval, ports, Jev and the near milestone before connecting', () => {
  const args = ['--milestone', 'near', '--trials', '5'];
  assert.equal(parseOptions(args, liveEnv()).count, 1);
  assert.throws(() => parseOptions(['--milestone', 'fresh', '--trials', '1'], liveEnv()), /fresh_deferred/);
  for (const change of [{ A37_MC_HOST: 'invalid' }, { A37_RCON_HOST: 'invalid' }, { A37_EVAL_USERNAME: 'OtherBot' },
    { A37_EVAL_APPROVED_RESET: '0' }, { A37_MC_PORT: '1' }, { A37_EVAL_WEB_PORT: '1' }, { AGENT37_JEV: '1' }]) {
    assert.throws(() => parseOptions(args, { ...liveEnv(), ...change }));
  }
  assert.throws(() => parseOptions(['--milestone', 'near', '--trials', '0'], liveEnv()));
});

test('near setup accepts the real vanilla spread reply and an empty already-survival reply', async () => {
  const f = runnerFixture('vanilla-spread');
  const report = await main(['--milestone', 'near', '--trials', '1'], f.services);
  assert.equal(report.passed, true, JSON.stringify(report.summary));
  assert.equal(report.commands.find((row) => row.command.startsWith('spreadplayers ')).reply,
    'Spread 1 player(s) around 8730.5, 4730.5 with an average distance of 0.00 blocks apart');
  assert.equal(report.commands.find((row) => row.command.startsWith('gamemode ')).reply, '');
  assert.equal(report.setups[0].spread_position.x, 8730.5);
  assert.equal(report.setups[0].spread_position.z, 4730.5);
  assert.equal(report.cleanup.disconnected, true);
});

test('spread setup gives unloaded terrain at least fifteen seconds without changing other command deadlines', async () => {
  const f = runnerFixture('vanilla-spread');
  const report = await main(['--milestone', 'near', '--trials', '1'], f.services);
  assert.equal(report.passed, true);
  assert.ok(f.commandOptions.filter((row) => row.command.startsWith('spreadplayers ')).every((row) => row.timeoutMs >= 15000));
  assert.ok(f.commandOptions.filter((row) => !row.command.startsWith('spreadplayers ')).every((row) => row.timeoutMs === 3000));
});

test('a successful spread reply without observed relocation cannot start the skill', async () => {
  const f = runnerFixture('unmoved-spread');
  const report = await main(['--milestone', 'near', '--trials', '1'], f.services);
  assert.equal(report.passed, false);
  assert.equal(report.trials[0].reason, 'spreadplayers_position_unverified');
  assert.equal(report.trials[0].before, null);
  assert.deepEqual(report.trials[0].actions, []);
  assert.equal(report.cleanup.disconnected, true);
});

test('near runner passes from observed inventory, saves evidence, keeps starts apart and disconnects, with fake services only', async () => {
  const f = runnerFixture();
  const report = await main(['--milestone', 'near', '--trials', '2'], f.services);
  assert.equal(report.passed, true);
  assert.equal(report.synthetic, true);
  assert.equal(report.summary.successes, 2);
  assert.equal(report.cleanup.disconnected, true);
  assert.equal(f.closed(), 1);
  assert.ok(f.logs.some((line) => line.startsWith('PASS trial=1')));
  assert.ok(f.logs.at(-1).startsWith('SUMMARY PASS'));
  assert.equal(report.trials[0].logs_collected, 1);
  const [a, b] = report.trials.map((row) => row.start_position);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 150);
  assert.ok(f.commands.every((text) => !/give SparPartner.*log|setblock|fill|@/.test(text)));
  const saved = JSON.parse([...f.files.values()][0]);
  assert.equal(saved.summary.successes, 2);
  assert.ok(!JSON.stringify(saved).includes('fake-test-password'));
  assert.ok(!f.logs.join('\n').includes('fake-test-password'));
});

test('near runner records wrong seed, server loss, failed setup and death and always disconnects without live services', async () => {
  for (const [mode, reason] of [['wrong-seed', 'approved world must use seed'], ['server-down', 'rcon_unreachable'],
    ['bad-spread', 'spreadplayers_failed'], ['death', 'bot_death']]) {
    const f = runnerFixture(mode);
    const report = await main(['--milestone', 'near', '--trials', '1'], f.services);
    assert.equal(report.passed, false, mode);
    assert.equal(report.cleanup.disconnected, true, mode);
    assert.ok(f.closed() >= 1);
    assert.ok(f.logs.some((line) => line.includes(reason)), mode);
    assert.ok(f.logs.at(-1).startsWith('SUMMARY FAIL'), mode);
    assert.equal(JSON.parse([...f.files.values()][0]).passed, false);
    if (mode === 'server-down') assert.equal(f.commands.filter((text) => text.startsWith('spreadplayers')).length, 0);
  }
});
