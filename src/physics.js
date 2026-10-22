import * as THREE from 'three';

const _ray = new THREE.Ray();
const _hit = new THREE.Vector3();

// Distance from origin along dir to the nearest static box, capped at maxDist.
// Returns maxDist when nothing is hit closer than that. Uses the colliders' grid when
// there is one (see grid.js), so only boxes along the ray are tested.
export function raycastWorld(origin, dir, maxDist, colliders) {
  _ray.set(origin, dir);
  const test = (box) => (_ray.intersectBox(box, _hit) ? origin.distanceTo(_hit) : Infinity);
  if (colliders.grid) return colliders.grid.raycast(origin, dir, maxDist, test);
  let best = maxDist;
  for (const box of colliders) {
    const d = test(box);
    if (d < best) best = d;
  }
  return best;
}

// Boxes near an x/z rectangle: the grid's candidates, or all of them without a grid
export function nearbyBoxes(colliders, x0, z0, x1, z1, out) {
  return colliders.grid ? colliders.grid.query(x0, z0, x1, z1, out) : colliders;
}
