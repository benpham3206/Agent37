export function cameraPoint(point, self) {
  const dx = point.x - self.position.x;
  const dy = point.y - self.position.y - (self.eye_height ?? 1.62);
  const dz = point.z - self.position.z;
  const sy = Math.sin(self.yaw), cy = Math.cos(self.yaw);
  const sp = Math.sin(self.pitch), cp = Math.cos(self.pitch);
  return {
    x: cy * dx - sy * dz,
    y: sy * sp * dx + cp * dy + cy * sp * dz,
    z: -sy * cp * dx + sp * dy - cy * cp * dz,
  };
}

export function project(point, width, height, fovY) {
  if (point.z < 0.05) return null;
  const focal = height / (2 * Math.tan(fovY / 2));
  return { x: width / 2 + focal * point.x / point.z, y: height / 2 - focal * point.y / point.z };
}

export function boxEdges(aabb, self, width, height, fovY) {
  const corners = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
    corners.push(cameraPoint({ x: (x ? aabb.max : aabb.min).x, y: (y ? aabb.max : aabb.min).y, z: (z ? aabb.max : aabb.min).z }, self));
  }
  const edges = [];
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) {
    const j = i ^ bit;
    if (i > j) continue;
    let a = corners[i], b = corners[j];
    if (a.z < 0.05 && b.z < 0.05) continue;
    if (a.z < 0.05 || b.z < 0.05) {
      const near = a.z < 0.05 ? a : b, far = a.z < 0.05 ? b : a;
      const t = (0.05 - near.z) / (far.z - near.z);
      const clipped = { x: near.x + t * (far.x - near.x), y: near.y + t * (far.y - near.y), z: 0.05 };
      if (a.z < 0.05) a = clipped; else b = clipped;
    }
    edges.push([project(a, width, height, fovY), project(b, width, height, fovY)]);
  }
  return edges;
}
