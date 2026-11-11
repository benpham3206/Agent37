import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRun, combatAction, HISTORY } from './index.js';
import { SkillRegistry } from '../../registry.js';
import { runTrial } from '../../../eval/run.mjs';
import { ActionArbiter } from '../../../arbiter.js';

const zombieAhead = (kills = 0, health = 20) => ({
  self: { health, position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
  target: { mob_type: 'zombie', aim_point: { x: 0, y: 65.62, z: -3 } },
  kills: { hostile_total: kills },
});

function fakeBot(states) {
  let i = 0;
  const actions = [];
  let releases = 0;
  return {
    actions, releases: () => releases,
    observe: () => structuredClone(states[Math.min(i++, states.length - 1)]),
    requestAction: (a) => actions.push(a),
    releaseControls: () => { releases++; },
  };
}
const fakePolicy = (output = { forward: true, attack: true, disengage: true }) => {
  const seen = [];
  return { seen, policy: { infer: async (h) => { seen.push(h.length); return output; } } };
};
const signal = () => new AbortController().signal;

test('the shipped skill.json loads with all seven template fields and a 60 s budget', () => {
  const skill = new SkillRegistry().load('combat.kill_hostile', 1);
  assert.equal(skill.success_check.time_limit_ms, 60000);
  assert.deepEqual(skill.success_check.condition, { path: 'kills.hostile_total', increase_by: 1 });
  assert.deepEqual(skill.requirements.input.allowed_targets, ['zombie', 'skeleton', 'spider', 'creeper']);
  assert.ok(skill.reset_steps.at(-1).command.includes('{target}'));
  assert.equal(skill.evaluation, null);
  for (const step of skill.reset_steps) assert.ok(step.command && step.verify);
});

test('without a model it reports requirement_unmet and sends no controls', async () => {
  const bot = fakeBot([zombieAhead()]);
  const run = createRun({ loadPolicy: async () => ({ error: 'A37_COMBAT_CANDIDATE_DIR not set' }) });
  const result = await run(bot, {}, { signal: signal() });
  assert.equal(result.outcome, 'failure');
  assert.match(result.reason, /^requirement_unmet:/);
  assert.equal(bot.actions.length, 0);
});

test('drives the policy through requestAction and succeeds when the kill count rises', async () => {
  const bot = fakeBot([zombieAhead(0), zombieAhead(0), zombieAhead(0), zombieAhead(1)]);
  const p = fakePolicy();
  const run = createRun({ loadPolicy: async () => p, tickMs: 0, inferenceMs: 0 });
  const result = await run(bot, {}, { signal: signal() });
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'target_death');
  assert.ok(bot.actions.length >= 2);
  assert.ok(bot.actions.every((a) => a.attack === true && !('disengage' in a)));
  assert.ok(p.seen.every((n) => n <= HISTORY));
  assert.equal(bot.releases(), 1);
});

test('fails on bot death and on inference errors, always releasing controls', async () => {
  const dead = fakeBot([zombieAhead(0), zombieAhead(0, 0)]);
  const run = createRun({ loadPolicy: async () => fakePolicy(), tickMs: 0, inferenceMs: 0 });
  assert.equal((await run(dead, {}, { signal: signal() })).reason, 'bot_death');
  assert.equal(dead.releases(), 1);
  const broken = fakeBot([zombieAhead()]);
  const bad = createRun({ loadPolicy: async () => ({ policy: { infer: async () => { throw new Error('x'); } } }), tickMs: 0 });
  assert.equal((await bad(broken, {}, { signal: signal() })).reason, 'inference_failed');
  assert.equal(broken.releases(), 1);
});

test('aim matches the bridge: turns toward the aim point', () => {
  const right = { ...zombieAhead(), target: { aim_point: { x: 3, y: 65.62, z: 0 } } };
  const a = combatAction({ forward: true }, right);
  assert.notEqual(a.yaw_delta, 0);
  assert.equal(combatAction({ forward: true }, {}).yaw_delta, undefined);
});

test('runner trial: abort stops the loop and the arbiter ends idle', async () => {
  const arbiter = new ActionArbiter();
  let state = zombieAhead();
  const arena = {
    events: new EventEmitter(), arbiter, synthetic: true,
    observe: () => structuredClone(state),
    async reset() { state = zombieAhead(); },
    release: () => arbiter.release('evaluation_cleanup'),
    bot: (s) => ({
      observe: () => structuredClone(state),
      requestAction(a) { s.throwIfAborted(); arbiter.set('skill', a, 'evaluation'); },
      releaseControls() { if (!s.aborted) arbiter.release('cleanup'); },
    }),
  };
  const skill = new SkillRegistry().load('combat.kill_hostile', 1);
  const run = createRun({ loadPolicy: async () => fakePolicy(), tickMs: 1, inferenceMs: 0 });
  setTimeout(() => { state = zombieAhead(1); }, 20);
  const row = await runTrial({ arena, skill, run, trial: 1 });
  assert.equal(row.outcome, 'success');
  assert.equal(arbiter.tick().source, 'idle');
  const timeoutSkill = { ...skill, success_check: { ...skill.success_check, time_limit_ms: 30 } };
  const stuck = await runTrial({ arena, skill: timeoutSkill, run, trial: 2 });
  assert.equal(stuck.outcome, 'timeout');
  assert.equal(arbiter.tick().source, 'idle');
});

test('the chosen target type is passed to the bridge policy', async () => {
  let asked = null;
  const bot = fakeBot([zombieAhead()]);
  const run = createRun({ loadPolicy: async (type) => { asked = type; return { error: 'none' }; } });
  await run(bot, { target_type: 'skeleton' }, { signal: signal() });
  assert.equal(asked, 'skeleton');
});
