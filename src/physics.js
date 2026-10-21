import * as THREE from 'three';

const _ray = new THREE.Ray();
const _hit = new THREE.Vector3();

// Distance from origin along dir to the nearest static box, capped at maxDist.
// Returns maxDist when nothing is hit closer than that.
export function raycastWorld(origin, dir, maxDist, colliders) {
  _ray.set(origin, dir);
  let best = maxDist;
  for (const box of colliders) {
    if (!_ray.intersectBox(box, _hit)) continue;
    const d = origin.distanceTo(_hit);
    if (d < best) best = d;
  }
  return best;
}
