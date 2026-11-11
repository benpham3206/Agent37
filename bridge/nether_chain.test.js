import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFacts, scoreNetherChain, WATCHED_BLOCKS } from './observation.js';
import { fakeWorldBot } from './fixtures/observation/fake-world.js';

test('WATCHED_BLOCKS covers common overworld logs beyond oak', () => {
  for (const name of ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'nether_portal']) {
    assert.ok(WATCHED_BLOCKS.includes(name), name);
  }
});

test('buildFacts finds oak_log and birch_log in nearest_blocks', () => {
  const oak = buildFacts(fakeWorldBot({ blocks: { oak_log: { x: 2, y: 64, z: 0 } } }));
  assert.ok(oak.nearest_blocks.oak_log);
  assert.equal(oak.nearest_blocks.birch_log, undefined);

  const birch = buildFacts(fakeWorldBot({ blocks: { birch_log: { x: 3, y: 64, z: 1 } } }));
  assert.ok(birch.nearest_blocks.birch_log);
  assert.equal(birch.nearest_blocks.birch_log.distance, Math.round(Math.hypot(3, 0, 1) * 100) / 100);
});

test('scoreNetherChain on empty facts blocks at spawn', () => {
  const scored = scoreNetherChain({});
  assert.equal(scored.steps.find((s) => s.id === 'spawn').status, 'not-started');
  assert.equal(scored.blocker?.id, 'spawn');
  for (const id of ['wood', 'tools', 'iron', 'obsidian', 'light', 'enter']) {
    assert.equal(scored.steps.find((s) => s.id === id).status, 'not-started', id);
  }
});

test('scoreNetherChain marks wood from oak_log inventory', () => {
  const scored = scoreNetherChain({
    position: { x: 0, y: 64, z: 0 },
    dimension: 'overworld',
    inventory: { oak_log: 4 },
    nearest_blocks: {},
  });
  assert.equal(scored.steps.find((s) => s.id === 'spawn').status, 'demo-ready');
  assert.equal(scored.steps.find((s) => s.id === 'wood').status, 'demo-ready');
  assert.equal(scored.blocker?.id, 'tools');
});

test('wood is close when logs are nearby but not in inventory', () => {
  const scored = scoreNetherChain({
    position: { x: 0, y: 64, z: 0 },
    dimension: 'overworld',
    inventory: {},
    nearest_blocks: { birch_log: { type: 'birch_log', distance: 4, dx: 4, dy: 0, dz: 0 } },
  });
  assert.equal(scored.steps.find((s) => s.id === 'wood').status, 'close');
  assert.equal(scored.blocker?.id, 'wood');
});

test('iron not-started vs demo-ready at 7 ingots', () => {
  const base = {
    position: { x: 0, y: 64, z: 0 },
    dimension: 'overworld',
    inventory: { oak_log: 1, wooden_pickaxe: 1 },
    nearest_blocks: {},
  };
  assert.equal(scoreNetherChain(base).steps.find((s) => s.id === 'iron').status, 'not-started');
  assert.equal(
    scoreNetherChain({ ...base, inventory: { ...base.inventory, iron_ingot: 3 } }).steps.find((s) => s.id === 'iron').status,
    'close',
  );
  assert.equal(
    scoreNetherChain({ ...base, inventory: { ...base.inventory, iron_ingot: 7 } }).steps.find((s) => s.id === 'iron').status,
    'demo-ready',
  );
});

test('enter is demo-ready only in the_nether', () => {
  const portal = {
    position: { x: 0, y: 64, z: 0 },
    dimension: 'overworld',
    inventory: {},
    nearest_blocks: { nether_portal: { type: 'nether_portal', distance: 2, dx: 2, dy: 0, dz: 0 } },
  };
  assert.equal(scoreNetherChain(portal).steps.find((s) => s.id === 'enter').status, 'close');
  assert.equal(scoreNetherChain(portal).steps.find((s) => s.id === 'light').status, 'demo-ready');
  assert.equal(
    scoreNetherChain({ ...portal, dimension: 'the_nether' }).steps.find((s) => s.id === 'enter').status,
    'demo-ready',
  );
});
