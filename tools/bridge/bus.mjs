// Tiny message bus for Agent37 bots.
// Bots in this process get messages directly; the same message also goes to in-game chat as
// "[a37] <from> -> <to>: <msg>" so bots started in other processes can hear it too.
import { EventEmitter } from 'events';

const PREFIX = '[a37]';
const RE = /^\[a37\] (\S+) -> (\S+): (.*)$/;
const local = new Map(); // name -> bot
const hub = new EventEmitter();

export function joinBus(bot, onMessage = (m) => console.log(`[${bot.username}] got from ${m.from}: ${m.msg}`)) {
  const name = bot.username;
  local.set(name, bot);
  const deliver = (m) => { if (m.from !== name && (m.to === name || m.to === 'all')) onMessage(m); };
  hub.on('msg', deliver);
  // Chat path: only for senders outside this process (local ones already arrived via the hub).
  bot.on('chat', (username, text) => {
    const m = RE.exec(text);
    if (m && !local.has(m[1])) deliver({ from: m[1], to: m[2], msg: m[3], via: 'chat' });
  });
  bot.once('end', () => { local.delete(name); hub.off('msg', deliver); });
  return {
    send(to, msg) {
      hub.emit('msg', { from: name, to, msg, via: 'local' });
      bot.chat(`${PREFIX} ${name} -> ${to}: ${msg}`.slice(0, 256));
    },
  };
}

