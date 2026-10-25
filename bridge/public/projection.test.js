import test from 'node:test';
import assert from 'node:assert/strict';
import { boxEdges, cameraPoint, project } from './projection.js';

test('camera projection maps a forward centered point to the viewport center', () => {
  const self = { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, eye_height: 0 };
  const camera = cameraPoint({ x: 0, y: 0, z: -4 }, self);
  assert.ok(camera.z > 0);
  assert.deepEqual(project(camera, 800, 600, Math.PI / 2), { x: 400, y: 300 });
});

test('AABB projection returns all visible box edges', () => {
  const self = { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, eye_height: 0 };
  const edges = boxEdges({ min: { x: -.5, y: -.5, z: -5 }, max: { x: .5, y: 1.5, z: -4 } }, self, 800, 600, Math.PI / 2);
  assert.equal(edges.length, 12);
  assert.ok(edges.every(([a, b]) => a && b && Number.isFinite(a.x) && Number.isFinite(b.y)));
});
