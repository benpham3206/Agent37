import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry, FIELDS } from './registry.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ 'test.example': 1 }));
  const registry = new SkillRegistry(root);
  const record = (version = 1) => ({
    name: 'test.example', version, implementation: null, requirements: null,
    success_check: null, reset_steps: null, evaluation: null,
  });
  function write(skill) {
    const directory = path.join(root, skill.name, `v${skill.version}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'skill.json'), JSON.stringify(skill));
    return path.join(directory, 'skill.json');
  }
  const evaluation = () => ({
    tested_version: 2, test_settings: { seed: 37001 }, baseline: null,
    trial_count: 20, successes: 16, failures: 3, timeouts: 1,
    human_interventions: 0, synthetic: false, results_link: 'approved-results.json',
  });
  write(record(1));
  write({ ...record(2), evaluation: evaluation() });
  return { root, registry, record, write, evaluation };
}

test('each of the seven fields is required; null is allowed for unknown details', (t) => {
  const { registry, record, write } = fixture(t);
  for (const field of FIELDS) {
    const filename = write(record());
    const skill = record(); delete skill[field];
    fs.writeFileSync(filename, JSON.stringify(skill));
    assert.throws(() => registry.load('test.example', 1), /exactly these fields/);
  }
  write(record());
  assert.deepEqual(registry.load('test.example', 1), record());
});
test('extra fields, invalid field types and directory mismatches fail', (t) => {
  const { registry, record, write } = fixture(t);
  write({ ...record(), extra: true });
  assert.throws(() => registry.load('test.example', 1), /exactly/);
  write({ ...record(), evaluation: 'untested' });
  assert.throws(() => registry.load('test.example', 1), /object or null/);
  const filename = write(record());
  fs.writeFileSync(filename, JSON.stringify(record(2)));
  assert.throws(() => registry.load('test.example', 1), /does not match/);
});
test('get uses active.json, not the newest candidate', (t) => {
  const { registry } = fixture(t);
  assert.equal(registry.get('test.example').version, 1);
  assert.equal(registry.load('test.example', 2).version, 2);
  assert.throws(() => registry.get('test.missing'), /no active version/);
});
test('activation refuses weak, interrupted, synthetic or incomplete results without changing the pointer', (t) => {
  const { registry, record, write, evaluation } = fixture(t);
  for (const changes of [
    { trial_count: 19, successes: 15 },
    { successes: 15, failures: 4 },
    { human_interventions: 1 }, { synthetic: true }, { synthetic: null },
    { synthetic: undefined }, { tested_version: 1 }, { successes: 21 },
    { successes: '16' }, { failures: -1 },
  ]) {
    write({ ...record(2), evaluation: { ...evaluation(), ...changes } });
    assert.throws(() => registry.activate('test.example', 2));
    assert.equal(registry.get('test.example').version, 1);
  }
});
test('activation keeps old versions loadable and supports an evaluated rollback', (t) => {
  const { registry, record, write, evaluation } = fixture(t);
  registry.activate('test.example', 2);
  assert.equal(registry.get('test.example').version, 2);
  assert.equal(registry.load('test.example', 1).version, 1);
  write({ ...record(1), evaluation: { ...evaluation(), tested_version: 1 } });
  registry.activate('test.example', 1);
  assert.equal(registry.get('test.example').version, 1);
  assert.equal(registry.load('test.example', 2).version, 2);
});
test('general gate cannot bypass the combat approval path', (t) => {
  const { registry, record, write, evaluation } = fixture(t);
  write({ ...record(2), requirements: { combat: true }, evaluation: evaluation() });
  assert.throws(() => registry.activate('test.example', 2), /combat approval/);
});
test('names and versions cannot leave the registry', (t) => {
  const { registry, root } = fixture(t);
  for (const name of ['../other', '/tmp/test', 'test/other', '']) assert.throws(() => registry.load(name, 1));
  for (const version of ['../1', '1/other', 0, -1, 1.2, [1]]) assert.throws(() => registry.load('test.example', version));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'a37-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'test.link'));
  fs.symlinkSync(outside, path.join(root, 'test.link', 'v1'), 'dir');
  assert.throws(() => registry.load('test.link', 1), /leaves/);
});
