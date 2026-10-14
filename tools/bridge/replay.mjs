// Replays an Agent-37 combat encounter log (20 Hz JSONL) on a Minecraft server.
// ReplayBot re-does the recorded bot's moves; SparPartner re-does the recorded target's moves.
import fs from 'fs';
import mineflayer from 'mineflayer';
import http from 'http';
import { createRequire } from 'module';
import { joinBus } from './bus.mjs';
const viewer = createRequire(import.meta.url)('prismarine-viewer').mineflayer;
// prismarine-viewer listens on every interface; force it onto localhost only.
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (port, ...rest) { return typeof port === 'number' ? listen.call(this, port, '127.0.0.1', ...rest) : listen.call(this, port, ...rest); };

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && !/^[\d.]+$/.test(a) && !args[args.indexOf(a) - 1]?.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
if (!file) { console.log('usage: node replay.mjs <log.jsonl> [--speed 1] [--host localhost] [--port 25565] [--name ReplayBot] [--no-partner] [--no-viewer] [--no-stay]'); process.exit(1); }
const speed = Number(opt('speed', 1)), host = opt('host', 'localhost'), port = Number(opt('port', 25565)), name = opt('name', 'ReplayBot');
const withPartner = !args.includes('--no-partner');
const withViewer = !args.includes('--no-viewer');
const stay = withViewer ? !args.includes('--no-stay') : args.includes('--stay');

const frames = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const dur = (frames.at(-1).timestamp_ms - frames[0].timestamp_ms) / 1000;
const hasTarget = frames.some(f => f.observation?.target?.position);
console.log(`log: ${frames.length} ticks, ${dur.toFixed(1)}s, target=${frames.find(f => f.observation?.target)?.observation.target.mob_type ?? 'none'}`);

const join = (username) => new Promise((res, rej) => {
  const b = mineflayer.createBot({ host, port, username, auth: 'offline', version: '1.21.1' });
  b.once('spawn', () => res(b)); b.once('error', rej); b.once('kicked', r => rej(new Error('kicked: ' + JSON.stringify(r))));
});

const bot = await join(name);
console.log(`connected as ${name} at ${bot.entity.position}`);
const partner = withPartner && hasTarget ? await join('SparPartner').catch(e => (console.log('partner failed:', e.message), null)) : null;
for (const b of [bot, partner].filter(Boolean)) { b.on('error', e => console.log('error:', e.message)); try { b.creative.startFlying(); } catch {} }

if (withViewer) {
  viewer(bot, { port: 3007, firstPerson: false, viewDistance: 6 });
  if (partner) viewer(partner, { port: 3008, firstPerson: false, viewDistance: 6 });
  console.log('viewer: http://localhost:3007' + (partner ? ' (SparPartner: http://localhost:3008)' : ''));
}
const botBus = joinBus(bot);
const partnerBus = partner && joinBus(partner, (m) => {
  console.log(`[SparPartner] got from ${m.from}: ${m.msg}`);
  if (m.msg === 'engaging') partnerBus.send(m.from, 'ack');
});

// Replay relative to where ReplayBot spawned, so it works in any world.
const anchor = bot.entity.position.clone();
const groundY = anchor.y;
const origin = frames[0].observation.self.position;
const at = p => { const v = anchor.offset(p.x - origin.x, p.y - origin.y, p.z - origin.z); v.y = Math.max(v.y, groundY); return v; };
// The server kicks back moves over ~10 blocks per packet, so big jumps in the log (round resets) are walked over a few ticks.
let clamped = 0;
const moveTo = (b, goal) => { const d = goal.minus(b.entity.position), n = d.norm(); b.entity.position = n > 3 ? (clamped++, b.entity.position.plus(d.scaled(3 / n))) : goal; b.entity.velocity.set(0, 0, 0); };
await bot.waitForTicks(20);

let swings = 0, played = 0, errors = 0;
const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
const t0 = Date.now();
for (let i = 0; i < frames.length; i++) {
  const f = frames[i], s = f.observation.self, a = f.applied_action || {};
  try {
    moveTo(bot, at(s.position));
    // Agent-37 stores yaw/pitch in mineflayer's radians already.
    bot.look(s.yaw, s.pitch, true);
    for (const k of KEYS) bot.setControlState(k, false); // position comes from the log, controls would drift it
    if (a.attack) { bot.swingArm('right'); if (swings++ === 0) botBus.send(partner ? 'SparPartner' : 'all', 'engaging'); }
    const t = f.observation.target;
    if (partner && t?.position) {
      moveTo(partner, at(t.position));
      const d = bot.entity.position.minus(partner.entity.position);
      partner.look(Math.atan2(-d.x, -d.z), 0, true);
    }
  } catch (e) { errors++; if (errors < 5) console.log('tick', i, e.message); }
  played++;
  if (i % 200 === 0) console.log(`tick ${i}/${frames.length} swings=${swings}`);
  const next = frames[i + 1];
  const wait = next ? (next.timestamp_ms - frames[0].timestamp_ms) / speed - (Date.now() - t0) : 0;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}
console.log(`done: played ${played} ticks, ${swings} swings, ${errors} errors, ${clamped} clamped moves, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
botBus.send('all', `stats: ${played} ticks, ${swings} swings, ${errors} errors`);
partnerBus?.send('all', `stats: followed ${played} ticks`);
await new Promise(r => setTimeout(r, 1000));
if (stay) {
  console.log('replay over; bots and viewer stay up. Ctrl+C to exit.');
  process.on('SIGINT', () => { bot.quit(); partner?.quit(); setTimeout(() => process.exit(0), 500); });
} else { bot.quit(); partner?.quit(); setTimeout(() => process.exit(0), 500); }


