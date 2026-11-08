import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRun } from './index.js';
import { SkillRegistry } from '../../registry.js';
import { runTrial } from '../../../eval/run.mjs';
import { ActionArbiter } from '../../../arbiter.js';

const state = (x = 0, inventory = {}, logs = { oak_log: { type: 'oak_log', distance: 3, dx: 3, dy: 0, dz: 0 } }) => ({ self: { position: { x, y: 64, z: 0 }, health: 20, yaw: 0, pitch: 0 }, inventory, facts: { position: { x, y: 64, z: 0 }, nearest_blocks: logs } });
function fakeBot(initial, next) {
  let current = initial, releases = 0;
  const actions = [];
  return { actions, releases: () => releases, observe: () => structuredClone(current), requestAction(a) { actions.push(a); current = next(current, a); }, releaseControls() { releases++; } };
}
const signal = () => AbortSignal.timeout(500);

test('registry loads the seven-field runnable manifest and verified reset steps', () => {
  const skill = new SkillRegistry().load('resource.collect_oak_log', 1);
  assert.equal(skill.name, 'resource.collect_oak_log');
  assert.equal(skill.version, 1);
  assert.deepEqual(Object.keys(skill), ['name', 'version', 'implementation', 'requirements', 'success_check', 'reset_steps', 'evaluation']);
  assert.equal(skill.success_check.time_limit_ms, 45000);
  assert.deepEqual(skill.success_check.condition, { path: 'inventory.oak_log', increase_by: 1 });
  assert.equal(skill.evaluation, null);
  assert.equal(skill.reset_steps.length, 3);
  for (const step of skill.reset_steps) assert.ok(step.command && step.verify);
});

test('approaches, attacks within reach, and succeeds on any newly collected log', async () => {
  for (const item of ['oak_log', 'birch_log']) {
    const inventory = { [item]: 2 };
    const frames = [state(2, inventory), state(5.5, inventory, {}), state(5.5, { [item]: 3 }, {})];
    const bot = fakeBot(state(0, inventory, { oak_log: { type: 'oak_log', distance: 5, dx: 5, dy: 0, dz: 0 } }), () => frames.shift());
    const result = await createRun({ tickMs: 0 })(bot, {}, { signal: signal() });
    assert.equal(result.outcome, 'success');
    assert.equal(result.reason, 'log_collected');
    assert.ok(bot.actions.length >= 3);
    assert.equal(bot.actions[0].forward, true);
    assert.equal(bot.actions[0].attack, false);
    assert.equal(bot.actions[1].attack, true);
    assert.equal(bot.actions[2].forward, false);
    assert.equal(bot.releases(), 1);
  }
});

test('missing facts and absent logs fail without actions and release controls', async () => {
  for (const [o, reason] of [[{ self: { position: { x: 0, y: 64, z: 0 }, health: 20 } }, 'requirement_unmet:no_block_facts'], [state(0, {}, {}), 'no_log_in_range']]) {
    const bot = fakeBot(o, (x) => x);
    const result = await createRun()(bot, {}, { signal: signal() });
    assert.equal(result.outcome, 'failure');
    assert.equal(result.reason, reason);
    assert.equal(bot.actions.length, 0);
    assert.equal(bot.releases(), 1);
  }
});

test('death takes priority over collection and an aborted run releases controls', async () => {
  const dead = state(0, { oak_log: 1 }); dead.self.health = 0;
  const bot = fakeBot(state(), () => dead);
  assert.equal((await createRun({ tickMs: 0 })(bot, {}, { signal: signal() })).reason, 'bot_death');
  assert.equal(bot.releases(), 1);
  const aborted = fakeBot(state(), (o) => o);
  await assert.rejects(createRun()(aborted, {}, { signal: AbortSignal.abort(new Error('stopped')) }), /stopped/);
  assert.equal(aborted.actions.length, 0);
  assert.equal(aborted.releases(), 1);
});

test('runner trial observes inventory success and bounds a stuck skill', async () => {
  const arbiter = new ActionArbiter();
  let current = state(), collect = true;
  const arena = {
    events: new EventEmitter(), arbiter, synthetic: true, observe: () => structuredClone(current),
    async reset() { current = state(); }, release: () => arbiter.release('evaluation_cleanup'),
    bot: (s) => ({ observe: () => structuredClone(current), requestAction(a) { s.throwIfAborted(); arbiter.set('skill', a, 'evaluation'); if (collect) current = state(0, { oak_log: 1 }); }, releaseControls() { if (!s.aborted) arena.release(); } }),
  };
  const skill = new SkillRegistry().load('resource.collect_oak_log', 1);
  assert.equal((await runTrial({ arena, skill, run: createRun({ tickMs: 0 }), trial: 1 })).outcome, 'success');
  assert.equal(arbiter.tick().source, 'idle');
  collect = false;
  const stuck = await runTrial({ arena, skill: { ...skill, success_check: { ...skill.success_check, time_limit_ms: 30 } }, run: createRun({ tickMs: 1 }), trial: 2 });
  assert.equal(stuck.outcome, 'timeout');
  assert.deepEqual(stuck.after.inventory, {});
  assert.equal(arbiter.tick().source, 'idle');
});
