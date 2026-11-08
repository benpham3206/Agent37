import { Vec3 } from 'vec3';

const digging = new WeakSet();

export function digAt(bot, pos) {
  if (digging.has(bot) || typeof bot.blockAt !== 'function') return;
  const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
  if (!block || block.name.endsWith('air')) return;
  const eye = bot.entity.position;
  const distance = Math.hypot(pos.x + 0.5 - eye.x, pos.y + 0.5 - eye.y - 1.62, pos.z + 0.5 - eye.z);
  if (distance > 4.5) return;
  digging.add(bot);
  return bot.dig(block, true)
    .catch(() => {})
    .finally(() => digging.delete(bot));
}
