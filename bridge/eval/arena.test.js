import test from 'node:test';
import assert from 'node:assert/strict';
import { createCiArena, createLiveArena, checkCondition } from './arena.mjs';
import { EventEmitter } from 'node:events';
import { ActionArbiter } from '../arbiter.js';

test('CI reset restores the same fixture without running world commands', async () => {
  const arena = createCiArena();
  const signal = new AbortController().signal;
  await arena.reset([{ command: 'never execute this in CI' }], { signal });
  const start = arena.observe();
  arena.bot(signal).requestAction({ forward: true });
  assert.equal(arena.arbiter.tick().source, 'skill');
  await arena.reset([], { signal });
  assert.deepEqual(arena.observe(), start);
  assert.equal(arena.arbiter.tick().source, 'idle');
  assert.equal(arena.synthetic, true);
  arena.close();
});
test('an aborted skill cannot request more controls', async () => {
  const arena = createCiArena();
  const controller = new AbortController();
  await arena.reset([], { signal: controller.signal });
  const bot = arena.bot(controller.signal);
  controller.abort();
  assert.throws(() => bot.requestAction({ attack: true }));
  assert.equal(arena.arbiter.tick().source, 'idle');
  arena.arbiter.set('skill', { forward: true }, 'next_trial');
  bot.releaseControls();
  assert.equal(arena.arbiter.tick().source, 'skill');
});
test('success checks require observations, not just a skill success label', () => {
  assert.equal(checkCondition({ path: 'inventory.oak_log', increase_by: 1 }, { inventory: { oak_log: 2 } }, { inventory: { oak_log: 3 } }), true);
  assert.equal(checkCondition({ path: 'inventory.oak_log', increase_by: 1 }, { inventory: { oak_log: 2 } }, { inventory: { oak_log: 2 } }), false);
  assert.equal(checkCondition({ path: 'inventory.oak_log', increase_by: 1 }, { inventory: {} }, { inventory: { oak_log: 1 } }), true);
  assert.equal(checkCondition({ path: 'inventory.oak_log', increase_by: 1 }, { inventory: null }, { inventory: { oak_log: 1 } }), false);
  assert.equal(checkCondition({ path: 'self.health', equals: 20 }, null, { self: { health: null } }), false);
  assert.equal(checkCondition({ path: 'missing', equals: true }, null, {}), false);
  assert.throws(() => checkCondition({ path: 'missing' }, null, {}));
  assert.throws(() => checkCondition({ path: '../unsafe', equals: true }, null, {}));
  assert.throws(() => checkCondition({ path: 'x', equals: true, increase_by: 1 }, null, {}));
});
test('live mode requires explicit approval and refuses test-only skills before connecting', async () => {
  await assert.rejects(createLiveArena({ skill: { requirements: { ci_only: true } }, env: {} }), /test-only/);
  await assert.rejects(createLiveArena({ skill: { requirements: {} }, env: {} }), /approval/);
  await assert.rejects(createLiveArena({ skill: { requirements: {} }, env: { A37_EVAL_APPROVED_RESET: '1' } }), /A37_MC_HOST/);
});

function liveFixture() {
  const bot = new EventEmitter();
  bot.inventory = { items: () => [{ name: 'oak_log', count: 2 }] };
  let released = 0, closed = false;
  bot.clearControlStates = () => { released++; };
  bot.deactivateItem = () => {};
  const runtime = {
    bot, arbiter: new ActionArbiter(), ws: new EventEmitter(),
    state: () => ({ spawned: true, observation: { self: { health: 20, position: { x: 0, y: 64, z: 0 } } } }),
    recorder: { stop() {} }, close() { closed = true; },
  };
  runtime.ws.clients = new Set();
  const commands = [];
  const options = {
    skill: { requirements: {} }, dataDir: '/unused-test-path',
    env: { A37_EVAL_APPROVED_RESET: '1', A37_MC_HOST: 'example.invalid', A37_MC_PORT: '25565',
      A37_MC_VERSION: '1.21.1', A37_EVAL_USERNAME: 'EvalTest', A37_RCON_HOST: 'example.invalid',
      A37_RCON_PORT: '25575', A37_RCON_PASSWORD: 'test-only-not-a-secret' },
    runtimeFactory: async () => runtime,
    command: async (_config, text) => { commands.push(text); return text === 'seed' ? 'Seed: [37001]' : ''; },
  };
  return { options, runtime, commands, released: () => released, closed: () => closed };
}

test('live adapter checks seed, verifies resets, routes controls and observes takeovers without a server', async () => {
  const fixture = liveFixture();
  const arena = await createLiveArena(fixture.options);
  const signal = new AbortController().signal;
  assert.deepEqual(fixture.commands, ['seed']);
  assert.equal(arena.synthetic, false);
  assert.equal(arena.observe().inventory.oak_log, 2);
  await arena.reset([{ command: 'tp {username} 0 64 0', verify: {
    path: 'self.position', equals: { x: 0, y: 64, z: 0 },
  } }], { signal });
  assert.equal(fixture.commands[1], 'tp EvalTest 0 64 0');
  arena.bot(signal).requestAction({ forward: true });
  assert.equal(fixture.runtime.arbiter.tick().source, 'skill');
  let takeovers = 0, deaths = 0;
  arena.events.on('human_takeover', () => takeovers++);
  arena.events.on('failure', (reason) => { if (reason === 'bot_death') deaths++; });
  const socket = new EventEmitter();
  fixture.runtime.ws.emit('connection', socket);
  socket.emit('message', Buffer.from('{"type":"control","action":{}}'));
  fixture.runtime.bot.emit('death');
  assert.equal(takeovers, 1);
  assert.equal(deaths, 1);
  arena.close();
  assert.ok(fixture.released() > 0);
  assert.equal(fixture.closed(), true);
});

test('live adapter closes on wrong seed and rejects unknown resets', async () => {
  const fixture = liveFixture();
  await assert.rejects(createLiveArena({ ...fixture.options, command: async () => 'Seed: [123]' }), /seed 37001/);
  assert.equal(fixture.closed(), true);
  const second = liveFixture();
  const arena = await createLiveArena(second.options);
  const signal = new AbortController().signal;
  await assert.rejects(arena.reset(null, { signal }), /reset_steps/);
  await assert.rejects(arena.reset([{ command: 'tp EvalTest 0 64 0' }], { signal }), /verify/);
  arena.close();
});
