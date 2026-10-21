export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const wrapRadians = (r) => { while (r > Math.PI) r -= 2 * Math.PI; while (r < -Math.PI) r += 2 * Math.PI; return r; };
export function buildAabb(entity) {
  const p = entity.position ?? entity.pos ?? { x: 0, y: 0, z: 0 };
  const width = Number(entity.width ?? 0.6), height = Number(entity.height ?? 1.8);
  const half = width / 2;
  return { min: { x: p.x - half, y: p.y, z: p.z - half }, max: { x: p.x + half, y: p.y + height, z: p.z + half } };
}
export const centerOfAabb = (a) => ({ x: (a.min.x + a.max.x) / 2, y: (a.min.y + a.max.y) / 2, z: (a.min.z + a.max.z) / 2 });
export function chooseAimPoint(aabb, origin, visible = () => true) {
  const c = centerOfAabb(aabb);
  const candidates = [c, { x: c.x, y: aabb.min.y + (aabb.max.y - aabb.min.y) * 0.72, z: c.z }, { x: c.x, y: aabb.min.y + (aabb.max.y - aabb.min.y) * 0.35, z: c.z }];
  return candidates.find((p) => visible(origin, p)) ?? null;
}
export function angularError(origin, yaw, pitch, point) {
  const dx = point.x - origin.x, dy = point.y - origin.y, dz = point.z - origin.z;
  const horizontal = Math.hypot(dx, dz);
  const desiredYaw = Math.atan2(-dx, -dz);
  const desiredPitch = Math.atan2(dy, horizontal);
  return { yaw: wrapRadians(desiredYaw - yaw), pitch: desiredPitch - pitch, desiredYaw, desiredPitch };
}
export function aimDelta(error, limits = { yaw: 0.18, pitch: 0.14 }, gain = 0.65) {
  return { yaw: clamp(error.yaw * gain, -limits.yaw, limits.yaw), pitch: clamp(error.pitch * gain, -limits.pitch, limits.pitch) };
}
export function inReach(origin, point, reach = 3.1) { return Math.hypot(point.x - origin.x, point.y - origin.y, point.z - origin.z) <= reach; }
export function leadPoint(point, velocity = { x: 0, y: 0, z: 0 }, ticks = 0, maxTicks = 4) {
  const t = clamp(ticks, 0, maxTicks); return { x: point.x + velocity.x * t, y: point.y + velocity.y * t, z: point.z + velocity.z * t };
}
