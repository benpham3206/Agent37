import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recorder } from './recording.js';

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
