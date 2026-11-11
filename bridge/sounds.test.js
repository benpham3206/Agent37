import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSoundTracker, soundDirection, soundCategory } from './sounds.js';
import { jevState } from './jev.js';

const self = { x: 0, y: 64, z: 0 };
test('direction is relative to yaw', () => {
  // yaw 0 faces -z (north)
  assert.equal(soundDirection(self, 0, { x: 0, y: 64, z: -5 }).direction, 'front');
  assert.equal(soundDirection(self, 0, { x: 0, y: 64, z: 5 }).direction, 'behind');
  assert.equal(soundDirection(self, 0, { x: 5, y: 64, z: 0 }).direction, 'right');
  assert.equal(soundDirection(self, 0, { x: -5, y: 64, z: 0 }).direction, 'left');
  // turned to face +z: the same point at +z is now in front
  assert.equal(soundDirection(self, Math.PI, { x: 0, y: 64, z: 5 }).direction, 'front');
  assert.equal(soundDirection(self, 0, { x: 0, y: 58, z: 4 }).direction, 'behind below');
  assert.equal(soundDirection(self, 0, { x: 0, y: 70, z: 0 }).direction, 'above');
  assert.equal(soundDirection(self, 0, { x: 3, y: 64, z: 4 }).distance, 5);
  assert.equal(soundCategory('minecraft:entity.zombie.ambient'), 'entity');
});
test('tracker reads raw packets, keeps 3 s, caps at 8, newest first', () => {
  let t = 0; const client = new EventEmitter();
  const bot = { _client: client, entity: { position: self, yaw: 0 }, entities: { 7: { name: 'zombie', position: { x: 0, y: 64, z: 6 } } } };
  const s = createSoundTracker({ now: () => t }).attach(bot);
  // numeric id: named after the zombie standing there, category from the packet
  client.emit('sound_effect', { sound: { soundId: 1585 }, soundCategory: 'hostile', x: 0, y: 64 * 8, z: 6 * 8 });
  assert.deepEqual(s.list(bot), [{ name: 'hostile:zombie', category: 'hostile', source: 'zombie', direction: 'behind', distance: 6, age_ms: 0 }]);
  client.emit('entity_sound_effect', { entityId: 7, soundCategory: 'hostile' });
  assert.equal(s.list(bot).length, 2);
  t = 1000; for (let i = 0; i < 10; i++) client.emit('sound_effect', { sound: { data: { soundName: 'minecraft:block.lava.pop' } }, soundCategory: 'block', x: 32, y: 512, z: 0 });
  const l = s.list(bot);
  assert.equal(l.length, 8); assert.equal(l[0].name, 'minecraft:block.lava.pop'.replace('minecraft:', '')); assert.equal(l[0].direction, 'right'); assert.equal(l[0].source, null);
  t = 4100; assert.equal(s.list(bot).length, 0);
});
test('jev state carries sounds', () => {
  const st = jevState({ sounds: [{ name: 'entity.zombie.ambient', category: 'entity', direction: 'behind', distance: 6, age_ms: 200 }] });
  assert.deepEqual(st.sounds, [{ name: 'entity.zombie.ambient', source: null, direction: 'behind', distance: 6, age_ms: 200 }]);
});
