import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFacts } from './observation.js';

test('one-pass block scan finds the nearest of each watched type within the radius', () => {
  const ids = { 1: { name: 'air' }, 2: { name: 'stone' }, 3: { name: 'iron_ore' }, 4: { name: 'lava' } };
  const at = { '3,64,0': 3, '-2,64,0': 3, '0,60,0': 4, '0,64,20': 4 };
  const bot = { entity: { position: { x: 0.5, y: 64, z: 0.5 } }, registry: { blocksByStateId: ids }, game: { minY: -64, height: 384 },
    world: { getBlockStateId: (p) => at[`${p.x},${p.y},${p.z}`] ?? (p.y < 63 ? 2 : 1) } };
  const f = buildFacts(bot, { radius: 8, watched: ['iron_ore', 'lava', 'stone', 'water'] });
  assert.deepEqual(f.nearest_blocks.iron_ore, { type: 'iron_ore', distance: 2.55, dx: -2.5, dy: 0, dz: -0.5 });
  assert.equal(f.nearest_blocks.lava.dy, -4);
  assert.equal(f.nearest_blocks.stone.dy, -2);
  assert.equal(f.nearest_blocks.water, undefined);
});
