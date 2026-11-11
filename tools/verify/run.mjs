import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const started = performance.now();
function run(label, command, args, cwd = root) {
  console.log(`\nVERIFY: ${label}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) {
    console.error(`VERIFY FAIL: ${label}${result.error ? ` (${result.error.message})` : ''}`);
    process.exit(result.status || 1);
  }
}
function npm(label, args) {
  // npm supplies its JS entry point on both Windows and Unix; no shell needed.
  if (!process.env.npm_execpath) throw new Error('Run this script with npm run verify.');
  run(label, process.execPath, [process.env.npm_execpath, ...args], path.join(root, 'bridge'));
}

npm('Install bridge dependencies', ['ci', '--no-audit', '--no-fund']);
const tracked = spawnSync('git', ['ls-files', '-z', '*.js', '*.mjs'], { cwd: root, encoding: 'utf8' });
if (tracked.status !== 0) throw new Error('Cannot list tracked JavaScript files.');
for (const file of tracked.stdout.split('\0').filter(Boolean)) run(`Syntax: ${file}`, process.execPath, ['--check', file]);
npm('Bridge tests', ['test']);
npm('Bridge smoke test', ['run', 'smoke']);
const bench = path.join(root, 'bridge/bench');
if (!existsSync(bench)) console.log('SKIP: bridge/bench does not exist.');
else {
  for (const file of readdirSync(bench).filter(name => name.endsWith('.mjs')).sort()) {
    const args = [path.join(bench, file), '--ci'];
    if (file === 'latency.mjs') args.push('--steps', '200');
    run(`Quick benchmark: ${file}`, process.execPath, args);
  }
}
if (!existsSync(path.join(root, 'ml'))) console.log('SKIP: ml does not exist.');
else run('Python tests', process.env.A37_VERIFY_PYTHON || 'python', ['-m', 'pytest', 'ml']);
run('Scanner tests', process.execPath, ['--test', 'tools/verify/scan-secrets.test.js']);
console.log(`\nVerification checks completed in ${((performance.now() - started) / 1000).toFixed(1)}s; running final secrets scan.`);
run('Secrets scan', process.execPath, ['tools/verify/scan-secrets.mjs']);
