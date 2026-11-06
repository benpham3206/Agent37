import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { jevEnabled, jevState, createJevClient, createJevPerception, toHints, JEV_URL } from './jev.js';

const facts = { dimension: 'overworld', health: 20, inventory: { oak_log: 2 },
  nearest_blocks: { iron_ore: { type: 'iron_ore', distance: 6, dx: 3, dy: -2, dz: 5 }, deepslate_iron_ore: { distance: 9, dx: 9, dy: 0, dz: 0 } },
  nearby_mobs: [{ type: 'cow', hostile: false, distance: 3, dx: 3, dy: 0, dz: 0 }, { type: 'zombie', hostile: true, distance: 7, dx: -5, dy: 0, dz: 5 }] };
// Shape taken from a real Jev reply.
const reply = { model: 'jev-1.14.0', answers: { next_goal: { type: 'choice', choice: 'iron', confidence: 0.6, probabilities: {} }, danger: { type: 'noul', noul: 0.79 } }, usage: { input_tokens: 495, output_tokens: 79 } };

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
  assert.equal(body.model, 'jev-latest'); assert.ok(body.questions.next_goal && body.questions.danger);
  assert.ok(!seen.init.body.includes('secret'));
});
test('client throws on http errors', async () => {
  const ask = createJevClient({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(ask({}), /429/);
});
test('hints point the chosen goal at the nearest matching block', () => {
  const h = toHints(reply, facts, 1000);
  assert.equal(h.next_goal, 'iron'); assert.equal(h.danger, 0.79);
  assert.deepEqual(h.where, { block: 'iron_ore', distance: 6, dx: 3, dy: -2, dz: 5 });
  assert.equal(h.nearest_hostile.type, 'zombie');
  assert.equal(toHints({ answers: { next_goal: { choice: 'bogus' } } }, facts).next_goal, null);
});
test('perception skips while busy, recovers from errors, and marks stale hints', async () => {
  let t = 0, calls = 0, release, fail = true;
  const p = createJevPerception({ getFacts: () => facts, now: () => t, ask: async () => { calls++; if (fail) throw new Error('timeout'); await new Promise((r) => { release = r; }); return reply; } });
  await p.refresh();
  assert.equal(p.read().errors, 1); assert.equal(p.read().hints, null); assert.equal(p.read().stale, true);
  fail = false;
  const first = p.refresh(); await p.refresh(); assert.equal(calls, 2); // second call skipped
  release(); await first;
  assert.equal(p.read().hints.next_goal, 'iron'); assert.equal(p.read().stale, false); assert.equal(p.read().errors, 0);
  t = 2000; assert.equal(p.read().stale, true);
});
test('bridge adds jev hints to /api/observation only when enabled', async () => {
  const { createRuntime } = await import('./server.js');
  const { fakeWorldBot } = await import('./fixtures/observation/fake-world.js');
  for (const jev of [null, { read: () => ({ enabled: true, hints: { next_goal: 'wood' } }), stop() {} }]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-jev-'));
    const rt = await createRuntime({ bot: fakeWorldBot(), webPort: 0, dataDir, session: 'jev', jev });
    try {
      const o = await (await fetch(`http://127.0.0.1:${rt.server.address().port}/api/observation`)).json();
      if (jev) assert.equal(o.jev.hints.next_goal, 'wood'); else assert.equal(o.jev, undefined);
    } finally { rt.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  }
});
