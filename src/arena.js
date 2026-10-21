import * as THREE from 'three';

// Small test arena: 60 x 60 m, stepped structures for vertical movement.
// Every solid is an axis-aligned box that is both rendered and used for collision.

const LOW = new THREE.Color(0x6b7280);
const HIGH = new THREE.Color(0xf59e0b);
const MAX_HEIGHT = 7;

export function buildArena(scene) {
  const colliders = [];
  const group = new THREE.Group();
  scene.add(group);

  // Lights
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x303030, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(20, 40, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 });
  scene.add(sun);

  // Solid box centred on (x, z), standing on the ground from y=0 up to `top`.
  // `base` = true means the block sits from `bottomY` to `top` instead of from 0.
  function block(x, z, w, d, top, { bottomY = 0, color } = {}) {
    const h = top - bottomY;
    const t = Math.min(top / MAX_HEIGHT, 1);
    const c = color ?? LOW.clone().lerp(HIGH, t);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }),
    );
    mesh.position.set(x, bottomY + h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push(new THREE.Box3(
      new THREE.Vector3(x - w / 2, bottomY, z - d / 2),
      new THREE.Vector3(x + w / 2, top, z + d / 2),
    ));
  }

  // Staircase of solid steps. Each step rises `rise` and is `run` deep.
  // Rise is kept under the player's auto step-up height so walking up just works.
  function stairs(x0, z0, dx, dz, count, rise, run, width) {
    for (let i = 0; i < count; i++) {
      const along = i * run + run / 2;
      const cx = x0 + dx * along;
      const cz = z0 + dz * along;
      const sx = dx !== 0 ? run : width;
      const sz = dz !== 0 ? run : width;
      block(cx, cz, sx, sz, rise * (i + 1));
    }
  }

  // Ground (top at y = 0)
  block(0, 0, 60, 60, 0, { bottomY: -1, color: 0x3a3f47 });

  // Perimeter walls
  const wallTop = 10;
  block(0, -30, 60, 1, wallTop);
  block(0, 30, 60, 1, wallTop);
  block(-30, 0, 1, 60, wallTop);
  block(30, 0, 1, 60, wallTop);

  // Central ziggurat: 4 tiers, each step 0.5 to 1.2 high, reachable from all sides
  block(0, 0, 8, 8, 0.5);
  block(0, 0, 6, 6, 1.2);
  block(0, 0, 4, 4, 2.4);
  block(0, 0, 2, 2, 3.6);

  // Stairs up to a north-west platform (top 4.0)
  stairs(-22, -20, 1, 0, 8, 0.5, 1.2, 4);
  block(-10, -20, 6, 6, 4.0);

  // Stairs up to a south-east platform (top 3.0)
  stairs(22, 20, -1, 0, 6, 0.5, 1.2, 4);
  block(12, 20, 6, 6, 3.0);

  // Long staircase up to a high north-east sniper deck (top 6.0)
  stairs(10, -22, 0, 1, 12, 0.5, 1.2, 5);
  block(10, -10, 7, 7, 6.0);

  // Tower in the north-west, top 6.5, reachable with a double jump from the NW platform
  block(-3, -20, 3, 3, 6.5);

  // Low cover crates, top 1.0
  const crates = [
    [6, -6], [-8, 6], [16, -14], [-18, 14],
    [22, -4], [-4, -18], [8, 18], [-24, -4],
  ];
  for (const [x, z] of crates) block(x, z, 1.4, 1.4, 1.0, { color: 0x8b5e3c });

  return { colliders, group };
}
