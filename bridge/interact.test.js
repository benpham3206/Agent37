import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { interactAt } from './interact.js';
import { createRuntime } from './server.js';
import { fakeWorldBot } from './fixtures/observation/fake-world.js';

const target = { x: 3, y: 63, z: 0, face: { x: 0, y: 1, z: 0 } };
function fixture(item = 'flint_and_steel') {
  const block = { name: 'obsidian', position: new Vec3(3, 63, 0) }, calls = [];
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, heldItem: { name: item },
    blockAt(p) { assert.deepEqual(p, block.position); return block; },
    activateBlock(...args) { calls.push(args); return Promise.resolve(); },
  };
  return { bot, block, calls };
}

test('uses flint and steel on the top face of the selected obsidian', async () => {
  const { bot, block, calls } = fixture();
  await interactAt(bot, target);
  assert.deepEqual(calls, [[block, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5)]]);
});

test('the same action uses a held block against each of the six faces', async () => {
  for (const face of [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]) {
    const { bot, block, calls } = fixture('obsidian');
    bot.entity.position.x = 1;
    await interactAt(bot, { ...target, face });
    assert.deepEqual(calls, [[block, new Vec3(face.x, face.y, face.z), new Vec3(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)]]);
  }
});

test('rejects invalid coordinates and faces before looking up a block', () => {
  const { bot, calls } = fixture();
  bot.blockAt = () => assert.fail('invalid target must not query the world');
  for (const value of [null, {}, { ...target, x: 1.5 }, { ...target, y: NaN }, { ...target, z: Infinity }, { ...target, face: null }, { ...target, face: { x: 1, y: 1, z: 0 } }, { ...target, face: { x: 0, y: 0, z: 0 } }]) interactAt(bot, value);
  assert.equal(calls.length, 0);
});

test('ignores faces of integers that are not unit axis vectors', async () => {
  for (const face of [{ x: 1, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }]) {
    const { bot, calls } = fixture();
    await interactAt(bot, { ...target, face });
    assert.equal(calls.length, 0);
  }
});

test('measures reach from the eye to the selected face and tolerates unloaded blocks', async () => {
  const { bot, calls } = fixture();
  const point = new Vec3(3.5, 64, 0.5);
  bot.entity.position = new Vec3(point.x - 4.5, point.y - 1.62, point.z);
  await interactAt(bot, target);
  assert.equal(calls.length, 1);
  bot.entity.position.x -= 0.001;
  interactAt(bot, target);
  assert.equal(calls.length, 1);
  for (const name of ['air', 'cave_air', 'void_air']) {
    const f = fixture(); f.block.name = name; interactAt(f.bot, target); assert.equal(f.calls.length, 0);
  }
  for (const read of [() => null, () => { throw new Error('unloaded chunk'); }]) {
    const f = fixture(); f.bot.blockAt = read; interactAt(f.bot, target); assert.equal(f.calls.length, 0);
  }
  for (const key of ['blockAt', 'activateBlock', 'entity']) {
    const f = fixture(); delete f.bot[key]; interactAt(f.bot, target); assert.equal(f.calls.length, 0);
  }
});

test('keeps one operation per bot in flight and retries after completion or interruption', async () => {
  for (const rejected of [false, true]) {
    const { bot } = fixture();
    let settle, calls = 0;
    bot.activateBlock = () => { calls++; return new Promise((resolve, reject) => { settle = () => rejected ? reject(new Error('interrupted')) : resolve(); }); };
    const first = interactAt(bot, target);
    interactAt(bot, target);
    assert.equal(calls, 1);
    const other = fixture(); await interactAt(other.bot, target); assert.equal(other.calls.length, 1);
    settle(); await first;
    const second = interactAt(bot, target); assert.equal(calls, 2); settle(); await second;
  }
  const { bot } = fixture();
  bot.activateBlock = () => { throw new Error('interrupted synchronously'); };
  await interactAt(bot, target);
  let retried = false; bot.activateBlock = async () => { retried = true; };
  await interactAt(bot, target); assert.equal(retried, true);
});

test('runtime routes the new action through the arbiter and selects its hotbar slot before use', async (t) => {
  const bot = fakeWorldBot();
  const original = bot.setQuickBarSlot;
  bot.setQuickBarSlot = (slot) => { bot.quickBarSlot = slot; original(slot); };
  let resolve;
  const activated = new Promise((done) => { resolve = done; });
  bot.activateBlock = async (block, face, cursor) => resolve({ block, face, cursor, slot: bot.quickBarSlot });
  const runtime = await createRuntime({ bot, webPort: 0, dataDir: path.join(os.tmpdir(), 'a37-interact-unit'), session: 'wire-' + process.pid + '-' + Date.now(), jev: { stop() {}, read: () => null } });
  t.after(() => runtime.close());
  runtime.arbiter.set('skill', { hotbar: 4, interact: target });
  const timer = setTimeout(() => resolve(null), 1000);
  t.after(() => clearTimeout(timer));
  const result = await activated;
  assert.ok(result, 'the bridge applies the new action');
  assert.equal(result.slot, 4);
  assert.deepEqual(result.block.position, new Vec3(3, 63, 0));
  assert.deepEqual(result.face, new Vec3(0, 1, 0));
  assert.deepEqual(result.cursor, new Vec3(0.5, 1, 0.5));
});
