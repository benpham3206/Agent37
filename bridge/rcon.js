// Minimal Minecraft RCON client (Source RCON protocol). No dependencies.
import net from 'node:net';
const AUTH = 3, EXEC = 2;
function packet(id, type, body) { const b = Buffer.from(body, 'utf8'), p = Buffer.alloc(14 + b.length); p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8); b.copy(p, 12); return p; }
// Opens a connection, logs in, runs one command, closes. Resolves with the server's reply text.
export function rconCommand({ host = '127.0.0.1', port = 25575, password, timeoutMs = 3000 }, command) {
  return new Promise((resolve, reject) => {
    if (!password) return reject(new Error('rcon_not_configured'));
    const sock = net.connect(Number(port), host); let buf = Buffer.alloc(0), authed = false, done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(t); sock.destroy(); err ? reject(err) : resolve(val); };
    const t = setTimeout(() => finish(new Error('rcon_timeout')), timeoutMs);
    sock.on('error', () => finish(new Error('rcon_unreachable')));
    sock.on('connect', () => sock.write(packet(1, AUTH, password)));
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) { const len = buf.readInt32LE(0); if (buf.length < len + 4) break; const id = buf.readInt32LE(4), body = buf.toString('utf8', 12, len + 2); buf = buf.subarray(len + 4);
        if (!authed) { if (id === -1) return finish(new Error('rcon_auth_failed')); authed = true; sock.write(packet(2, EXEC, command)); }
        else if (id === 2) return finish(null, body); } });
  });
}
