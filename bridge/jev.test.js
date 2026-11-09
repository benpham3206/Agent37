import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { jevEnabled, jevState, createJevClient, createJevPerception, toHints, JEV_URL, SITUATIONS, QUESTIONS } from './jev.js';

const facts = { dimension: 'overworld', health: 20, inventory: { oak_log: 2 },
  nearest_blocks: { iron_ore: { type: 'iron_ore', distance: 6, dx: 3, dy: -2, dz: 5 }, deepslate_iron_ore: { distance: 9, dx: 9, dy: 0, dz: 0 } },
  nearby_mobs: [{ type: 'cow', hostile: false, distance: 3, dx: 3, dy: 0, dz: 0 }, { type: 'zombie', hostile: true, distance: 7, dx: -5, dy: 0, dz: 5 }] };
// Shape taken from a real Jev reply.
const reply = { model: 'jev-1.14.0', answers: { situation: { type: 'choice', choice: 'on_tree', confidence: 0.6, probabilities: {} }, danger: { type: 'noul', noul: 0.79 } }, usage: { input_tokens: 495, output_tokens: 79 } };

test('off unless both the flag and the key are set', () => {
  assert.equal(jevEnabled({}), false);
  assert.equal(jevEnabled({ AGENT37_JEV: '1' }), false);
  assert.equal(jevEnabled({ JEV_API_KEY: 'k' }), false);
  assert.equal(jevEnabled({ AGENT37_JEV: '1', JEV_API_KEY: 'k' }), true);
});
test('client sends the documented request and never puts the key in the body', async () => {
  let seen;
  const ask = createJevClient({ apiKey: 'secret', fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => reply }; } });
  assert.deepEqual(await ask(jevState(facts)), reply);
  assert.equal(seen.url, JEV_URL);
  assert.equal(seen.init.headers.Authorization, 'Bearer secret');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'jev-latest'); assert.ok(body.questions.situation && body.questions.danger && !body.questions.next_goal);
  assert.ok(!seen.init.body.includes('secret'));
});
test('client throws on http errors', async () => {
  const ask = createJevClient({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(ask({}), /429/);
});
test('hints report the situation and danger, never a goal', () => {
  const h = toHints(reply, facts, 1000);
  assert.equal(h.situation, 'on_tree'); assert.equal(h.situation_confidence, 0.6); assert.equal(h.danger, 0.79);
  assert.equal(h.nearest_hostile.type, 'zombie');
  assert.ok(!('next_goal' in h) && !('where' in h));
  assert.equal(toHints({ answers: { situation: { choice: 'bogus' } } }, facts).situation, null);
});
test('state has no goal and carries what the bot stands on', () => {
  const st = jevState({ ...facts, position: { x: 1, y: 88, z: 2 }, surroundings: { standing_on: 'oak_leaves', around: { north: { open_below: true } } } });
  assert.ok(!('goal' in st));
  assert.equal(st.y, 88); assert.equal(st.surroundings.standing_on, 'oak_leaves');
  assert.deepEqual(Object.keys(QUESTIONS.situation.criteria).sort(), [...SITUATIONS].sort());
});
test('buildFacts reports a leaves floor and open edges in surroundings', async () => {
  const { buildFacts } = await import('./observation.js');
  const { fakeWorldBot } = await import('./fixtures/observation/fake-world.js');
  const bot = fakeWorldBot();
  bot.blockAt = (p) => Math.floor(p.y) === 63 && Math.floor(p.x) === 0 && Math.floor(p.z) === 0
    ? { name: 'oak_leaves', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  const s = buildFacts(bot).surroundings;
  assert.equal(s.standing_on, 'oak_leaves'); assert.equal(s.standing_solid, true);
  assert.ok(Object.values(s.around).every((a) => a.open_below === true));
  assert.deepEqual(Object.keys(s.around).sort(), ['east', 'north', 'south', 'west']);
});
test('perception skips while busy, recovers from errors, and marks stale hints', async () => {
  let t = 0, calls = 0, release, fail = true;
  const p = createJevPerception({ getFacts: () => facts, now: () => t, ask: async () => { calls++; if (fail) throw new Error('timeout'); await new Promise((r) => { release = r; }); return reply; } });
  await p.refresh();
  assert.equal(p.read().errors, 1); assert.equal(p.read().hints, null); assert.equal(p.read().stale, true);
  fail = false;
  const first = p.refresh(); await p.refresh(); assert.equal(calls, 2); // second call skipped
  release(); await first;
  assert.equal(p.read().hints.situation, 'on_tree'); assert.equal(p.read().stale, false); assert.equal(p.read().errors, 0);
  t = 2000; assert.equal(p.read().stale, true);
});
test('bridge adds jev hints to /api/observation only when enabled', async () => {
  const { createRuntime } = await import('./server.js');
  const { fakeWorldBot } = await import('./fixtures/observation/fake-world.js');
  for (const jev of [null, { read: () => ({ enabled: true, hints: { situation: 'on_tree' } }), stop() {} }]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-jev-'));
    const rt = await createRuntime({ bot: fakeWorldBot(), webPort: 0, dataDir, session: 'jev', jev });
    try {
      const o = await (await fetch(`http://127.0.0.1:${rt.server.address().port}/api/observation`)).json();
      if (jev) assert.equal(o.jev.hints.situation, 'on_tree'); else assert.equal(o.jev, undefined);
    } finally { rt.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test('heard_threat is an observation: one of five choices, read from sounds, with no instruction in it', async () => {
  const { HEARD_THREATS } = await import('./jev.js');
  assert.deepEqual([...HEARD_THREATS], ['none', 'creeper_fuse', 'explosion', 'hostile_nearby', 'other']);
  assert.deepEqual(Object.keys(QUESTIONS.heard_threat.criteria), [...HEARD_THREATS]);
  assert.equal(QUESTIONS.heard_threat.type, 'choice');
  assert.match(QUESTIONS.heard_threat.instructions, /sounds/);
  assert.match(QUESTIONS.heard_threat.instructions, /Describe only; do not say what to do/);
  assert.match(QUESTIONS.heard_threat.criteria.creeper_fuse, /entity\.creeper\.primed/);
  const heard = (choice) => toHints({ answers: { situation: { choice: 'on_tree' }, danger: { noul: 0.2 }, heard_threat: { type: 'choice', choice, confidence: 0.9 } } }, facts, 1);
  for (const choice of HEARD_THREATS) assert.equal(heard(choice).heard_threat, choice);
  assert.equal(heard('flee').heard_threat, null, 'an unknown choice is dropped');
  assert.equal(toHints(reply, facts).heard_threat, null, 'a reply without the answer');
  assert.ok(!('next_goal' in heard('none')));
  const st = jevState({ ...facts, sounds: [{ name: 'entity.creeper.primed', source: 'creeper', direction: 'front', distance: 2, age_ms: 40 }] });
  assert.equal(st.sounds[0].name, 'entity.creeper.primed');
});

test('entity.creeper.primed resolves on 1.21.1 from the packet id, and the tracker hands it to listeners at once', async () => {
  const { EventEmitter } = await import('node:events');
  const { createRequire } = await import('node:module');
  const { createSoundTracker, soundNameById } = await import('./sounds.js');
  const registry = createRequire(import.meta.url)('minecraft-data')('1.21.1');
  const id = registry.soundsArray.findIndex((x) => x.name === 'entity.creeper.primed');
  assert.ok(id >= 0, 'the sound exists in the 1.21.1 data');
  assert.equal(soundNameById(registry, id), 'entity.creeper.primed');
  // The packet decodes the holder as the 0-based registry index. Mineflayer looks the number up by minecraft-data id (1-based), one entry early.
  assert.equal(registry.sounds[id].name, 'entity.creeper.hurt');
  assert.equal(soundNameById(registry, null), null);
  assert.equal(soundNameById(undefined, 3), null);
  const client = new EventEmitter();
  const bot = { _client: client, registry, entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0 }, entities: { 3: { name: 'creeper', position: { x: 2, y: 64, z: 0 } } } };
  const tracker = createSoundTracker().attach(bot);
  const heard = [];
  const stop = tracker.subscribe((e) => heard.push(e));
  client.emit('sound_effect', { sound: { soundId: id }, soundCategory: 'hostile', x: 16, y: 512, z: 0 });
  assert.deepEqual(heard, [{ name: 'entity.creeper.primed', category: 'hostile', position: { x: 2, y: 64, z: 0 } }], 'heard inside the packet handler');
  assert.equal(tracker.list(bot)[0].name, 'entity.creeper.primed');
  client.emit('sound_effect', { sound: { data: { soundName: 'minecraft:entity.generic.explode' } }, soundCategory: 'block', x: 0, y: 512, z: 0 });
  assert.equal(heard.at(-1).name, 'entity.generic.explode');
  client.emit('entity_sound_effect', { sound: { soundId: id }, soundCategory: 'hostile', entityId: 3 });
  assert.equal(heard.at(-1).name, 'entity.creeper.primed');
  stop();
  client.emit('sound_effect', { sound: { soundId: id }, soundCategory: 'hostile', x: 16, y: 512, z: 0 });
  assert.equal(heard.length, 3, 'unsubscribed');
  tracker.subscribe(() => { throw new Error('a broken listener'); });
  assert.doesNotThrow(() => client.emit('sound_effect', { sound: { soundId: id }, soundCategory: 'hostile', x: 16, y: 512, z: 0 }));
});
