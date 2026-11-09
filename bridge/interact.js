import { Vec3 } from 'vec3';

const interacting = new WeakSet();

export function interactAt(bot, target) {
  const face = target?.face;
  if (!target || !['x', 'y', 'z'].every((k) => Number.isInteger(target[k])) ||
      !face || !['x', 'y', 'z'].every((k) => Number.isInteger(face[k])) ||
      Math.abs(face.x) + Math.abs(face.y) + Math.abs(face.z) !== 1) return;
  const position = bot?.entity?.position;
  if (!position || !['x', 'y', 'z'].every((k) => Number.isFinite(position[k])) ||
      interacting.has(bot) || typeof bot.blockAt !== 'function' || typeof bot.activateBlock !== 'function') return;
  const cursor = new Vec3(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
  const distance = Math.hypot(target.x + cursor.x - position.x, target.y + cursor.y - position.y - 1.62, target.z + cursor.z - position.z);
  if (distance > 4.5) return;
  let block;
  try { block = bot.blockAt(new Vec3(target.x, target.y, target.z)); }
  catch { return; }
  if (!block || block.name.endsWith('air')) return;
  interacting.add(bot);
  return (async () => { await bot.activateBlock(block, new Vec3(face.x, face.y, face.z), cursor); })()
    .catch(() => {})
    .finally(() => interacting.delete(bot));
}
