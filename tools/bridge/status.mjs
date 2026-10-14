// Status snapshot + HUD for the Agent-37 bridge bot. Served on 127.0.0.1:8766:
//   GET /status  -> JSON (health, food, saturation, armor, held item, inventory)
//   GET /hud.js  -> overlay script the proxy injects into the control page
//   POST /kit    -> localhost-only test helper: gives a demo kit in creative mode (not proxied)
import http from 'http';

const ARMOR = { 5: 'head', 6: 'chest', 7: 'legs', 8: 'feet' };
function item(it) {
  if (!it) return null;
  const o = { slot: it.slot, name: it.name, count: it.count };
  const max = it.maxDurability;
  if (max) { const used = it.durabilityUsed ?? 0; o.durability = { left: max - used, max }; }
  return o;
}
// Chat: every chat/system message the bot receives, last 100 kept.
const chatLog = []; let chatBot = null;
export function attachChat(bot) {
  chatBot = bot;
  bot.on('message', (msg, position, sender) => {
    if (bot !== chatBot) return;
    const name = sender ? Object.values(bot.players ?? {}).find(p => p.uuid === sender)?.username ?? null : null;
    chatLog.push({ ts: Date.now(), type: position === 'system' || position === 'game_info' ? position : 'chat', sender: name, text: msg.toString() });
    if (chatLog.length > 100) chatLog.shift();
  });
}
export function snapshot(bot) {
  if (!bot?.entity) return { online: false };
  const slots = bot.inventory.slots;
  return {
    online: true, username: bot.username, game_mode: bot.game?.gameMode,
    health: bot.health, food: bot.food, saturation: bot.foodSaturation,
    position: bot.entity.position, held_item: item(bot.heldItem), quick_bar_slot: bot.quickBarSlot,
    armor: Object.fromEntries(Object.entries(ARMOR).map(([s, k]) => [k, item(slots[s])])),
    offhand: item(slots[45]),
    chat: chatLog.slice(-30),
    inventory: slots.map(item).filter(Boolean).filter(i => !(i.slot in ARMOR) && i.slot !== 45),
  };
}

const HUD = `(() => {
  const P = window.A37_PREFIX || ''; // set by the proxy when the page lives under /<name>/
  const css = document.createElement('style'); css.textContent = \`
  #a37hud,#a37chatbox{position:fixed;left:8px;z-index:9999;background:rgba(0,0,0,.6);color:#fff;font:12px monospace;padding:6px;border-radius:6px;width:300px;box-sizing:border-box;pointer-events:none}#a37hud{top:8px;overflow:hidden}#a37chatbox{bottom:8px}
  #a37hud .bar{height:8px;background:#333;margin:2px 0 6px;border-radius:3px;overflow:hidden}#a37hud .bar i{display:block;height:100%}
  #a37hud .grid{display:grid;grid-template-columns:repeat(9,1fr);gap:2px}#a37hud .c{background:#222;height:30px;font-size:9px;overflow:hidden;padding:1px;border:1px solid #444}
  #a37hud .c.held{border-color:#ff0}#a37chat{height:120px;overflow-y:auto;pointer-events:auto;background:#111;padding:2px;white-space:pre-wrap;word-break:break-word}#a37say{width:100%;box-sizing:border-box;pointer-events:auto;margin-top:2px;background:#222;color:#fff;border:1px solid #555;font:12px monospace}\`; document.head.appendChild(css);
  const hud = document.createElement('div'); hud.id = 'a37hud'; document.body.appendChild(hud);
  const el = document.createElement('div'); hud.appendChild(el);
  const box = document.createElement('div'); box.id = 'a37chatbox'; document.body.appendChild(box);
  const chat = document.createElement('div'); chat.id = 'a37chat'; box.appendChild(chat);
  const say = document.createElement('input'); say.id = 'a37say'; say.placeholder = 'T / Enter to chat, Esc to cancel'; box.appendChild(say);
  // Stats top-left and chat bottom-left of the bot view (falls back to the window).
  function place() {
    const v = document.getElementById('overlay') || document.getElementById('viewer');
    const r = v && v.getBoundingClientRect().width > 0 ? v.getBoundingClientRect() : { left: 0, top: 0, bottom: innerHeight, height: innerHeight, width: innerWidth };
    const w = Math.min(300, Math.max(160, r.width - 16)) + 'px';
    const chatH = Math.max(40, Math.min(120, r.height * 0.3));
    chat.style.height = chatH + 'px';
    hud.style.width = box.style.width = w;
    hud.style.left = box.style.left = (r.left + 8) + 'px';
    hud.style.top = (r.top + 8) + 'px';
    box.style.bottom = (innerHeight - r.bottom + 8) + 'px';
    hud.style.maxHeight = Math.max(60, r.height - chatH - 60) + 'px'; // never runs into the chat box
  }
  addEventListener('resize', place); addEventListener('scroll', place, true); place();
  for (const ev of ['keydown', 'keyup', 'keypress']) say.addEventListener(ev, e => e.stopPropagation()); // don't drive the bot while typing
  // Minecraft-style chat: T or Enter opens the box, Enter sends (empty Enter just closes), Esc cancels.
  const closeChat = () => { say.value = ''; say.blur(); };
  say.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const t = say.value.trim(); if (t) fetch(P + '/chat', { method: 'POST', body: JSON.stringify({ text: t }) }); closeChat(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
  });
  window.addEventListener('keydown', e => {
    if (e.target === say || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return; // other page fields keep their keys
    if (e.code !== 'KeyT' && e.key !== 'Enter') return;
    e.preventDefault(); e.stopImmediatePropagation(); // page never sees it, and the T is not typed into the box
    // Leaving pointer lock makes the page release every control (sends a neutral action); click the view to drive again.
    if (document.pointerLockElement) document.exitPointerLock();
    say.focus();
  }, true);
  const esc = t => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  let lastChat = '';
  const bar = (v, max, color) => '<div class=bar><i style="width:' + Math.max(0, Math.min(100, 100 * v / max)) + '%;background:' + color + '"></i></div>';
  const short = n => n.replace(/_/g, ' ');
  const cell = (it, held) => '<div class="c' + (held ? ' held' : '') + '" title="' + (it ? it.name : '') + '">' + (it ? short(it.name).slice(0, 14) + ' ' + it.count + (it.durability ? '<br>' + it.durability.left + '/' + it.durability.max : '') : '') + '</div>';
  async function tick() {
    try {
      const s = await (await fetch(P + '/status', { cache: 'no-store' })).json();
      if (!s.online) { el.textContent = 'bot offline'; return; }
      let h = 'HP ' + s.health + '/20' + bar(s.health, 20, '#e33') + 'Food ' + s.food + '/20 (sat ' + (s.saturation ?? 0).toFixed(1) + ')' + bar(s.food, 20, '#c83');
      for (const k of ['head', 'chest', 'legs', 'feet']) { const a = s.armor[k]; h += k + ': ' + (a ? short(a.name) + (a.durability ? ' ' + a.durability.left + '/' + a.durability.max : '') : '-') + (a && a.durability ? bar(a.durability.left, a.durability.max, '#5af') : '<br>'); }
      const by = Object.fromEntries(s.inventory.map(i => [i.slot, i]));
      h += 'hotbar<div class=grid>'; for (let i = 36; i <= 44; i++) h += cell(by[i], i - 36 === s.quick_bar_slot); h += '</div>main<div class=grid>';
      for (let i = 9; i <= 35; i++) h += cell(by[i]); h += '</div>offhand: ' + (s.offhand ? short(s.offhand.name) : '-');
      el.innerHTML = h;
      const lines = (s.chat || []).map(m => new Date(m.ts).toLocaleTimeString() + ' ' + (m.sender ? '<' + m.sender + '> ' : '') + m.text).join('\\n');
      if (lines !== lastChat) { const atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 5; chat.innerHTML = esc(lines); lastChat = lines; if (atBottom) chat.scrollTop = chat.scrollHeight; }
    } catch { el.textContent = 'status unavailable'; }
  }
  tick(); setInterval(() => { place(); tick(); }, 500);
})();`;

export function serveStatus(getBot, port = 8766) {
  http.createServer(async (req, res) => {
    const bot = getBot();
    if (req.url.startsWith('/status')) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(snapshot(bot))); }
    if (req.url.startsWith('/chat') && req.method === 'GET') {
      const since = Number(new URL(req.url, 'http://x').searchParams.get('since') ?? 0);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(chatLog.filter(m => m.ts > since)));
    }
    if (req.url === '/chat' && req.method === 'POST') { // send box: {"text": "..."} -> bot.chat
      let body = ''; for await (const c of req) body += c;
      try { const t = String(JSON.parse(body).text ?? '').slice(0, 256); if (!t || !bot?.entity) throw 0; bot.chat(t); res.writeHead(200); res.end('sent'); } catch { res.writeHead(400); res.end('bad request'); }
      return;
    }
    if (req.url.startsWith('/lookat?') && req.method === 'POST') { const n = new URL(req.url, 'http://x').searchParams.get('name'); const e = bot?.players?.[n]?.entity; if (!e) { res.writeHead(404); return res.end('not visible'); } await bot.lookAt(e.position.offset(0, 1.6, 0), true); res.writeHead(200); return res.end(JSON.stringify({ dist: bot.entity.position.distanceTo(e.position) })); }
    if (req.url.startsWith('/hud.js')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return res.end(HUD); }
    if (req.url === '/kit' && req.method === 'POST') {
      try {
        const Item = (await import('module')).createRequire(process.env.A37_BRIDGE_SERVER)('prismarine-item')(bot.version);
        const id = n => bot.registry.itemsByName[n].id;
        const put = (slot, name, count = 1, used = 0) => { const it = new Item(id(name), count); if (used) it.durabilityUsed = used; return bot.creative.setInventorySlot(slot, it); };
        await put(5, 'iron_helmet', 1, 40); await put(6, 'diamond_chestplate'); await put(7, 'iron_leggings', 1, 100); await put(8, 'leather_boots', 1, 10);
        await put(36, 'diamond_sword', 1, 300); await put(37, 'bow'); await put(38, 'arrow', 32); await put(39, 'cooked_beef', 16); await put(45, 'shield', 1, 50); await put(9, 'oak_log', 64);
        res.writeHead(200); res.end('kit given');
      } catch (e) { res.writeHead(500); res.end(String(e?.stack ?? e)); }
      return;
    }
    res.writeHead(404); res.end();
  }).listen(port, '127.0.0.1');
}







