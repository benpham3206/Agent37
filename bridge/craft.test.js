import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { craftItem } from './craft.js';
import { ActionArbiter } from './arbiter.js';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from './server.js';
import { fakeWorldBot } from './fixtures/observation/fake-world.js';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { buildFacts } from './observation.js';

const require = createRequire(import.meta.url);

function protocolFixture(materials = { oak_log: 4 }, opts = {}) {
  const registry = require('prismarine-registry')('1.21.1');
  const Item = require('prismarine-item')(registry);
  const windows = require('prismarine-windows')('1.21.1');
  const { Recipe } = require('prismarine-recipe')(registry);
  const bot = new EventEmitter();
  Object.assign(bot, { registry, version: '1.21.1', supportFeature: registry.supportFeature.bind(registry), QUICK_BAR_START: 36,
    entity: { position: new Vec3(0.5, 64, 0.5) }, _client: new EventEmitter(), quickBarSlot: 0,
    lookAt: async () => {}, swingArm: () => {}, blockAt: (p) => ({ name: 'crafting_table', position: p }) });
  const server = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  let stateId = 0, tableWin = null;
  const packets = [];
  const copy = (item) => Item.fromNotch(Item.toNotch(item));
  const emitWindowItems = (win) => bot._client.emit('window_items', { windowId: win.id, stateId: ++stateId,
    items: win.slots.map(Item.toNotch), carriedItem: Item.toNotch(win.selectedItem) });
  const sync = () => emitWindowItems(server);
  const recompute = () => {
    const occupied = server.slots.slice(1, 5).filter(Boolean);
    const recipe = occupied.length === 1 && occupied[0].name === 'oak_log'
      ? Recipe.find(registry.itemsByName.oak_planks.id, null)[0] : null;
    server.updateSlot(0, recipe ? new Item(recipe.result.id, recipe.result.count) : null);
  };
  const bucketRecipe = Recipe.find(registry.itemsByName.bucket.id, null).find(r => r.requiresTable);
  const recomputeTable = () => {
    const shape = bucketRecipe.inShape;
    const match = [0, 1, 2].every(y => [0, 1, 2].every(x => {
      const cell = y < shape.length && x < shape[y].length ? shape[y][x] : { id: -1 };
      const it = tableWin.slots[1 + x + 3 * y];
      return cell.id === -1 ? !it : it && it.type === cell.id && it.count >= cell.count;
    }));
    tableWin.updateSlot(0, match ? new Item(bucketRecipe.result.id, bucketRecipe.result.count) : null);
  };
  const consumeTable = () => {
    for (const [y, row] of bucketRecipe.inShape.entries()) for (const [x, cell] of row.entries()) {
      if (cell.id === -1) continue;
      const s = 1 + x + 3 * y, it = tableWin.slots[s];
      if (it && it.type === cell.id && (it.count -= cell.count) <= 0) tableWin.updateSlot(s, null);
    }
  };
  const openTable = () => {
    tableWin = windows.createWindow(1, 'minecraft:crafting', 'Crafting');
    for (let i = tableWin.inventoryStart; i < tableWin.inventoryEnd; i++) tableWin.updateSlot(i, copy(server.slots[i - 1]));
    bot._client.emit('open_window', { windowId: 1, inventoryType: 'minecraft:crafting', windowTitle: 'Crafting' });
    emitWindowItems(tableWin);
  };
  const stashInto = (item) => {
    if (!item) return;
    const merge = server.findItemRange(server.inventoryStart, server.inventoryEnd, item.type, item.metadata, true, item.nbt);
    const slot = merge && merge.count + item.count <= merge.stackSize ? merge.slot : server.firstEmptySlotRange(server.inventoryStart, server.inventoryEnd);
    if (slot === null) return;
    if (server.slots[slot]) server.slots[slot].count += item.count;
    else server.updateSlot(slot, copy(item));
  };
  const closeTable = () => {
    if (!tableWin) return;
    for (let i = tableWin.inventoryStart; i < tableWin.inventoryEnd; i++) server.updateSlot(i - 1, copy(tableWin.slots[i]));
    for (let s = 1; s <= 9; s++) { stashInto(tableWin.slots[s]); tableWin.updateSlot(s, null); }
    stashInto(tableWin.selectedItem); tableWin.selectedItem = null;
    tableWin = null;
    sync();
  };
  bot._client.write = (name, packet) => {
    if (name === 'block_place') { setImmediate(openTable); return; }
    if (name === 'close_window') { setImmediate(closeTable); return; }
    if (name !== 'window_click') return;
    packets.push(packet);
    if (opts.failClick?.(packet)) throw new Error('interrupted click');
    setImmediate(() => {
      const win = packet.windowId === 0 ? server : tableWin;
      if (!win) return;
      const stale = packet.stateId !== stateId;
      const oldResult = copy(win.slots[0]);
      if (packet.mode === 0) {
        if (win.id !== 0 && packet.slot === 0 && oldResult) consumeTable();
        win.acceptClick({ ...packet, item: win.slots[packet.slot] });
        if (packet.slot === 0 && oldResult && win.id === 0) {
          for (let i = 1; i <= 4; i++) if (win.slots[i] && --win.slots[i].count === 0) win.updateSlot(i, null);
        }
        if (win.id === 0) recompute(); else recomputeTable();
      }
      if (stale) emitWindowItems(win);
      else if (packet.slot >= 0 && packet.slot <= (win.id === 0 ? 4 : 9)) {
        bot._client.emit('set_slot', { windowId: win.id, stateId: ++stateId, slot: 0, item: Item.toNotch(win.slots[0]) });
      }
    });
  };
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true });
  require('mineflayer/lib/plugins/craft')(bot);
  let slot = 36;
  for (const [name, count] of Object.entries(materials)) server.updateSlot(slot++, new Item(registry.itemsByName[name].id, count));
  sync();
  return { bot, server, packets, sync };
}

test('1.21.1 confirms all four batches and leaves the inventory crafting grid and cursor empty', async () => {
  const { bot, server } = protocolFixture();
  await craftItem(bot, { id: 'protocol', name: 'oak_planks', count: 16 });
  assert.equal(buildFacts(bot).inventory.oak_planks, 16);
  assert.equal(server.count(bot.registry.itemsByName.oak_planks.id, null), 16);
  assert.equal(server.selectedItem, null);
  assert.deepEqual(server.slots.slice(1, 5), [null, null, null, null]);
  assert.deepEqual(bot.inventory.slots.slice(1, 5), [null, null, null, null]);
});

test('1.21.1 returns stale cursor and grid items before crafting', async () => {
  const { bot, server, sync } = protocolFixture();
  const Item = require('prismarine-item')(bot.registry);
  const dirt = bot.registry.itemsByName.dirt;
  server.updateSlot(1, new Item(dirt.id, 2));
  server.selectedItem = new Item(dirt.id, 1);
  sync();
  await craftItem(bot, { id: 'leftovers', name: 'oak_planks', count: 16 });
  assert.equal(buildFacts(bot).inventory.oak_planks, 16);
  assert.equal(server.count(bot.registry.itemsByName.oak_planks.id, null), 16);
  assert.equal(server.count(dirt.id, null), 3);
  assert.equal(bot.inventory.count(dirt.id, null), 3);
  assert.equal(server.selectedItem, null);
  assert.equal(bot.inventory.selectedItem, null);
  assert.deepEqual(server.slots.slice(1, 5), [null, null, null, null]);
  assert.deepEqual(bot.inventory.slots.slice(1, 5), [null, null, null, null]);
});

const request = { id: 'one', name: 'oak_planks', count: 8 };
function fixture() {
  const calls = [], recipe = { result: { count: 4 } }, table = { name: 'crafting_table' };
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    registry: { itemsByName: { oak_planks: { id: 36 } } },
    blockAt: () => table,
    recipesFor(id, metadata, count, block) { assert.deepEqual([id, metadata, count], [36, null, 8]); assert.ok(block === null || block === table); return [recipe]; },
    craft(...args) { calls.push(args); return Promise.resolve(); },
  };
  return { bot, calls, recipe, table };
}

test('craft count is output items converted to recipe repetitions', async () => {
  const { bot, calls, recipe } = fixture();
  await craftItem(bot, request);
  assert.deepEqual(calls, [[recipe, 2, null]]);
});

test('crafts with the actual table block only inside eye reach', async () => {
  const { bot, calls, recipe, table } = fixture();
  await craftItem(bot, { ...request, table: { x: 3, y: 64, z: 0 } });
  assert.deepEqual(calls, [[recipe, 2, table]]);
  await craftItem(bot, { ...request, id: 'far', table: { x: 5, y: 64, z: 0 } });
  bot.blockAt = () => ({ name: 'stone' });
  await craftItem(bot, { ...request, id: 'stone', table: { x: 1, y: 64, z: 0 } });
  bot.blockAt = () => null;
  await craftItem(bot, { ...request, id: 'absent', table: { x: 1, y: 64, z: 0 } });
  assert.equal(calls.length, 1);
});

test('repeated arbiter ticks craft once, even after completion and intervening IDs', async () => {
  const { bot, calls } = fixture(), arbiter = new ActionArbiter();
  arbiter.set('skill', { craft: request });
  for (let i = 0; i < 10; i++) await craftItem(bot, arbiter.tick().action.craft);
  assert.equal(calls.length, 1);
  await craftItem(bot, { ...request, id: 'two' });
  await craftItem(bot, request);
  assert.equal(calls.length, 2);
});

test('one operation per bot stays in flight, and a fresh ID retries an interrupted craft', async () => {
  const { bot } = fixture();
  let reject, calls = 0;
  bot.craft = () => { calls++; return new Promise((_resolve, fail) => { reject = fail; }); };
  const first = craftItem(bot, request);
  craftItem(bot, { ...request, id: 'retry' });
  assert.equal(calls, 1);
  reject(new Error('interrupted')); await first;
  await craftItem(bot, request);
  assert.equal(calls, 1);
  const second = craftItem(bot, { ...request, id: 'retry' });
  assert.equal(calls, 2);
  reject(new Error('interrupted')); await second;
});

test('missing materials, unknown items and synchronous failures are swallowed', async () => {
  const { bot, calls } = fixture();
  bot.recipesFor = () => [];
  await craftItem(bot, request);
  await craftItem(bot, { ...request, id: 'unknown', name: 'unknown' });
  bot.recipesFor = () => { throw new Error('disconnected'); };
  await craftItem(bot, { ...request, id: 'throw' });
  assert.equal(calls.length, 0);
});

test('the runtime applies a craft skill request once across its 50 ms ticks', async (t) => {
  const { bot: crafting, calls } = fixture(), bot = fakeWorldBot();
  Object.assign(bot.registry, crafting.registry);
  bot.recipesFor = crafting.recipesFor; bot.craft = crafting.craft;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-craft-'));
  const runtime = await createRuntime({ bot, webPort: 0, dataDir, session: 'craft-test', jev: { stop() {} } });
  t.after(() => { runtime.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  runtime.arbiter.set('skill', { craft: request });
  const deadline = performance.now() + 1000;
  while (!calls.length && performance.now() < deadline) await delay(10);
  assert.equal(calls.length, 1, 'the live apply loop reaches the crafting plugin');
  await delay(160);
  assert.equal(calls.length, 1, 'later apply ticks do not consume materials twice');
  assert.equal(runtime.arbiter.tick().source, 'skill');
});

test('1.21.1 recovers materials stranded in the grid and cursor before crafting', async () => {
  const { bot, server, sync } = protocolFixture({});
  const Item = require('prismarine-item')(bot.registry);
  const log = bot.registry.itemsByName.oak_log;
  server.updateSlot(1, new Item(log.id, 3));
  server.selectedItem = new Item(log.id, 1);
  sync();
  await craftItem(bot, { id: 'stranded', name: 'oak_planks', count: 16 });
  assert.equal(buildFacts(bot).inventory.oak_planks, 16);
  assert.equal(server.count(bot.registry.itemsByName.oak_planks.id, null), 16);
  assert.equal(server.count(log.id, null), 0);
  assert.equal(server.selectedItem, null);
  assert.deepEqual(server.slots.slice(1, 5), [null, null, null, null]);
  assert.deepEqual(bot.inventory.slots.slice(1, 5), [null, null, null, null]);
});

test('1.21.1 cleans grid and cursor after an interrupted craft without losing items', async () => {
  const { bot, server } = protocolFixture({ oak_log: 4 }, { failClick: (p) => p.slot === 0 && p.windowId === 0 });
  await craftItem(bot, { id: 'interrupt', name: 'oak_planks', count: 16 });
  assert.equal(server.count(bot.registry.itemsByName.oak_planks.id, null), 0);
  assert.equal(server.count(bot.registry.itemsByName.oak_log.id, null), 4);
  assert.equal(server.selectedItem, null);
  assert.equal(bot.inventory.selectedItem, null);
  assert.deepEqual(server.slots.slice(1, 5), [null, null, null, null]);
  assert.deepEqual(bot.inventory.slots.slice(1, 5), [null, null, null, null]);
});

test('1.21.1 crafts a bucket through a real crafting table window and closes clean', async () => {
  const { bot, server } = protocolFixture({ iron_ingot: 3 });
  await craftItem(bot, { id: 'bucket', name: 'bucket', count: 1, table: { x: 1, y: 64, z: 0 } });
  assert.equal(server.count(bot.registry.itemsByName.bucket.id, null), 1);
  assert.equal(server.count(bot.registry.itemsByName.iron_ingot.id, null), 0);
  assert.equal(bot.inventory.count(bot.registry.itemsByName.bucket.id, null), 1);
  assert.equal(bot.currentWindow, null);
  assert.equal(server.selectedItem, null);
  assert.deepEqual(server.slots.slice(1, 5), [null, null, null, null]);
  assert.deepEqual(bot.inventory.slots.slice(1, 5), [null, null, null, null]);
});

test('1.21.1 returns table window items after an interrupted craft', async () => {
  const { bot, server } = protocolFixture({ iron_ingot: 3 }, { failClick: (p) => p.slot === 0 && p.windowId === 1 });
  await craftItem(bot, { id: 'table-interrupt', name: 'bucket', count: 1, table: { x: 1, y: 64, z: 0 } });
  assert.equal(server.count(bot.registry.itemsByName.bucket.id, null), 0);
  assert.equal(server.count(bot.registry.itemsByName.iron_ingot.id, null), 3);
  assert.equal(bot.currentWindow, null);
  assert.equal(server.selectedItem, null);
  assert.deepEqual(server.slots.slice(1, 5), [null, null, null, null]);
});

test('1.21.1 does not craft when the initial inventory confirmation fails', async () => {
  const { bot, server, packets } = protocolFixture();
  bot._syncWindow = async () => { throw new Error('confirmation unavailable'); };
  await craftItem(bot, { id: 'no-confirmation', name: 'oak_planks', count: 16 });
  assert.equal(packets.length, 0, 'no inventory clicks follow a failed confirmation');
  assert.equal(server.count(bot.registry.itemsByName.oak_log.id, null), 4);
  assert.equal(server.count(bot.registry.itemsByName.oak_planks.id, null), 0);
});

test('hotbarSlotOf finds an item only in hotbar slots 36 to 44', async () => {
  const { hotbarSlotOf } = await import('./craft.js');
  const slots = []; slots[38] = { name: 'stone_pickaxe' }; slots[20] = { name: 'bucket' };
  assert.equal(hotbarSlotOf({ inventory: { slots } }, 'stone_pickaxe'), 2);
  assert.equal(hotbarSlotOf({ inventory: { slots } }, 'bucket'), null);
  assert.equal(hotbarSlotOf({}, 'bucket'), null);
});
