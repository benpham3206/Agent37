const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const scanner = import('./scan-secrets.mjs');
const address = [192, 0, 2, 37].join('.');
const passwordLine = value => ['password', value].join('=');

test('detects prohibited content with locations and without exposing values', async () => {
  const { scanText } = await scanner;
  const findings = scanText('notes.md', `safe\nserver=${address}\n${passwordLine('made-up-test-value')}\nhttps://${'demo'}.ngrok-free.app`);
  assert.deepEqual(findings.map(({ line, type }) => [line, type]), [[2, 'IPv4 address'], [3, 'password assignment'], [4, 'tunnel URL']]);
  assert.ok(!JSON.stringify(findings).includes(address));
});

test('allows example files, empty passwords, and explicit placeholders', async () => {
  const { scanText } = await scanner;
  assert.deepEqual(scanText('config.env.example', `server=${address}\n${passwordLine('sample')}`), []);
  assert.deepEqual(scanText('notes.md', ['""', '<YOUR_PASSWORD>', '${PASSWORD}', 'CHANGEME'].map(passwordLine).join('\n') + '\nserver=0.0.0.0'), []);
  assert.deepEqual(scanText('image.bin', `\0${address}`), []);
  assert.deepEqual(scanText('notes.md', 'version=999.999.999.999'), []);
  assert.deepEqual(scanText('code.js', `const ${passwordLine('env.A37_RCON_PASSWORD')} || readPassword();\nfunction check(${passwordLine('process.env.A37_RCON_PASSWORD')}) {}`), []);
});

test('allows all loopback addresses while rejecting other IPv4 ranges', async () => {
  const { scanText } = await scanner;
  for (const octets of [[127, 0, 0, 1], [127, 12, 34, 56], [127, 255, 255, 255]]) {
    assert.deepEqual(scanText('config.txt', octets.join('.')), []);
  }
  for (const octets of [[126, 0, 0, 1], [128, 0, 0, 1], [192, 168, 1, 1]]) {
    assert.deepEqual(scanText('config.txt', octets.join('.')).map(finding => finding.type), ['IPv4 address']);
  }
});

test('CLI scans tracked files only and returns failure until a finding is removed', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent37-scan-'));
  const script = path.join(__dirname, 'scan-secrets.mjs');
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    writeFileSync(path.join(directory, 'tracked.md'), 'safe\n');
    execFileSync('git', ['add', 'tracked.md'], { cwd: directory });
    writeFileSync(path.join(directory, 'untracked.md'), address);
    // Copy the standalone scanner into the fixture's expected tools/verify location.
    const { mkdirSync, copyFileSync } = require('node:fs');
    mkdirSync(path.join(directory, 'tools/verify'), { recursive: true });
    const fixtureScript = path.join(directory, 'tools/verify/scan-secrets.mjs');
    copyFileSync(script, fixtureScript);
    const run = () => spawnSync(process.execPath, [fixtureScript], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    writeFileSync(path.join(directory, 'tracked.md'), `safe\n${address}\n`);
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /tracked\.md:2: IPv4 address/);
    assert.ok(!failed.stderr.includes(address));
    writeFileSync(path.join(directory, 'tracked.md'), 'safe\n');
    assert.equal(run().status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
