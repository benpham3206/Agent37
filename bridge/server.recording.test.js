import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRuntime } from './server.js';

test('runtime records the connected agent and winning controller across takeovers and overrides', { timeout: 10000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent37-runtime-recording-'));
  const bot = { username: 'ConnectedBot', health: 20, entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }, setControlState() {}, look() {} };
  const runtime = await createRuntime({ bot, dataDir, session: 's', username: 'ConfiguredBot', webPort: 0 });
  const clients = [];
  const heartbeat = setInterval(() => {
    for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'heartbeat' }));
  }, 100);
  t.after(async () => {
    clearInterval(heartbeat);
    const closed = once(runtime.server, 'close');
    for (const client of clients) client.terminate();
    runtime.recorder.stop();
    runtime.close();
    await closed;
  });
  const connect = async () => {
    const address = runtime.server.address();
    const client = new WebSocket(`ws://${address.address}:${address.port}/control`);
    clients.push(client);
    await once(client, 'open');
    return client;
  };
  const readRows = () => fs.readFileSync(runtime.recorder.path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const nextRow = async (client, command, expectedSource, matches = () => true) => {
    const previousCount = readRows().length;
    client.send(JSON.stringify(command));
    // State messages follow recording in the same timer callback.
    for (let attempt = 0; attempt < 40; attempt++) {
      await once(client, 'message');
      const row = readRows().slice(previousCount).find(row => row.arbiter.source === expectedSource && matches(row));
      if (row) return row;
    }
    assert.fail(`No recorded ${expectedSource} row`);
  };
  const first = await connect();
  runtime.recorder.start();
  const control = { type: 'control', action: { forward: true, yaw_delta: 0.1 } };
  const firstRow = await nextRow(first, control, 'teacher');
  assert.equal(firstRow.agent_name, 'ConnectedBot');
  assert.match(firstRow.controller_id, /^[0-9a-f-]{36}$/);
  assert.equal(firstRow.source, 'privileged_hitbox');
  assert.ok(Number.isSafeInteger(firstRow.server_time_ms));
  assert.ok(firstRow.server_time_ms >= firstRow.timestamp_ms);
  const repeated = await nextRow(first, control, 'teacher');
  assert.equal(repeated.controller_id, firstRow.controller_id);

  const second = await connect();
  const takeover = await nextRow(second, { type: 'control', action: { back: true } }, 'teacher', row => row.applied_action.back);
  assert.notEqual(takeover.controller_id, firstRow.controller_id);
  assert.match(takeover.controller_id, /^[0-9a-f-]{36}$/);
  bot.health = 1;
  const survival = await nextRow(second, control, 'survival');
  assert.equal(survival.controller_id, null);
  bot.health = 20;
  const idle = await nextRow(second, { type: 'release' }, 'idle');
  assert.equal(idle.controller_id, null);

  second.close();
  await once(second, 'close');
  const reconnected = await connect();
  const reconnect = await nextRow(reconnected, { type: 'control', action: { right: true } }, 'teacher', row => row.applied_action.right);
  assert.notEqual(reconnect.controller_id, takeover.controller_id);
  const emergency = await nextRow(reconnected, { type: 'emergency_stop' }, 'emergency');
  assert.equal(emergency.controller_id, null);
  assert.ok(readRows().every(row => row.agent_name === 'ConnectedBot' && Object.hasOwn(row, 'controller_id') && Number.isSafeInteger(row.server_time_ms)));
});
