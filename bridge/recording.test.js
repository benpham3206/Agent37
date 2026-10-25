import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { Recorder } from './recording.js';
import { createRuntime } from './server.js';

function sample() { return { observation: {}, teacher_action: {}, applied_action: {}, arbiter: {} }; }

test('session metadata and encounter transitions follow the recording contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent37-recording-'));
  const recorder = new Recorder({ dataDir: root, sessionId: 's', target: 'zombie', notes: 'arena demo' });
  const session = JSON.parse(fs.readFileSync(path.join(root, 's', 'session.json')));
  assert.equal(session.environment_suite, 'open_surface');
  assert.equal(session.environment_label, 'open_surface');
  assert.equal(session.notes, 'arena demo');
  recorder.start(); const first = recorder.encounterId; recorder.row(...Object.values(sample()), 1); recorder.pause();
  recorder.resume(); const second = recorder.encounterId; recorder.row(...Object.values(sample()), 2); recorder.stop();
  assert.notEqual(first, second);
  assert.equal(recorder.fd, null);
  assert.equal(fs.readdirSync(path.join(root, 's', 'encounters')).length, 2);
});

test('label updates all existing rows in the current encounter', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent37-recording-'));
  const recorder = new Recorder({ dataDir: root, sessionId: 's', target: 'skeleton' });
  recorder.start(); recorder.row(...Object.values(sample()), 1); recorder.row(...Object.values(sample()), 2); recorder.setLabel('good'); recorder.stop();
  const lines = fs.readFileSync(recorder.path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2); assert.deepEqual(lines.map((row) => row.label), ['good', 'good']);
});

async function recordingRuntime(t, entity = null) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1000 });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent37-recording-runtime-'));
  const bot = Object.assign(new EventEmitter(), { entity, health: 20 });
  const runtime = await createRuntime({ bot, dataDir, session: 'test', webPort: 0 });
  t.after(async () => {
    const closed = once(runtime.server, 'close');
    runtime.close();
    await closed;
    assert.equal(runtime.recorder.fd, null, 'shutdown closes the recording file');
  });
  return { bot, runtime, recorder: runtime.recorder };
}

const readRows = (recorder) => fs.readFileSync(recorder.path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);

test('a newly spawned bot automatically records 20 fresh observations per second', async (t) => {
  const { bot, runtime, recorder } = await recordingRuntime(t);
  t.mock.timers.tick(1000);
  assert.equal(recorder.path, null, 'no encounter before spawn');
  bot.entity = { position: { x: 0, y: 64, z: 0 } };
  bot.emit('spawn');
  assert.equal(recorder.state, 'recording');
  assert.equal(runtime.state().spawned, true);
  for (let i = 0; i < 20; i++) {
    bot.entity.position.x = i;
    t.mock.timers.tick(50);
  }
  const rows = readRows(recorder);
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.map(row => row.tick), Array.from({ length: 20 }, (_, i) => i));
  assert.deepEqual(rows.map(row => row.observation.self.position.x), Array.from({ length: 20 }, (_, i) => i));
  assert.deepEqual(rows.slice(1).map((row, i) => row.timestamp_ms - rows[i].timestamp_ms), Array(19).fill(50));

  recorder.pause();
  bot.emit('spawn');
  t.mock.timers.tick(500);
  assert.equal(recorder.state, 'paused', 'respawn preserves a manual pause');
  assert.equal(readRows(recorder).length, 20);
  recorder.resume();
  t.mock.timers.tick(50);
  assert.equal(readRows(recorder).length, 1);
  bot.emit('end');
  assert.equal(recorder.state, 'stopped');
  assert.equal(recorder.fd, null);
  recorder.start();
  t.mock.timers.tick(1000);
  assert.equal(readRows(recorder).length, 0, 'manual Start cannot record a disconnected bot');
});

test('an already spawned bot records automatically and respects manual Stop', async (t) => {
  const { bot, recorder } = await recordingRuntime(t, { position: { x: 5, y: 64, z: 0 } });
  t.mock.timers.tick(50);
  assert.equal(recorder.state, 'recording');
  assert.equal(readRows(recorder).length, 1);
  recorder.stop();
  bot.emit('spawn');
  t.mock.timers.tick(1000);
  assert.equal(recorder.state, 'stopped');
  assert.equal(readRows(recorder).length, 1);
});
