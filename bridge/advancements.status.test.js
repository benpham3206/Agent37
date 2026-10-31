import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from './server.js';

const WOOD = 'minecraft:story/mine_wood', STONE = 'minecraft:story/mine_stone';

function fakeBot() {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot.entities = {};
  bot.inventory = { items: () => [], slots: [] };
  bot.quit = () => {};
  return bot;
}

test('/combat/status shows advancements from the bot\'s advancements packets', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-adv-'));
  const bot = fakeBot();
  const runtime = await createRuntime({ bot, webPort: 0, dataDir, session: 'adv-test' });
  t.after(() => { runtime.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const status = async () => (await (await fetch(`${base}/combat/status`)).json()).advancements;

  const before = await status();
  assert.equal(before.known, false);
  assert.deepEqual(before.done, []);

  bot._client.emit('advancements', {
    reset: true, identifiers: [], progressMapping: [],
    advancementMapping: [
      { key: WOOD, value: { requirements: [['log']] } },
      { key: STONE, value: { requirements: [['stone'], ['cobble']] } },
    ],
  });
  bot._client.emit('advancements', {
    reset: false, identifiers: [], advancementMapping: [],
    progressMapping: [
      { key: WOOD, value: [{ criterionIdentifier: 'log', criterionProgress: 1730000000000 }] },
      { key: STONE, value: [{ criterionIdentifier: 'stone', criterionProgress: 1730000000001 }] },
    ],
  });
  const after = await status();
  assert.equal(after.known, true);
  assert.deepEqual(after.done, [WOOD]);
  assert.deepEqual(after.in_progress, [STONE]);
  assert.deepEqual(after.progress[STONE], { met: 1, total: 2 });
});
