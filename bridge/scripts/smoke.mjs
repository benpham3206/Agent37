// Smoke test: start one bridge headless (no Minecraft server, no secrets) and check its web endpoints answer.
// The bot can't connect, so it stays "connecting"; that's expected. Run: cd bridge && npm run smoke
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webPort = Number(process.env.SMOKE_WEB_PORT ?? 18765);
const dataDir = mkdtempSync(join(tmpdir(), 'a37-smoke-'));
// Port 1 on this machine has no Minecraft server, so the bot's connect fails fast and the bridge keeps serving.
const child = spawn(process.execPath, [join(here, '..', 'server.js'), '--web-port', String(webPort), '--port', '1', '--data-dir', dataDir, '--username', 'SmokeBot'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
let exited = null; child.on('exit', (code) => (exited = code));

const base = `http://127.0.0.1:${webPort}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) { const res = await fetch(base + path, { signal: AbortSignal.timeout(3000) }); return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() }; }
function check(ok, msg) { if (!ok) throw new Error(msg); console.log('ok -', msg); }

let failed = false;
try {
  let status;
  for (let i = 0; i < 40 && !status; i++) {
    if (exited !== null) throw new Error(`bridge exited early with code ${exited}`);
    try { status = await get('/combat/status'); } catch { await sleep(250); }
  }
  check(status, 'bridge answers /combat/status within 10 s');
  check(status.status === 200, `/combat/status returns 200 (got ${status.status})`);
  const json = JSON.parse(status.body);
  check(json.observation && 'self' in json.observation, '/combat/status has an observation');
  check(json.connection?.status === 'connecting', 'bot reports "connecting" with no game server');
  check(json.arbiter !== undefined && json.recording_state !== undefined, '/combat/status has arbiter and recording state');
  check(json.advancements && Array.isArray(json.advancements.done) && json.advancements.known === false, '/combat/status has advancements (unknown before spawn)');
  const page = await get('/');
  check(page.status === 200 && page.type.includes('text/html'), 'control page is served at /');
  const missing = await get('/nope');
  check(missing.status === 404, 'unknown path returns 404');
  await sleep(1500); // let the failed connect settle; the bridge must stay up
  check(exited === null, 'bridge is still running after the bot fails to connect');
  check((await get('/combat/status')).status === 200, '/combat/status still answers');
} catch (err) {
  failed = true; console.error('FAIL -', err.message); console.error('--- bridge log ---\n' + log);
} finally {
  child.kill(); rmSync(dataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
