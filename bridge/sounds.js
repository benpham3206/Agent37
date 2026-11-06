// Sound sense, like Minecraft's accessibility subtitles: what was heard and
// which way it came from, relative to where the bot faces. Kept short and
// recent so the planner and Jev can react to things out of sight.
const ago = (t, now) => Math.max(0, now - t);
const round = (v) => Math.round(v * 10) / 10;

// "minecraft:entity.zombie.ambient" -> category "entity", source "zombie".
export function soundCategory(name) {
  const parts = String(name ?? '').replace(/^minecraft:/, '').split(/[._]/);
  return parts[0] || null;
}

// Mineflayer yaw: forward is (-sin(yaw), 0, -cos(yaw)), right is (cos(yaw), 0, -sin(yaw)).
export function soundDirection(self, yaw, pos) {
  const dx = pos.x - self.x, dy = pos.y - self.y, dz = pos.z - self.z;
  const fwd = -dx * Math.sin(yaw) - dz * Math.cos(yaw), right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  const flat = Math.hypot(fwd, right);
  let horizontal = null;
  if (flat >= 0.5) horizontal = Math.abs(fwd) >= Math.abs(right) ? (fwd > 0 ? 'front' : 'behind') : (right > 0 ? 'right' : 'left');
  const vertical = dy > 2 ? 'above' : dy < -2 ? 'below' : null;
  return { direction: [horizontal, vertical].filter(Boolean).join(' ') || 'here', distance: round(Math.hypot(dx, dy, dz)) };
}

export function createSoundTracker({ windowMs = 3000, max = 8, now = Date.now } = {}) {
  let heard = [];
  const prune = (t) => { heard = heard.filter((s) => ago(s.at, t) <= windowMs).slice(-max); };
  function hear(name, category, position, source = null) {
    if (!position) return;
    const t = now();
    heard.push({ name: String(name).replace(/^minecraft:/, ''), category, source, position: { x: position.x, y: position.y, z: position.z }, at: t });
    prune(t);
  }
  return {
    hear,
    // Reads the raw sound packets. Mineflayer's soundEffectHeard maps numeric sound ids
    // through minecraft-data, which is off by one on 1.21.1 (a zombie groan comes out as
    // entity.zoglin.step), so for numeric ids we name the sound after the entity standing
    // where it played, and keep the packet's own category (hostile, block, weather...).
    attach(bot) {
      const client = bot?._client;
      if (!client?.on) return this;
      const near = (pos) => {
        let best = null, bestD = 1.5;
        for (const e of Object.values(bot.entities ?? {})) {
          if (!e?.position || e === bot.entity) continue;
          const d = Math.hypot(e.position.x - pos.x, e.position.y - pos.y, e.position.z - pos.z);
          if (d < bestD) { best = e; bestD = d; }
        }
        return best?.name ?? null;
      };
      client.on('sound_effect', (p) => {
        const pos = { x: p.x / 8, y: p.y / 8, z: p.z / 8 };
        const inline = p.sound?.data?.soundName ?? p.soundName ?? null;
        const source = near(pos);
        hear(inline ?? `${p.soundCategory ?? 'sound'}:${source ?? 'unknown'}`, p.soundCategory ?? soundCategory(inline), pos, source);
      });
      client.on('entity_sound_effect', (p) => {
        const e = bot.entities?.[p.entityId];
        if (e?.position) hear(`${p.soundCategory ?? 'sound'}:${e.name ?? 'unknown'}`, p.soundCategory ?? null, e.position, e.name ?? null);
      });
      return this;
    },
    // Newest first, relative to the bot's current position and yaw.
    list(bot) {
      const t = now(); prune(t);
      const p = bot?.entity?.position, yaw = bot?.entity?.yaw;
      return heard.slice().reverse().map((s) => ({ name: s.name, category: s.category, source: s.source, ...(p && yaw != null ? soundDirection(p, yaw, s.position) : { direction: null, distance: null }), age_ms: ago(s.at, t) }));
    },
  };
}
