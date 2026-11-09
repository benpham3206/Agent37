import { setTimeout as delay } from 'node:timers/promises';
import { aimDelta, angularError } from '../../../geometry.js';

function portalInFrame(observation, frame) {
  const p = observation?.facts?.position;
  const portal = observation?.facts?.nearest_blocks?.nether_portal;
  if (!p || !portal) return false;
  const x = Math.round(p.x + portal.dx), y = Math.round(p.y + portal.dy), z = Math.round(p.z + portal.dz);
  return z === frame.z && x >= frame.x + 1 && x <= frame.x + 2 && y >= frame.y + 1 && y <= frame.y + 3;
}

export function createRun({ tickMs = 50, reach = 4, lightingTimeoutMs = 15000, now = () => performance.now() } = {}) {
  return async function run(bot, input, { signal }) {
    const started = now();
    let before;
    try {
      signal.throwIfAborted();
      before = bot.observe();
      const finish = (outcome, reason) => ({ outcome, reason, elapsed_ms: Math.max(0, now() - started), before, after: bot.observe() });
      const frame = input?.frame;
      if (!frame || !['x', 'y', 'z'].every((k) => Number.isInteger(frame[k]))) return finish('failure', 'requirement_unmet:invalid_frame');
      const slot = before?.self?.hotbar_slot;
      if (before?.self?.health != null && before.self.health <= 0) return finish('failure', 'bot_death');
      if (before?.facts?.dimension !== 'overworld') return finish('failure', 'requirement_unmet:not_overworld');
      if (portalInFrame(before, frame)) return finish('success', 'portal_already_lit');
      if (before?.self?.held_item !== 'flint_and_steel') return finish('failure', 'requirement_unmet:flint_not_held');
      if (!Number.isInteger(slot) || slot < 0 || slot > 8) return finish('failure', 'requirement_unmet:unknown_hotbar');
      const target = { x: frame.x + 1, y: frame.y, z: frame.z, face: { x: 0, y: 1, z: 0 } };
      const point = { x: target.x + 0.5, y: target.y + 1, z: target.z + 0.5 };
      for (;;) {
        signal.throwIfAborted();
        const o = bot.observe();
        if (o?.self?.health != null && o.self.health <= 0) return finish('failure', 'bot_death');
        if (portalInFrame(o, frame)) return finish('success', 'portal_lit');
        if (now() - started >= lightingTimeoutMs) return finish('failure', 'portal_not_lit');
        const self = o?.self?.position;
        const position = o?.facts?.position;
        if (!self || !position || !['x', 'y', 'z'].every((k) => Number.isFinite(self[k]) && Number.isFinite(position[k]))) return finish('failure', 'requirement_unmet:no_position');
        if (!o?.facts?.nearest_blocks?.obsidian) return finish('failure', 'requirement_unmet:no_obsidian');
        const eye = { x: self.x, y: self.y + 1.62, z: self.z };
        if (Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z) <= reach) {
          bot.requestAction({ hotbar: slot, interact: target });
        } else {
          const side = self.z < frame.z + 0.5 ? -1 : 1;
          const stand = { x: point.x, y: eye.y, z: point.z + side * 2 };
          const d = aimDelta(angularError(eye, o.self.yaw ?? 0, o.self.pitch ?? 0, stand));
          bot.requestAction({ hotbar: slot, forward: Math.abs(d.yaw) < 0.06, yaw_delta: d.yaw });
        }
        await delay(tickMs, undefined, { signal });
      }
    } finally {
      bot.releaseControls();
    }
  };
}

export const run = createRun();
