import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGoals, pickNextGoal, validateGoals } from './goals.js';
import { SkillRegistry } from './registry.js';

const goals = loadGoals();
const ids = goals.map((g) => g.id);

test('goals.json loads: 5 ordered goals, each tied to a skill folder or marked planned', () => {
  assert.equal(goals.length, 5);
  assert.equal(goals[0].id, 'minecraft:story/root');
  assert.equal(goals[0].skill, 'crafting.craft_wooden_pickaxe');
  const registry = new SkillRegistry();
  for (const goal of goals.filter((g) => !g.planned)) assert.doesNotThrow(() => registry.load(goal.skill, 1));
});

test('none done gives the first goal', () => {
  assert.deepEqual(pickNextGoal({ done: [], in_progress: [] }, goals), { id: goals[0].id, skill: goals[0].skill });
  assert.deepEqual(pickNextGoal({ known: false, done: [], in_progress: [] }), { id: goals[0].id, skill: goals[0].skill });
});

test('some done gives the next goal not done, ignoring other advancements', () => {
  const summary = { done: [ids[0], 'minecraft:husbandry/root'], in_progress: [ids[1]] };
  assert.deepEqual(pickNextGoal(summary, goals), { id: ids[1], skill: goals[1].skill });
  // Order comes from goals.json, so a later goal done early is skipped over, not picked.
  assert.deepEqual(pickNextGoal({ done: [ids[0], ids[2]], in_progress: [] }, goals), { id: ids[1], skill: goals[1].skill });
  assert.deepEqual(pickNextGoal({ done: ids.slice(0, 4), in_progress: [] }, goals), { id: ids[4], skill: goals[4].skill });
});

test('all done gives null', () => {
  assert.equal(pickNextGoal({ done: [...ids].reverse(), in_progress: [] }, goals), null);
});

test('a skill with no template folder, not marked planned, throws on load', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-goals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = JSON.parse(fs.readFileSync(new URL('./goals.json', import.meta.url), 'utf8'));
  data.goals[2] = { id: 'minecraft:story/mine_stone', skill: 'resource.no_such_skill' };
  const file = path.join(dir, 'goals.json');
  fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => loadGoals({ file }), /goal 3: resource\.no_such_skill has no bridge\/skills\/resource\.no_such_skill\/vN\/skill\.json/);
  data.goals[2].planned = true;
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(loadGoals({ file })[2].planned, true, 'the same name is fine once marked planned');
});

test('the list shape is checked too', () => {
  const base = { goals: goals.map((g) => ({ ...g })) };
  assert.throws(() => validateGoals({ goals: base.goals.slice(0, 4) }), /exactly 5 goals/);
  assert.throws(() => validateGoals({ goals: [...base.goals.slice(0, 4), { ...base.goals[0] }] }), /listed twice/);
  assert.throws(() => validateGoals({ goals: [{ ...base.goals[0], id: 'story/root' }, ...base.goals.slice(1)] }), /id must look like/);
});
