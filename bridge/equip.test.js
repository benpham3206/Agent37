import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { equipItem } from './equip.js';
import { createRuntime } from './server.js';
import { fakeWorldBot } from './fixtures/observation/fake-world.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

// slots maps window slot index to item name; items() returns main+hotbar items.
function fakeBot({ held = null, items = [], slots = {} } = {}) {
  const slotArray = [];
  for (const [index, name] of Object.entries(slots)) slotArray[Number(index)] = { name };
  const calls = { equip: [], quickBar: [] };
  const bot = {
    heldItem: held ? { name: held } : null,
    inventory: {
      slots: slotArray,
      items: () => items.map((item, i) => ({ name: item.name ?? item, count: item.count ?? 1, slot: item.slot ?? 9 + i })),
    },
    setQuickBarSlot(slot) { calls.quickBar.push(slot); },
    equip(item, destination) {
      calls.equip.push({ item, destination });
      return new Promise((resolve, reject) => { bot._settle = { resolve, reject }; });
    },
  };
  return { bot, calls };
}

test('a hotbar copy is selected without bot.equip', () => {
  const { bot, calls } = fakeBot({ slots: { 37: 'stone_pickaxe' }, items: [{ name: 'stone_pickaxe', slot: 37 }] });
  equipItem(bot, 'stone_pickaxe');
  assert.deepEqual(calls.quickBar, [1]);
  assert.equal(calls.equip.length, 0);
});

test('an already held item does nothing', () => {
  const { bot, calls } = fakeBot({ held: 'crafting_table', items: [{ name: 'crafting_table', slot: 12 }] });
  equipItem(bot, 'crafting_table');
  assert.deepEqual(calls.quickBar, []);
  assert.equal(calls.equip.length, 0);
});

test('a main-inventory item gets exactly one bot.equip across repeated requests while in flight', async () => {
  const { bot, calls } = fakeBot({ items: [{ name: 'crafting_table', slot: 12 }] });
  for (let i = 0; i < 5; i++) equipItem(bot, 'crafting_table');
  assert.equal(calls.equip.length, 1);
  assert.equal(calls.equip[0].destination, 'hand');
  assert.equal(calls.equip[0].item.name, 'crafting_table');
  bot._settle.resolve();
  await flush(); await flush();
  equipItem(bot, 'crafting_table');
  assert.equal(calls.equip.length, 2, 'the busy flag cleared once the equip resolved');
});

test('an item nowhere in the inventory does nothing', () => {
  const { bot, calls } = fakeBot({ items: [{ name: 'dirt', slot: 9 }] });
  equipItem(bot, 'crafting_table');
  assert.deepEqual(calls.quickBar, []);
  assert.equal(calls.equip.length, 0);
});

test('a rejecting bot.equip does not throw and clears the busy flag', async () => {
  const { bot, calls } = fakeBot({ items: [{ name: 'crafting_table', slot: 12 }] });
  assert.doesNotThrow(() => equipItem(bot, 'crafting_table'));
  assert.equal(calls.equip.length, 1);
  bot._settle.reject(new Error('window closed'));
  await flush(); await flush(); await flush();
  equipItem(bot, 'crafting_table');
  assert.equal(calls.equip.length, 2, 'a failed equip does not wedge the bot');
});

test('apply() equips an item held only in the main inventory and does not reselect the hotbar', async (t) => {
  const bot = fakeWorldBot();
  const table = { name: 'crafting_table', slot: 12, count: 1 };
  const slotArray = [];
  slotArray[12] = { name: 'crafting_table' };
  const equipCalls = [];
  bot.inventory = { slots: slotArray, items: () => [table] };
  bot.heldItem = null;
  bot.equip = (item, destination) => {
    equipCalls.push([item.name, destination]);
    bot.heldItem = { name: item.name };
    return Promise.resolve();
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-equip-'));
  const runtime = await createRuntime({ bot, webPort: 0, dataDir, session: 'equip-test', jev: { stop() {} } });
  t.after(() => { runtime.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  runtime.arbiter.set('skill', { equip: 'crafting_table', interact: { x: 1, y: 69, z: 0, face: { x: 0, y: 1, z: 0 } } });
  const deadline = performance.now() + 2000;
  while (!equipCalls.length && performance.now() < deadline) await delay(10);
  await delay(120);
  assert.deepEqual(equipCalls, [['crafting_table', 'hand']]);
  assert.equal(equipCalls.length, 1, 'later apply ticks do not re-equip a held item');
  assert.ok(!bot.calls.some((c) => c[0] === 'hotbar'), 'the sanitized hotbar default must not fight the equip');
});
