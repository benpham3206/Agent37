import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-recording.mjs', import.meta.url));
const fixturePath = name => fileURLToPath(new URL(`./fixtures/${name}.jsonl`, import.meta.url));
const fixture = name => fs.readFileSync(fixturePath(name), 'utf8');
const check = (...args) => spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' });
function checkText(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent37-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'encounter.jsonl'); fs.writeFileSync(file, text);
  return check(file);
}
function bad(result, pattern) { assert.equal(result.status, 1, result.stdout + result.stderr); assert.match(result.stderr, pattern); assert.doesNotMatch(result.stdout, /OK/); }

test('CLI dispatches v1 and v2 fixtures and prints OK <version> <row count>', () => {
  for (const [name, expected] of [['v1', 'OK 1 1\n'], ['v2-unknown', 'OK 2 1\n'], ['v2-human', 'OK 2 2\n']]) {
    const result = check(fixturePath(name));
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, expected); assert.equal(result.stderr, '');
  }
});

test('every required key is checked for its schema version on every row', t => {
  for (const name of ['v1', 'v2-unknown']) {
    const valid = JSON.parse(fixture(name));
    for (const key of Object.keys(valid)) {
      const invalid = { ...valid }; delete invalid[key];
      bad(checkText(t, `${JSON.stringify(valid)}\n${JSON.stringify(invalid)}\n`), new RegExp(`row 2:.*${key}`));
    }
  }
});

test('empty, malformed, blank, and non-object rows are reported without skipping', t => {
  bad(check(fixturePath('empty')), /row 1:.*empty encounter/i);
  bad(check(fixturePath('malformed')), /row 1:.*malformed JSON/i);
  for (const text of ['\n', '   ', 'null\n', '[]\n', '42\n']) bad(checkText(t, text), /row 1:/);
  bad(checkText(t, fixture('v1') + '\n' + fixture('v1')), /row 2:.*blank/i);
  bad(checkText(t, fixture('v1') + '{broken}\n' + '{also-broken}\n'), /row 2:.*malformed JSON.*\{broken\}/i);
  const first = checkText(t, fixture('v1') + '{broken}\n' + '{also-broken}\n');
  assert.doesNotMatch(first.stderr, /row 3|also-broken/);
});

test('unsupported and mixed versions fail at the first offending row', t => {
  for (const schema_version of [0, 3, '2', null]) {
    bad(checkText(t, JSON.stringify({ ...JSON.parse(fixture('v1')), schema_version })), /row 1:.*schema_version/);
  }
  bad(checkText(t, fixture('v1') + fixture('v2-unknown')), /row 2:.*schema_version/);
});

test('v2 types and teacher-only controller identity are enforced', t => {
  const row = JSON.parse(fixture('v2-unknown'));
  for (const [key, values] of Object.entries({ server_time_ms: [-1, 1.5, '1000', false], agent_name: ['', ' ', 2, {}], controller_id: ['', ' ', 2, {}] })) {
    for (const value of values) bad(checkText(t, JSON.stringify({ ...row, [key]: value })), new RegExp(`row 1:.*${key}`));
  }
  bad(checkText(t, JSON.stringify({ ...row, controller_id: 'connection-a' })), /row 1:.*controller_id/);
  for (const server_time_ms of [0, 1000, null]) {
    const result = checkText(t, JSON.stringify({ ...row, server_time_ms })); assert.equal(result.status, 0, result.stderr);
  }
});

test('normal trailing newline, CRLF, and no trailing newline are accepted', t => {
  for (const text of [fixture('v2-human'), fixture('v2-human').trimEnd(), fixture('v2-human').replaceAll('\n', '\r\n')]) {
    const result = checkText(t, text); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'OK 2 2\n');
  }
});

test('missing arguments, extra arguments, and unreadable files fail cleanly', () => {
  bad(check(), /usage:.*check-recording\.mjs.*file\.jsonl/i);
  bad(check(fixturePath('v1'), 'extra'), /usage:/i);
  bad(check(fixturePath('does-not-exist')), /cannot read/i);
});
