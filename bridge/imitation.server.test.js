import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createRuntime } from './server.js';
import { fakeWorldBot } from './fixtures/observation/fake-world.js';

test('emergency stop still stops the bot when the demonstration save fails', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-estop-'));
  const runtime = await createRuntime({ bot: fakeWorldBot(), webPort: 0, dataDir, session: 'estop-test' });
  const errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args); });
  t.after(() => { fs.rmSync(runtime.imitation.path, { recursive: true, force: true }); runtime.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const now = Date.now();
  runtime.imitation.startObserve(now);
  runtime.imitation.observe({ id: 4, position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, equipment: [] }, [], now + 10);
  fs.mkdirSync(runtime.imitation.path);

  const sock = new WebSocket(`ws://127.0.0.1:${runtime.server.address().port}/control`);
  await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
  sock.send(JSON.stringify({ type: 'emergency_stop' }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  sock.close();

  assert.equal(runtime.arbiter.emergency, true);
  assert.equal(runtime.imitation.state, 'observing');
  assert.ok(runtime.imitation.frames.length >= 1, "recorded frames are kept in memory");
  assert.ok(errors.some(([message]) => String(message).includes('emergency stop')));
});
