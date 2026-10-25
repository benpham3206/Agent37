import test from 'node:test'; import assert from 'node:assert/strict'; import net from 'node:net';
import { rconCommand } from './rcon.js';
const pkt = (id, type, body) => { const b = Buffer.from(body), p = Buffer.alloc(14 + b.length); p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8); b.copy(p, 12); return p; };
function fakeServer(password, seen) { return net.createServer((s) => { let authed = false; s.on('data', (d) => { const id = d.readInt32LE(4), body = d.toString('utf8', 12, d.readInt32LE(0) + 2);
  if (!authed) { authed = body === password; s.write(pkt(authed ? id : -1, 2, '')); } else { seen.push(body); s.write(pkt(id, 0, 'Set own game mode')); } }); }); }
test('logs in and runs one command against a fake RCON server', async () => { const seen = []; const srv = fakeServer('pw', seen); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  assert.equal(await rconCommand({ port, password: 'pw' }, 'gamemode creative Host_bot'), 'Set own game mode'); assert.deepEqual(seen, ['gamemode creative Host_bot']);
  await assert.rejects(rconCommand({ port, password: 'wrong' }, 'x'), /rcon_auth_failed/); await assert.rejects(rconCommand({ port }, 'x'), /rcon_not_configured/); srv.close(); });
