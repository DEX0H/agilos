import * as THREE from 'three';
import { getTexture } from './textures.js';
import { SUN_DIR } from './sky.js';

// Test arena: 60 x 60 m, stepped structures for vertical movement.
// Every solid is an axis-aligned box that is both rendered and used for collision.
// Collision layout is unchanged from the earlier iterations.

const TILE = 4;                              // metres per texture tile
const LOW = new THREE.Color(0x6b6f76);
const HIGH = new THREE.Color(0xb49a72);
const MAX_HEIGHT = 7;
const TRIM_COLOR = new THREE.Color(2.2, 0.9, 0.3); // HDR so it blooms slightly
const MIN_TRIM_HEIGHT = 2;

const matCache = new Map();
function material(kind, color) {
  const key = kind + color.getHexString();
  if (!matCache.has(key)) {
    const tex = getTexture(kind);
    matCache.set(key, new THREE.MeshStandardMaterial({
      map: tex,
      bumpMap: tex,
      bumpScale: 0.4,
      color,
      roughness: 0.85,
      metalness: kind === 'metal' ? 0.35 : 0.05,
    }));
  }
  return matCache.get(key);
}

export function buildArena(scene) {
  const colliders = [];
  const group = new THREE.Group();
  scene.add(group);

  // Low golden sun from the shared direction
  const sun = new THREE.DirectionalLight(0xffe2b8, 2.2);
  sun.position.copy(SUN_DIR).multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 150 });
  scene.add(sun);

  // Cool sky fill from above, warm bounce from the ground
  const hemi = new THREE.HemisphereLight(0xbcd0ff, 0x3a3228, 1.0);
  scene.add(hemi);

  // Solid box centred on (x, z), from bottomY up to top.
  // `trim` adds a thin glowing edge on top of high blocks so you can read the height.
  function block(x, z, w, d, top, { bottomY = 0, color, kind = 'concrete', trim = false } = {}) {
    const h = top - bottomY;
    const c = color ?? LOW.clone().lerp(HIGH, Math.min(top / MAX_HEIGHT, 1));
    const geom = new THREE.BoxGeometry(w, h, d);

    // Scale UVs so the texture tile is TILE metres on every face
    const uv = geom.attributes.uv;
    const s = Math.max(w, h, d) / TILE;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);

    const mesh = new THREE.Mesh(geom, material(kind, c));
    mesh.position.set(x, bottomY + h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    if (trim && top >= MIN_TRIM_HEIGHT) {
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(w - 0.02, 0.04, d - 0.02),
        new THREE.MeshBasicMaterial({ color: TRIM_COLOR }),
      );
      slab.position.set(x, top + 0.02, z);
      group.add(slab);
    }

    colliders.push(new THREE.Box3(
      new THREE.Vector3(x - w / 2, bottomY, z - d / 2),
      new THREE.Vector3(x + w / 2, top, z + d / 2),
    ));
  }

  // Staircase of solid steps. Each step rises `rise` and is `run` deep.
  function stairs(x0, z0, dx, dz, count, rise, run, width) {
    for (let i = 0; i < count; i++) {
      const along = i * run + run / 2;
      const cx = x0 + dx * along;
      const cz = z0 + dz * along;
      const sx = dx !== 0 ? run : width;
      const sz = dz !== 0 ? run : width;
      block(cx, cz, sx, sz, rise * (i + 1), { trim: true });
    }
  }

  // Ground (top at y = 0)
  block(0, 0, 60, 60, 0, { bottomY: -1, color: new THREE.Color(0x6a6258), kind: 'ground' });

  // Perimeter walls
  const wallTop = 10;
  const wallColor = new THREE.Color(0x7d8590);
  block(0, -30, 60, 1, wallTop, { kind: 'metal', color: wallColor });
  block(0, 30, 60, 1, wallTop, { kind: 'metal', color: wallColor });
  block(-30, 0, 1, 60, wallTop, { kind: 'metal', color: wallColor });
  block(30, 0, 1, 60, wallTop, { kind: 'metal', color: wallColor });

  // Central ziggurat: 4 tiers
  block(0, 0, 8, 8, 0.5);
  block(0, 0, 6, 6, 1.2);
  block(0, 0, 4, 4, 2.4, { trim: true });
  block(0, 0, 2, 2, 3.6, { trim: true });

  // North-west platform and its stairs
  stairs(-22, -20, 1, 0, 8, 0.5, 1.2, 4);
  block(-10, -20, 6, 6, 4.0, { trim: true });

  // South-east platform and its stairs
  stairs(22, 20, -1, 0, 6, 0.5, 1.2, 4);
  block(12, 20, 6, 6, 3.0, { trim: true });

  // North-east sniper deck and its long staircase
  stairs(10, -22, 0, 1, 12, 0.5, 1.2, 5);
  block(10, -10, 7, 7, 6.0, { trim: true });

  // Tower in the north-west
  block(-3, -20, 3, 3, 6.5, { trim: true });

  // Low cover crates
  const crateColor = new THREE.Color(0xb08a5e);
  const crates = [
    [6, -6], [-8, 6], [16, -14], [-18, 14],
    [22, -4], [-4, -18], [8, 18], [-24, -4],
  ];
  for (const [x, z] of crates) block(x, z, 1.4, 1.4, 1.0, { kind: 'wood', color: crateColor });

  return { colliders, group };
}
