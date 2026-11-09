import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { digAt } from './dig.js';

const pos = { x: 3, y: 64, z: 0 };
function fixture(name = 'oak_log') {
  const block = { name }, calls = [];
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt(p) { assert.deepEqual(p, new Vec3(pos.x, pos.y, pos.z)); return block; },
    dig(...args) { calls.push(args); return Promise.resolve(); },
  };
  return { bot, block, calls };
}

test('digs the block in reach', async () => {
  const { bot, block, calls } = fixture();
  await digAt(bot, pos);
  assert.deepEqual(calls, [[block, true]]);
});

test('ignores missing blocks and air', () => {
  for (const name of ['air', 'cave_air', 'void_air']) {
    const { bot, calls } = fixture(name);
    digAt(bot, pos);
    assert.equal(calls.length, 0);
  }
  const { bot, calls } = fixture();
  bot.blockAt = () => null; digAt(bot, pos);
  delete bot.blockAt; digAt(bot, pos);
  assert.equal(calls.length, 0);
});

test('ignores a block outside eye reach', () => {
  const { bot, calls } = fixture();
  bot.entity.position.x = -2;
  digAt(bot, pos);
  assert.equal(calls.length, 0);
});

test('keeps one dig in flight and retries after it resolves or rejects', async () => {
  for (const rejected of [false, true]) {
    const { bot } = fixture();
    let settle, calls = 0;
    bot.dig = () => { calls++; return new Promise((resolve, reject) => { settle = () => rejected ? reject(new Error('interrupted')) : resolve(); }); };
    const first = digAt(bot, pos);
    digAt(bot, pos);
    assert.equal(calls, 1);
    settle(); await first;
    const second = digAt(bot, pos);
    assert.equal(calls, 2);
    settle(); await second;
  }
});
