import { setTimeout as delay } from 'node:timers/promises';
import { aimDelta, angularError } from '../../../geometry.js';

export function createRun({ tickMs = 50, now = () => performance.now() } = {}) {
  return async function run(bot, input, { signal }) {
    const started = now();
    let before;
    try {
      before = bot.observe();
      const finish = (outcome, reason) => ({ outcome, reason, elapsed_ms: Math.max(0, now() - started), before, after: bot.observe() });
      let target = null;
      for (;;) {
        signal.throwIfAborted();
        const o = bot.observe();
        if (o?.self?.health != null && o.self.health <= 0) return finish('failure', 'bot_death');
        if (o?.facts?.dimension === 'the_nether') return finish('success', 'nether_arrival');
        const self = o?.self?.position;
        const portal = o?.facts?.nearest_blocks?.nether_portal;
        const p = o?.facts?.position;
        if (!self || !p) return finish('failure', 'requirement_unmet:no_position');
        if (!target && portal) target = { x: Math.round(p.x + portal.dx) + 0.5, y: self.y + 1.62, z: Math.round(p.z + portal.dz) + 0.5 };
        if (!target) return finish('failure', 'requirement_unmet:no_portal');
        const distance = Math.hypot(target.x - self.x, target.z - self.z);
        const d = aimDelta(angularError({ x: self.x, y: self.y + 1.62, z: self.z }, o.self.yaw ?? 0, o.self.pitch ?? 0, target));
        bot.requestAction({ forward: distance > 0.13 && Math.abs(d.yaw) < 0.06, sneak: distance < 1, yaw_delta: distance > 0.13 ? d.yaw : 0, pitch_delta: 0 });
        await delay(tickMs, undefined, { signal });
      }
    } finally {
      bot.releaseControls();
    }
  };
}

export const run = createRun();
