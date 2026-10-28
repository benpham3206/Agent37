import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { applyAdvancementPacket, summarize, AdvancementTracker } from './advancements.js';

const WOOD = 'minecraft:story/mine_wood', STONE = 'minecraft:story/mine_stone';
const add = (id, reqs) => ({ key: id, value: { requirements: reqs, displayData: { title: { text: 'x' } } } });
const prog = (id, pairs) => ({ key: id, value: pairs.map(([c, t]) => ({ criterionIdentifier: c, criterionProgress: t })) });
const pkt = (o) => ({ reset: false, advancementMapping: [], identifiers: [], progressMapping: [], ...o });

test('reset with definitions and no progress: nothing done', () => {
  const s = applyAdvancementPacket(null, pkt({ reset: true, advancementMapping: [add(WOOD, [['log']]), add(STONE, [['stone']])] }));
  assert.deepEqual(summarize(s).done, []);
  assert.equal(s.entries[WOOD].displayData, undefined);
});

test('progress flips an advancement to done', () => {
  let s = applyAdvancementPacket(null, pkt({ reset: true, advancementMapping: [add(WOOD, [['log']])] }));
  s = applyAdvancementPacket(s, pkt({ progressMapping: [prog(WOOD, [['log', 1730000000000]])] }));
  assert.deepEqual(summarize(s).done, [WOOD]);
});

test('partial progress is in progress, not done', () => {
  const id = 'minecraft:adventure/two_things';
  let s = applyAdvancementPacket(null, pkt({ reset: true, advancementMapping: [add(id, [['a'], ['b']])] }));
  s = applyAdvancementPacket(s, pkt({ progressMapping: [prog(id, [['a', 5], ['b', null]])] }));
  const sum = summarize(s);
  assert.deepEqual(sum.in_progress, [id]); assert.deepEqual(sum.done, []);
  assert.deepEqual(sum.progress[id], { met: 1, total: 2 });
});

test('progress update keeps earlier criteria', () => {
  const id = 'minecraft:adventure/two_things';
  let s = applyAdvancementPacket(null, pkt({ reset: true, advancementMapping: [add(id, [['a'], ['b']])] }));
  s = applyAdvancementPacket(s, pkt({ progressMapping: [prog(id, [['a', 5]])] }));
  s = applyAdvancementPacket(s, pkt({ progressMapping: [prog(id, [['b', 6]])] }));
  assert.deepEqual(summarize(s).done, [id]);
});

test('removed ids drop out; reset clears everything', () => {
  let s = applyAdvancementPacket(null, pkt({ reset: true, advancementMapping: [add(WOOD, [['log']]), add(STONE, [['stone']])] }));
  s = applyAdvancementPacket(s, pkt({ identifiers: [STONE] }));
  assert.deepEqual(Object.keys(s.entries), [WOOD]);
  s = applyAdvancementPacket(s, pkt({ reset: true }));
  assert.deepEqual(s.entries, {});
});

test('bad ids and criteria are ignored; recipes hidden from summary', () => {
  let s = applyAdvancementPacket(null, pkt({ reset: true, advancementMapping: [add('BAD ID', [['x']]), add('minecraft:recipes/misc/stick', [['has']])] }));
  assert.deepEqual(Object.keys(s.entries), ['minecraft:recipes/misc/stick']);
  assert.deepEqual(summarize(s).progress, {});
});

test('tracker listens on bot._client and clears on disconnect', () => {
  const bot = new EventEmitter(); bot._client = new EventEmitter();
  const t = new AdvancementTracker(); const detach = t.attach(bot);
  bot._client.emit('advancements', pkt({ reset: true, advancementMapping: [add(WOOD, [['log']])], progressMapping: [prog(WOOD, [['log', 1n]])] }));
  assert.deepEqual(t.get().done, [WOOD]);
  bot.emit('end'); assert.equal(t.get().known, false);
  detach(); bot._client.emit('advancements', pkt({ reset: true, advancementMapping: [add(STONE, [['s']])] }));
  assert.deepEqual(t.get().done, []); assert.equal(bot._client.listenerCount('advancements'), 0);
});
