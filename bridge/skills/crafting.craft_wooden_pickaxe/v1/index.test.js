import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, placeSpot, tableIn } from './index.js';
import { recipeChain } from './recipe.js';
import { equipItem } from '../../../equip.js';
import { sanitizeAction } from '../../../arbiter.js';

const ground = () => [0, 1, 2].map(() => [0, 1, 2].map(() => ({ support: 'grass_block', solid: true, drop_depth: 0, available: true })));
const open = () => Object.fromEntries(['forward', 'back', 'left', 'right'].map((k) => [k, { body_clear: true, head_clear: true, available: true }]));

// A tiny fake world: a craft request applies the real recipe step, a click on the ground places the table.
function fakeWorld(inventory, { table = null, grid = ground(), clearance = open(), craftWorks = true } = {}) {
  const w = { inventory: { ...inventory }, table, actions: [], releases: 0 };
  const slots = [];
  const heldBot = {
    inventory: { slots, items: () => Object.entries(w.inventory).filter(([, n]) => n > 0).map(([name, count], i) => ({ name, count, slot: 9 + i })) },
    heldItem: null,
    setQuickBarSlot(slot) { this.heldItem = slots[36 + slot]; },
    async equip(item) { this.heldItem = item; },
  };
  w.observe = () => structuredClone({
    self: { position: { x: 0.5, y: 64, z: 0.5 }, health: 20, yaw: 0, pitch: 0 },
    inventory: Object.fromEntries(Object.entries(w.inventory).filter(([, n]) => n > 0)),
    terrain: { support_grid: grid, clearance },
    facts: { position: { x: 0.5, y: 64, z: 0.5 }, nearest_blocks: w.table
      ? { crafting_table: { type: 'crafting_table', dx: w.table.x - 0.5, dy: w.table.y - 64, dz: w.table.z - 0.5 } } : {} },
  });
  // Every request goes through the arbiter's own sanitizer, so a field it would drop is dropped here too.
  w.requestAction = (requested) => {
    const a = sanitizeAction(requested);
    w.actions.push(a);
    if (a.craft && craftWorks) {
      const step = recipeChain(a.craft.name, w.inventory, { tableNearby: true })
        .find((s) => s.item === a.craft.name);
      const times = Math.ceil(a.craft.count / step.count); // like craftItem: enough crafts for count
      for (const [item, n] of Object.entries(step.uses)) w.inventory[item] -= n * times;
      w.inventory[step.item] = (w.inventory[step.item] ?? 0) + step.count * times;
    }
    if (a.equip) equipItem(heldBot, a.equip);
    if (a.interact && heldBot.heldItem?.name === 'crafting_table' && w.inventory.crafting_table > 0) {
      w.inventory.crafting_table--;
      w.table = { x: a.interact.x + a.interact.face.x, y: a.interact.y + a.interact.face.y, z: a.interact.z + a.interact.face.z };
    }
  };
  w.releaseControls = () => { w.releases++; };
  return w;
}
const signal = () => AbortSignal.timeout(15000);

test('crafts a wooden pickaxe from 3 oak logs through craft and interact actions only', async () => {
  const world = fakeWorld({ oak_log: 3 });
  const result = await createRun({ tickMs: 0 })(world, {}, { signal: signal() });
  assert.equal(result.outcome, 'success');
  assert.equal(result.reason, 'crafted');
  assert.deepEqual(result.before, { oak_log: 3, crafting_table: 0, wooden_pickaxe: 0 });
  assert.deepEqual(result.after, { oak_log: 0, crafting_table: 0, wooden_pickaxe: 1 });
  assert.ok(Number.isFinite(result.elapsed_ms));
  assert.deepEqual(world.actions.filter((a) => a.craft).map((a) => a.craft.name),
    ['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe']);
  const pickaxe = world.actions.find((a) => a.craft?.name === 'wooden_pickaxe');
  assert.deepEqual(pickaxe.craft.table, world.table, 'the 3x3 craft names the table it placed');
  const click = world.actions.find((a) => a.interact);
  assert.equal(click.equip, 'crafting_table');
  assert.deepEqual(click.interact.face, { x: 0, y: 1, z: 0 }, 'places on top of solid ground');
  assert.ok(world.actions.every((a) => !a.attack && a.dig === undefined && !a.forward), 'no attacking, digging or walking');
  assert.equal(world.releases, 1);
});

test('uses a crafting table already within 4 blocks instead of placing one', async () => {
  const world = fakeWorld({ oak_log: 2 }, { table: { x: 2, y: 64, z: 0 } });
  const result = await createRun({ tickMs: 0 })(world, {}, { signal: signal() });
  assert.equal(result.outcome, 'success');
  assert.ok(!world.actions.some((a) => a.interact));
  assert.deepEqual(world.actions.at(-1).craft.table, { x: 2, y: 64, z: 0 });
});

test('fails clearly with too few logs and sends no action', async () => {
  const world = fakeWorld({ oak_log: 2 });
  const result = await createRun({ tickMs: 0 })(world, {}, { signal: signal() });
  assert.equal(result.outcome, 'failure');
  assert.equal(result.reason, 'requirement_unmet:missing materials for wooden_pickaxe: need 3 oak_log, have 2');
  assert.equal(world.actions.length, 0);
  assert.equal(world.releases, 1);
});

test('fails when no solid free spot is next to the bot', async () => {
  const grid = ground().map((row) => row.map((c) => ({ ...c, drop_depth: 5 })));
  const world = fakeWorld({ oak_log: 3 }, { grid });
  const result = await createRun({ tickMs: 0 })(world, {}, { signal: signal() });
  assert.equal(result.reason, 'no_place_for_table');
  assert.equal(world.releases, 1);
});

test('times out when a craft is never confirmed, and still releases controls', async () => {
  let t = 0;
  const world = fakeWorld({ oak_log: 3 }, { craftWorks: false });
  const result = await createRun({ tickMs: 0, limitMs: 10000, now: () => (t += 100) })(world, {}, { signal: signal() });
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.reason, 'time_limit');
  assert.ok(world.actions.filter((a) => a.craft).length > 1, 'an unconfirmed craft is asked again with a new id');
  assert.equal(new Set(world.actions.filter((a) => a.craft).map((a) => a.craft.id)).size, world.actions.filter((a) => a.craft).length);
  assert.equal(world.releases, 1);
});

test('stops on cancel and releases controls', async () => {
  const controller = new AbortController();
  const world = fakeWorld({ oak_log: 3 }, { craftWorks: false });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(createRun({ tickMs: 5 })(world, {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(world.releases, 1);
});

test('placeSpot follows the terrain grid rotation and tableIn reads facts', () => {
  const world = fakeWorld({});
  // yaw 0 faces north (-z), so "forward" is the block at z - 1.
  assert.deepEqual(placeSpot(world.observe()), { click: { x: 0, y: 63, z: -1 }, table: { x: 0, y: 64, z: -1 } });
  assert.equal(tableIn(world.observe()), null);
  world.table = { x: 1, y: 64, z: -2 };
  assert.deepEqual(tableIn(world.observe()), { x: 1, y: 64, z: -2 });
});
