import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recorder } from './recording.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

const v1Keys = ['schema_version', 'session_id', 'encounter_id', 'tick', 'timestamp_ms', 'server_tick', 'source', 'recording_state', 'label', 'observation', 'teacher_action', 'applied_action', 'arbiter'];
const v2Keys = [...v1Keys, 'server_time_ms', 'agent_name', 'controller_id'];
function recording(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent37-v2-'));
  const recorder = new Recorder({ dataDir, sessionId: 's', target: 'zombie', ...options });
  t.after(() => { recorder.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return recorder;
}
function rows(recorder) { return fs.readFileSync(recorder.path, 'utf8').trim().split('\n').map(JSON.parse); }
function metadata(recorder) { return JSON.parse(fs.readFileSync(path.join(recorder.sessionDir, 'session.json'), 'utf8')); }

test('v2 adds exactly the three fields and preserves all v1 values and clocks', (t) => {
  const recorder = recording(t);
  assert.equal(metadata(recorder).schema_version, 2);
  assert.equal(metadata(recorder).agent_name, null);
  assert.deepEqual(Object.keys(metadata(recorder)).sort(), ['schema_version', 'session_id', 'target', 'source', 'environment_suite', 'environment_label', 'notes', 'created_at', 'agent_name'].sort());
  assert.equal(recorder.row(...Object.values(sample()), 123), false);
  recorder.start();
  recorder.row({ time: { timeOfDay: 6000, age: 1000 } }, { forward: true }, { attack: true }, { source: 'teacher', reason: 'teacher' }, 123);
  recorder.row(...Object.values(sample()));
  recorder.stop();
  const [first, second] = rows(recorder);
  assert.deepEqual(Object.keys(first).sort(), v2Keys.slice().sort());
  assert.equal(first.schema_version, 2);
  assert.equal(first.session_id, recorder.sessionId);
  assert.equal(first.encounter_id, recorder.encounterId);
  assert.equal(first.tick, 0); assert.equal(second.tick, 1);
  assert.equal(first.timestamp_ms, 123); assert.equal(typeof second.timestamp_ms, 'number');
  assert.equal(first.server_tick, null); assert.equal(first.server_time_ms, null);
  assert.equal(second.server_time_ms, null);
  assert.equal(first.source, 'privileged_hitbox'); assert.equal(metadata(recorder).source, 'human');
  assert.equal(first.recording_state, 'recording'); assert.equal(first.label, 'unlabelled');
  assert.deepEqual(first.observation, { time: { timeOfDay: 6000, age: 1000 } });
  assert.deepEqual(first.teacher_action, { forward: true }); assert.deepEqual(first.applied_action, { attack: true });
  assert.deepEqual(first.arbiter, { source: 'teacher', reason: 'teacher' });
  assert.equal(first.agent_name, null); assert.equal(first.controller_id, null);
});

test('connected username wins, configured username is fallback, and changes split sessions', (t) => {
  const recorder = recording(t);
  recorder.start();
  const identities = [
    [{ agentName: 'ConnectedBot', configuredUsername: 'ConfiguredBot' }, 'ConnectedBot'],
    [{ agentName: 'ConnectedBot', configuredUsername: 'DifferentConfig' }, 'ConnectedBot'],
    [{ agentName: '', configuredUsername: 'ConfiguredBot' }, 'ConfiguredBot'],
    [{ agentName: null, configuredUsername: 'ConfiguredBot' }, 'ConfiguredBot'],
    [{ agentName: ' ', configuredUsername: '' }, null],
  ];
  let previous = null, previousName;
  for (const [identity, expected] of identities) {
    recorder.row(...Object.values(sample()), 100, identity);
    assert.equal(metadata(recorder).agent_name, expected);
    assert.equal(rows(recorder).at(-1).agent_name, expected);
    assert.equal(metadata(recorder).session_id, recorder.sessionId);
    if (previous && previousName !== expected) {
      assert.notEqual(recorder.sessionDir, previous);
      const oldSession = JSON.parse(fs.readFileSync(path.join(previous, 'session.json')));
      assert.equal(oldSession.agent_name, previousName);
      for (const file of fs.readdirSync(path.join(previous, 'encounters'))) {
        const text = fs.readFileSync(path.join(previous, 'encounters', file), 'utf8');
        for (const line of text.trim().split('\n').filter(Boolean)) assert.equal(JSON.parse(line).agent_name, previousName);
      }
      assert.equal(rows(recorder)[0].tick, 0);
    }
    if (previous && previousName === expected) assert.equal(recorder.sessionDir, previous);
    previous = recorder.sessionDir; previousName = expected;
  }
});

test('existing sessions and v1 datasets are preserved in place', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent37-historical-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const oldDir = path.join(dataDir, 's');
  fs.mkdirSync(path.join(oldDir, 'encounters'), { recursive: true });
  const historical = '{"schema_version":1,"session_id":"s","source":"human"}\n';
  fs.writeFileSync(path.join(oldDir, 'session.json'), historical);
  const fixture = fs.readFileSync(new URL('./ml/fixtures/v1.jsonl', import.meta.url));
  fs.writeFileSync(path.join(oldDir, 'encounters', 'old.jsonl'), fixture);
  const recorder = new Recorder({ dataDir, sessionId: 's', target: 'zombie' });
  t.after(() => recorder.stop());
  recorder.start(); recorder.row(...Object.values(sample()), 42); recorder.stop();
  assert.notEqual(recorder.sessionDir, oldDir);
  assert.equal(path.basename(recorder.sessionDir), recorder.sessionId);
  assert.equal(metadata(recorder).schema_version, 2);
  assert.equal(rows(recorder)[0].schema_version, 2);
  assert.equal(fs.readFileSync(path.join(oldDir, 'session.json'), 'utf8'), historical);
  assert.deepEqual(fs.readFileSync(path.join(oldDir, 'encounters', 'old.jsonl')), fixture);
  const next = new Recorder({ dataDir, sessionId: recorder.sessionId, target: 'zombie' });
  assert.notEqual(next.sessionDir, recorder.sessionDir);
  next.stop();
});

test('controller identity follows supplied lease holders, reconnects, and overrides through relabels', (t) => {
  const recorder = recording(t);
  recorder.start();
  const samples = [
    ['teacher', 'connection-a', 'connection-a'],
    ['teacher', 'connection-b', 'connection-b'], // takeover
    ['teacher', 'connection-a-reconnected', 'connection-a-reconnected'],
    ['emergency', 'connection-a-reconnected', null],
    ['survival', 'connection-b', null],
    ['skill', 'connection-b', null],
    ['idle', 'connection-b', null],
    ['human', 'connection-b', null],
    ['teacher', undefined, null],
    ['teacher', '', null],
    ['teacher', { token: 'must-not-be-serialized' }, null],
  ];
  for (const [source, controllerId] of samples) recorder.row({}, {}, {}, { source }, 17, { controllerId });
  recorder.setLabel('good'); recorder.pause(); recorder.setLabel('bad');
  const actual = rows(recorder);
  assert.deepEqual(actual.map(row => row.controller_id), samples.map(([, , expected]) => expected));
  assert.ok(actual.every(row => row.agent_name === null && row.server_time_ms === null && row.label === 'bad'));
  assert.ok(!fs.readFileSync(recorder.path, 'utf8').includes('must-not-be-serialized'));
  recorder.resume(); recorder.row({}, {}, {}, { source: 'teacher' }, 18, { controllerId: 'connection-b' }); recorder.stop();
  assert.equal(rows(recorder)[0].controller_id, 'connection-b'); assert.equal(rows(recorder)[0].tick, 0);
  const checked = spawnSync(process.execPath, [fileURLToPath(new URL('./ml/check-recording.mjs', import.meta.url)), recorder.path], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('runtime row supplies bot/configured identity and an explicit unknown R1 placeholder', async (t) => {
  const { createRuntime } = await import('./server.js');
  for (const [username, expected] of [['ConnectedBot', 'ConnectedBot'], [undefined, 'ConfiguredBot']]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent37-runtime-recording-'));
    const runtime = await createRuntime({ bot: { username }, username: 'ConfiguredBot', dataDir, session: 's', webPort: 0 });
    try {
      const rowWritten = new Promise((resolve) => {
        const row = runtime.recorder.row.bind(runtime.recorder);
        runtime.recorder.row = (...args) => { const result = row(...args); if (result) resolve(); return result; };
      });
      runtime.arbiter.set('human', { forward: true }, 'teacher');
      runtime.recorder.start();
      await Promise.race([rowWritten, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('no recording row within 2 seconds')), 2000); timer.unref(); })]);
      runtime.recorder.stop();
      const actual = rows(runtime.recorder)[0];
      assert.equal(actual.agent_name, expected); assert.equal(metadata(runtime.recorder).agent_name, expected);
      assert.equal(actual.arbiter.source, 'teacher'); assert.equal(actual.controller_id, null);
      assert.equal(actual.server_time_ms, null);
    } finally {
      runtime.recorder.stop();
      const closed = new Promise(resolve => runtime.server.once('close', resolve));
      runtime.close(); await closed;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});
