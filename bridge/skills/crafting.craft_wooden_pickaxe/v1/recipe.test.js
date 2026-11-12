import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { recipeChain } from './recipe.js';
import { SkillRegistry, FIELDS } from '../../registry.js';

const mc = createRequire(import.meta.url)('minecraft-data')('1.21.1');
const crafts = (steps) => steps.map((s) => (s.action === 'place' ? 'place crafting_table' : s.item));

test('3 oak logs give the chain logs, planks, sticks, crafting table, wooden pickaxe', () => {
  const steps = recipeChain('wooden_pickaxe', { oak_log: 3 });
  assert.deepEqual(crafts(steps), ['oak_planks', 'stick', 'crafting_table', 'place crafting_table', 'wooden_pickaxe']);
  assert.deepEqual(steps[0], { action: 'craft', item: 'oak_planks', count: 12, crafts: 3, table: false, uses: { oak_log: 3 } });
  assert.deepEqual(steps[1].uses, { oak_planks: 2 });
  assert.equal(steps[1].count, 4);
  assert.deepEqual(steps[2].uses, { oak_planks: 4 });
  assert.equal(steps[2].table, false, 'the crafting table fits the 2x2 inventory grid');
  assert.deepEqual(steps[4].uses, { oak_planks: 3, stick: 2 });
  assert.equal(steps[4].table, true, 'the pickaxe needs the 3x3 grid');
  // 12 planks made, 2 + 4 + 3 used: the 3 logs are enough with 3 planks left over.
});

test('the chain matches the 1.21.1 recipes in minecraft-data', () => {
  for (const step of recipeChain('wooden_pickaxe', { oak_log: 3 }).filter((s) => s.action === 'craft')) {
    const id = mc.itemsByName[step.item].id;
    const matches = mc.recipes[id].some((r) => {
      const cells = (r.inShape ? r.inShape.flat() : r.ingredients).filter((x) => x != null);
      const uses = {};
      for (const c of cells) uses[mc.items[c].name] = (uses[mc.items[c].name] ?? 0) + step.crafts;
      return r.result.count * step.crafts === step.count && JSON.stringify(uses) === JSON.stringify(step.uses);
    });
    assert.ok(matches, `${step.item} uses a real recipe`);
  }
});

test('missing materials fail clearly, naming what is short', () => {
  for (const [inventory, message] of [
    [{}, 'missing materials for wooden_pickaxe: need 3 oak_log, have 0'],
    [{ oak_log: 2 }, 'missing materials for wooden_pickaxe: need 3 oak_log, have 2'],
    [{ oak_planks: 3 }, 'missing materials for wooden_pickaxe: need 2 oak_log, have 0'],
  ]) {
    assert.throws(() => recipeChain('wooden_pickaxe', inventory), (error) => {
      assert.equal(error.code, 'missing_materials');
      assert.equal(error.message, message);
      return true;
    });
  }
});

test('uses what is held: other woods, a held table, or a table already in reach', () => {
  assert.deepEqual(crafts(recipeChain('wooden_pickaxe', { birch_log: 5 })),
    ['birch_planks', 'stick', 'crafting_table', 'place crafting_table', 'wooden_pickaxe']);
  assert.deepEqual(crafts(recipeChain('wooden_pickaxe', { oak_log: 2, crafting_table: 1 })),
    ['oak_planks', 'stick', 'place crafting_table', 'wooden_pickaxe']);
  assert.deepEqual(crafts(recipeChain('wooden_pickaxe', { oak_log: 2 }, { tableNearby: true })),
    ['oak_planks', 'stick', 'wooden_pickaxe']);
  assert.deepEqual(crafts(recipeChain('wooden_pickaxe', { oak_planks: 3, stick: 2 }, { tableNearby: true })), ['wooden_pickaxe']);
  assert.throws(() => recipeChain('not_an_item', {}), /unknown item/);
});

test('the J1 registry loads skill.json with all 7 fields and runner-ready details', () => {
  const skill = new SkillRegistry().load('crafting.craft_wooden_pickaxe', 1);
  assert.deepEqual(Object.keys(skill), [...FIELDS]);
  assert.deepEqual(skill.implementation, { type: 'code', artifact: 'index.js', entry_point: 'run' });
  assert.deepEqual(skill.success_check.condition, { path: 'inventory.wooden_pickaxe', increase_by: 1 });
  assert.equal(skill.success_check.time_limit_ms, 10000);
  assert.equal(skill.evaluation.status, 'untested');
  for (const step of skill.reset_steps) assert.ok(step.command && step.verify);
  assert.ok(skill.reset_steps.some((s) => s.command === 'give {username} minecraft:oak_log 3'));
});
