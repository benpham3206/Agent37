// Runs the original Agent-37 combat bridge (in-repo copy at bridge/) on the dev server, localhost only, with sprint on by default.
import http from 'http';
import { pathToFileURL, fileURLToPath } from 'url';
import { createRequire } from 'module';
import { serveStatus, attachChat } from './status.mjs';
const listen = http.Server.prototype.listen; // prismarine-viewer binds every interface; pin to 127.0.0.1
http.Server.prototype.listen = function (port, ...rest) { return typeof port === 'number' ? listen.call(this, port, '127.0.0.1', ...rest) : listen.call(this, port, ...rest); };
// Path to the Agent-37 combat bridge (bridge/server.js). Defaults to the in-repo copy at ../../bridge/server.js.
const src = process.env.A37_BRIDGE_SERVER || fileURLToPath(new URL('../../bridge/server.js', import.meta.url));
process.env.A37_BRIDGE_SERVER = src;

// Sprint by default. The page only sends sprint while Ctrl is held, and the bridge re-sets every control
// (sprint=false included) 20x a second, so wrap setControlState once mineflayer's plugins have loaded.
const mineflayer = createRequire(src)('mineflayer');
const createBot = mineflayer.createBot;
let currentBot = null;
mineflayer.createBot = (...a) => {
  const b = createBot(...a); currentBot = b; attachChat(b);
  // exit when kicked or disconnected so start-team.ps1's loop starts a fresh process (fresh chunks too)
  b.on('kicked', r => console.log('kicked', JSON.stringify(r))); b.on('end', r => { console.log('ended', r); setTimeout(() => process.exit(1), 500); });
  b.once('login', () => {
    const atk = b.attack.bind(b); b.attack = (e, ...r) => { if (e?.id === lastHit.id && Date.now() - lastHit.at < 300) return; return atk(e, ...r); };
    // the bridge adds mouse deltas to pitch without a limit; keep it between straight up and straight down
    const look = b.look.bind(b); b.look = (yaw, pitch, ...r) => look(yaw, Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)), ...r);
    const set = b.setControlState.bind(b);
    // Auto-jump: walking into a 1-block step stalls mineflayer (no autojump), so hop when blocked while moving.
    let autoJumpUntil = 0;
    b.on('physicsTick', () => {
      const c = b.controlState, moving = c.forward || c.back || c.left || c.right;
      if (moving && b.entity.onGround && b.entity.isCollidedHorizontally && Date.now() > autoJumpUntil) { autoJumpUntil = Date.now() + 250; set('jump', true); }
      else if (c.jump && Date.now() > autoJumpUntil && autoJumpUntil) { autoJumpUntil = 0; set('jump', false); }
    });
    b.setControlState = (k, v) => {
      if (k === 'sprint' && !v && b.controlState.forward && !b.controlState.sneak) return; // keep sprinting while W is held
      if (k === 'jump' && !v && Date.now() < autoJumpUntil) return; // auto-jump in progress
      set(k, v);
      if (k === 'forward' && v && !b.controlState.sneak) set('sprint', true);
    };
  });
  return b;
};

// Mouse look 1.3x: scale the page's yaw/pitch deltas when the human driver's action reaches the arbiter.
const LOOK = 1.3;
// Left click like Minecraft. The bridge only hits its own combat target, so the launcher handles clicks:
// new press -> attack the entity under the crosshair (3.5 blocks); if none, dig the block at the cursor
// (4.5 blocks) while held, re-targeting when the view moves, one block per 250 ms in creative.
let lastHit = { id: null, at: 0 };
const click = { held: false, seen: 0, mode: null, digging: null, lastDug: 0 };
function onAttackInput(down) {
  const b = currentBot; if (!b?.entity) return;
  click.seen = Date.now();
  if (down && !click.held) {
    const e = b.entityAtCursor?.(3.5);
    if (e) { click.mode = 'attack'; lastHit = { id: e.id, at: Date.now() }; b.attack(e); console.log('click attack', e.username ?? e.name, e.id); }
    else { click.mode = 'dig'; if (!b.blockAtCursor(4.5)) b.swingArm('right'); }
  }
  if (!down && click.held) stopDig();
  click.held = down;
}
function stopDig() { const b = currentBot; if (click.digging) { try { b?.stopDigging(); } catch {} click.digging = null; } click.mode = null; }
setInterval(() => {
  const b = currentBot;
  if (!click.held || click.mode !== 'dig' || !b?.entity) return;
  if (Date.now() - click.seen > 600) { click.held = false; return stopDig(); } // driver went away without a release
  const blk = b.blockAtCursor(4.5);
  const key = blk && blk.name !== 'air' ? blk.position.toString() : null;
  if (click.digging && click.digging !== key) { try { b.stopDigging(); } catch {} click.digging = null; }
  if (!key || click.digging || Date.now() - click.lastDug < 250) return;
  if (click.lastKey === key && Date.now() - click.lastDug < 1000) return; // never re-dig a block the server may already have broken
  click.digging = key;
  const pos = blk.position.clone(), name = blk.name;
  b.dig(blk, 'ignore').then(async () => {
    click.lastDug = Date.now(); click.lastKey = key;
    await b.waitForTicks(4);
    const now = b.blockAt(pos)?.name;
    if (now && now !== 'air') console.log('dig desync?', name, key, 'client now shows', now); else console.log('dug', name, key);
  }).catch(e => console.log('dig failed', key, e.message)).finally(() => { if (click.digging === key) click.digging = null; });
}, 50);const { ActionArbiter } = await import(pathToFileURL(src.replace('server.js', 'arbiter.js')).href);
const arbSet = ActionArbiter.prototype.set;
ActionArbiter.prototype.set = function (source, action, ...rest) {
  if (source === 'human' && action) action = { ...action, yaw_delta: (action.yaw_delta || 0) * LOOK, pitch_delta: (action.pitch_delta || 0) * LOOK };
  if (source === 'human' && action) onAttackInput(!!action.attack);
  return arbSet.call(this, source, action, ...rest);
};
// Human driving: Agent-37's terrain guard (arbiter.js) clears forward/back/left/right whenever the next support
// cell looks like a drop, so at block edges the bot stutters at cm/s. Skip that guard while a person drives
// (combat skills keep it). Also keep the arbiter's 2-minute session timeout from cutting off a human driver.
const arbTick = ActionArbiter.prototype.tick;
ActionArbiter.prototype.tick = function (args = {}) {
  const human = this.sources.get('human');
  if (human && Date.now() - human.at < 600 && !this.sources.has('skill') && !this.sources.has('mimic')) { this.started = Date.now(); args = { ...args, terrain: null }; }
  return arbTick.call(this, args);
};
const { createRuntime } = await import(pathToFileURL(src).href);
// One process per bot. Settings come from env (defaults = the original ReplayBot setup).
const E = process.env;
const BOT = E.A37_BOT || 'ReplayBot', WEB = +(E.A37_WEB_PORT || 8765), VIEW = +(E.A37_VIEWER_PORT || 3009), STAT = +(E.A37_STATUS_PORT || 8766);
// HUD on the direct control page too: wrap the bridge's own HTTP server (only the one created inside createRuntime)
// so /status, /chat, /hud.js go to this bot's status port and the page HTML gets the HUD script.
const origCreate = http.createServer; let wrapBridge = true;
http.createServer = function (...args) {
  const i = args.findIndex(a => typeof a === 'function');
  if (wrapBridge && i >= 0 && typeof args[i].use !== 'function') {
    const handler = args[i];
    args[i] = (req, res) => {
      const path = req.url.split('?')[0];
      if (/^\/(status|chat|hud\.js)$/.test(path)) {
        const up = http.request({ host: '127.0.0.1', port: STAT, method: req.method, path: req.url, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
        up.on('error', () => { res.writeHead(502); res.end('status down'); }); return req.pipe(up);
      }
      if (path === '/' || path === '/index.html') {
        const end = res.end.bind(res), write = res.write.bind(res), chunks = [];
        res.write = c => { chunks.push(Buffer.from(c)); return true; };
        res.end = (c, ...r) => { if (c) chunks.push(Buffer.from(c)); let body = Buffer.concat(chunks).toString('utf8');
          if (!body.includes('/hud.js')) body = body.replace('</body>', '<script src="/hud.js"></script></body>');
          if (!res.headersSent) res.removeHeader('content-length'); return end(body); };
      }
      return handler(req, res);
    };
  }
  return origCreate.apply(this, args);
};
await createRuntime({ host: E.A37_MC_HOST || 'localhost', port: +(E.A37_MC_PORT || 25565), username: BOT, webPort: WEB, viewerPort: VIEW,
  dataDir: E.A37_DATA_DIR || new URL(`./bridge-data/${BOT}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), session: 'devserver-test', target: 'zombie', environment: 'open_surface' });
wrapBridge = false; http.createServer = origCreate;
serveStatus(() => currentBot, STAT);
console.log(`${BOT}: control http://localhost:${WEB}  viewer http://localhost:${VIEW}  status http://localhost:${STAT}/status`);










