import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from './server.js';
import { buildFacts, normalizeDimension } from './observation.js';
import { validateAction, ACTION_FIELDS } from './api.js';
import { emptyAction } from './arbiter.js';
import { fakeWorldBot } from './fixtures/observation/fake-world.js';
import { checkSchema } from './fixtures/observation/schema-check.js';

const contract = (name) => JSON.parse(fs.readFileSync(new URL(`../contracts/${name}`, import.meta.url)));
const observationSchema = contract('observation.schema.json');
const actionSchema = contract('action.schema.json');

async function start(t, bot = fakeWorldBot()) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-api-'));
  const runtime = await createRuntime({ bot, webPort: 0, dataDir, session: 'api-test' });
  t.after(() => { runtime.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const post = (body) => fetch(`${base}/api/action`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { bot, runtime, base, post };
}

test('facts from the fake world are simple lookups', () => {
  const f = buildFacts(fakeWorldBot());
  assert.equal(f.inventory.iron_ingot, 3);
  assert.equal(f.inventory.oak_log, 4);
  assert.deepEqual(f.nearest_blocks.iron_ore, { type: 'iron_ore', distance: 6.4, dx: 3, dy: -4, dz: 4 });
  assert.equal(f.nearest_blocks.lava.distance, 10);
  assert.ok(f.nearest_blocks.water);
  assert.equal(f.nearest_blocks.obsidian, undefined);
  assert.equal(f.nearest_blocks.diamond_ore, undefined, 'diamond_ore is 24 blocks away, outside the 16-block radius');
  assert.deepEqual(f.nearby_mobs.map((m) => [m.type, m.hostile]), [['zombie', true], ['cow', false]]);
  assert.equal(f.nearby_mobs[0].dx, 5);
  assert.equal(f.dimension, 'overworld');
  assert.equal(f.health, 20); assert.equal(f.food, 18);
  assert.equal(f.time_of_day, 6000); assert.equal(f.is_day, true);
  assert.deepEqual(f.position, { x: 0, y: 64, z: 0 });
});
test('dimension names, night and a missing bot are handled', () => {
  assert.equal(normalizeDimension('minecraft:the_nether'), 'the_nether');
  assert.equal(normalizeDimension('nether'), 'the_nether');
  assert.equal(buildFacts(fakeWorldBot({ timeOfDay: 18000 })).is_day, false);
  const empty = buildFacts(null);
  assert.equal(empty.position, null); assert.deepEqual(empty.nearest_blocks, {}); assert.deepEqual(empty.nearby_mobs, []);
  assert.deepEqual(checkSchema(observationSchema.properties.facts, empty), []);
});
test('GET /api/observation matches the schema', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/api/observation`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(checkSchema(observationSchema, body), []);
  assert.equal(body.facts.inventory.iron_ingot, 3);
  assert.deepEqual(checkSchema(observationSchema, { ...body, facts: { ...body.facts, extra: 1 } }).length, 1);
});
test('POST /api/action rejects bad fields with 400 and { error }', async (t) => {
  const { post } = await start(t);
  for (const bad of [{ fly: true }, { forward: 'yes' }, { hotbar: 9 }, { hotbar: 1.5 }, { yaw_delta: 'x' }, { inventory: 'drop' }, [1], null]) {
    const res = await post(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(typeof (await res.json()).error, 'string');
  }
  assert.equal((await post('{not json')).status, 400);
});
test('a hotbar action reaches the fake bot through the arbiter as source "skill"', async (t) => {
  const { bot, post, runtime } = await start(t);
  const hotbar = new Promise((resolve) => bot.on('hotbar', (slot) => { if (slot === 3) resolve([slot]); }));
  const forward = new Promise((resolve) => bot.on('control', (k, v) => { if (k === 'forward' && v) resolve(); }));
  const res = await post({ hotbar: 3, forward: true });
  assert.equal(res.status, 200);
  const [slot] = await hotbar; await forward;
  assert.equal(slot, 3);
  assert.equal(runtime.arbiter.tick().source, 'skill');
});
test('inventory close closes the open window; open reports unsupported cleanly', async (t) => {
  const { bot, post } = await start(t);
  bot.currentWindow = { id: 5 };
  assert.equal((await post({ inventory: 'close' })).status, 200);
  assert.deepEqual(bot.calls.find((c) => c[0] === 'closeWindow'), ['closeWindow', { id: 5 }]);
  const open = await post({ inventory: 'open' });
  assert.equal(open.status, 409);
  assert.equal((await open.json()).error, 'inventory_open_unsupported');
});
test('the action schema and validator agree with emptyAction()', () => {
  assert.deepEqual(Object.keys(actionSchema.properties).sort(), [...ACTION_FIELDS].sort());
  assert.deepEqual(Object.keys(emptyAction()).sort(), ACTION_FIELDS.filter((f) => f !== 'inventory').sort());
  const good = { forward: true, hotbar: 2, yaw_delta: 0.1, inventory: 'close' };
  assert.deepEqual(checkSchema(actionSchema, good), []);
  assert.deepEqual(validateAction(good), { action: { forward: true, hotbar: 2, yaw_delta: 0.1 }, inventory: 'close' });
});
