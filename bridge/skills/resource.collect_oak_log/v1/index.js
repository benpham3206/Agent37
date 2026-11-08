import { setTimeout as delay } from 'node:timers/promises';
import { aimDelta, angularError } from '../../../geometry.js';

function logCount(inventory) {
  return Object.entries(inventory ?? {}).reduce((total, [item, count]) =>
    item.endsWith('_log') ? total + count : total, 0);
}

export function createRun({ tickMs = 50, reach = 4, now = () => performance.now() } = {}) {
  return async function run(bot, input, { signal }) {
    const started = now();
    const before = bot.observe();
    try {
      const startLogs = logCount(before?.inventory);
      const finish = (outcome, reason) => ({ outcome, reason, elapsed_ms: Math.max(0, now() - started), before, after: bot.observe() });
      let target = null;
      for (;;) {
        signal.throwIfAborted();
        const o = bot.observe();
        if (o?.self?.health != null && o.self.health <= 0) return finish('failure', 'bot_death');
        if (logCount(o?.inventory) > startLogs) return finish('success', 'log_collected');
        if (!o?.facts?.nearest_blocks) return finish('failure', 'requirement_unmet:no_block_facts');
        const nearest = Object.values(o.facts.nearest_blocks)
          .filter((block) => block?.type?.endsWith('_log'))
          .sort((a, b) => a.distance - b.distance)[0];
        if (nearest) {
          const p = o.facts.position;
          target = { x: Math.round(p.x + nearest.dx), y: Math.round(p.y + nearest.dy), z: Math.round(p.z + nearest.dz) };
        }
        if (!target) return finish('failure', 'no_log_in_range');
        const point = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 };
        const self = o.self.position;
        const horizontalDistance = Math.hypot(point.x - self.x, point.z - self.z);
        const eye = { x: self.x, y: self.y + 1.62, z: self.z };
        const d = aimDelta(angularError(eye, o.self.yaw ?? 0, o.self.pitch ?? 0, point));
        bot.requestAction({ forward: horizontalDistance > 1, attack: Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z) <= reach, yaw_delta: d.yaw, pitch_delta: d.pitch });
        await delay(tickMs, undefined, { signal });
      }
    } finally {
      bot.releaseControls();
    }
  };
}

export const run = createRun();
