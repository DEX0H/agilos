import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// City dressing from the Downtown City MegaKit (Quaternius, CC0): brick and shopfront
// facades with windows on the perimeter walls and on the buildings' wall sections, plus
// cornices, wall-mounted AC units, manholes and drains. Purely visual: collision stays
// the simple boxes from arena.js. Everything is instanced, one draw call per piece part.

const MODULE_W = 2;   // facade modules are 2 m wide and 3 m tall, facing +Z
const MODULE_H = 3;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// Deterministic randomness so the city looks the same every time
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// The kit is downloaded once; each map rebuild reuses it
let kit = null;
const loadKit = () => (kit ||= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  .loadAsync(`${import.meta.env.BASE_URL}models/city.glb`));

export const CHUNK = 64; // instanced pieces are split into map chunks so off-screen ones are skipped

export async function dressCity(scene, arena) {
  const gltf = await loadKit();

  // Each scene in the file is one piece; collect its meshes with their local transforms
  const pieces = {};
  for (const sc of gltf.scenes) {
    const root = sc.children[0];
    if (!root) continue;
    const name = root.name.replace(/[^A-Za-z_]/g, '').replace(/_?\d*$/, '');
    sc.updateMatrixWorld(true);
    const parts = [];
    sc.traverse((o) => {
      if (o.isMesh) parts.push({ geometry: o.geometry, material: fixMaterial(o.material), matrix: o.matrixWorld.clone() });
    });
    pieces[name] = { parts, placements: [] };
  }
  const has = (n) => !!pieces[n];
  const place = (name, matrix) => { if (pieces[name]) pieces[name].placements.push(matrix.clone()); };

  // Module transform: origin at the bottom centre of the module's front face
  const moduleMatrix = (x, y, z, nx, nz, sx = 1, sy = 1, sz = 1) => {
    _q.setFromAxisAngle(UP, Math.atan2(nx, nz)); // local +Z -> outward normal
    _s.set(sx, sy, sz);
    _p.set(x, y, z);
    return _m.compose(_p, _q, _s);
  };

  // ---- Perimeter: a row of different buildings along each wall ----
  const rand = rng(1234);
  const STYLES = [
    { ground: 'Metal_FirstFloor_Window', upper: ['Brick_Window_Square_Single'], top: 'Cornice_Metal_Center', rows: 5 },
    { ground: 'Trim_FirstFloor_Window', upper: ['Trim_Window'], top: 'Cornice_Metal_Center', rows: 4 },
    { ground: 'Metal_FirstFloor_Window', upper: ['Metal_FullWindow', 'Brick_Window_Square_Single'], top: 'Cornice_Brick_Center', rows: 5 },
    { ground: 'Trim_FirstFloor_Window', upper: ['Brick_Window_Square_Single', 'Trim_Window'], top: 'Cornice_Metal_Center', rows: 3 },
  ];
  const chimneys = arena.chimneys || [];
  for (const f of arena.perimeterFaces) {
    const tx = f.nz;   // tangent along the face (local +X after rotation)
    const tz = -f.nx;
    const count = Math.floor(f.length / MODULE_W);
    let i = 0;
    while (i < count) {
      // One "building": 4 to 9 modules wide with its own style
      const width = Math.min(count - i, 4 + Math.floor(rand() * 6));
      const style = STYLES[Math.floor(rand() * STYLES.length)];
      for (let k = 0; k < width; k++, i++) {
        const along = -f.length / 2 + MODULE_W / 2 + i * MODULE_W;
        // A few centimetres off the wall so the facade never z-fights with it
        const x = f.x + tx * along + f.nx * 0.04;
        const z = f.z + tz * along + f.nz * 0.04;
        for (let r = 0; r < style.rows; r++) {
          let name = r === 0 ? style.ground : style.upper[(k + r) % style.upper.length];
          if (!has(name)) name = 'Brick_Window_Square_Single';
          place(name, moduleMatrix(x, r * MODULE_H, z, f.nx, f.nz));
          // Some windows get an AC unit, away from the wall-jump chimneys
          const nearChimney = chimneys.some((c) => Math.hypot(c.x - x, c.z - z) < 5);
          if (r > 0 && name.includes('Window') && !nearChimney && rand() < 0.12) {
            place('Prop_ACUnit', moduleMatrix(x - tx * 0.05, r * MODULE_H + 0.25, z, f.nx, f.nz));
          }
        }
        place(style.top, moduleMatrix(x, style.rows * MODULE_H, z, f.nx, f.nz));
        if (rand() < 0.25) place('Prop_Drain', moduleMatrix(x + f.nx * 0.6, 0.002, z + f.nz * 0.6, f.nx, f.nz));
      }
    }
  }

  // ---- Building wall sections: windowed facade outside, plain wall inside ----
  for (const w of arena.facades) {
    const k = Math.max(1, Math.round(w.length / MODULE_W));
    const sx = w.length / (k * MODULE_W);
    const sy = w.height / MODULE_H;
    const tx = w.nz;
    const tz = -w.nx;
    for (let i = 0; i < k; i++) {
      const along = -w.length / 2 + (i + 0.5) * MODULE_W * sx;
      const name = w.ground ? 'Metal_FirstFloor_Window' : 'Brick_Window_Square_Single';
      // Front face slightly proud of the box so it covers it; the box itself is hidden
      place(name, moduleMatrix(w.x + tx * along + w.nx * 0.04, w.bottomY, w.z + tz * along + w.nz * 0.04, w.nx, w.nz, sx, sy));
    }
    w.mesh.visible = false;
    // The facade is 0.24 m deep and the wall 0.3 m: an inner skin covers the back
    const inner = w.mesh.clone();
    inner.visible = true;
    inner.scale.set(w.nx ? 0.2 : 1, 1, w.nz ? 0.2 : 1);
    inner.position.x -= w.nx * 0.12;
    inner.position.z -= w.nz * 0.12;
    w.mesh.parent.add(inner);
  }

  // ---- Floor slabs and roofs: a metal band around every edge (a cornice on roofs) ----
  const SLAB = 0.35;
  for (const sl of arena.slabs || []) {
    const sides = [
      { x: sl.cx, z: sl.cz - sl.d / 2, nx: 0, nz: -1, len: sl.w },
      { x: sl.cx, z: sl.cz + sl.d / 2, nx: 0, nz: 1, len: sl.w },
      { x: sl.cx - sl.w / 2, z: sl.cz, nx: -1, nz: 0, len: sl.d },
      { x: sl.cx + sl.w / 2, z: sl.cz, nx: 1, nz: 0, len: sl.d },
    ];
    const band = sl.roof ? 0.55 : 0.45; // the roof band is deeper, like a cornice
    for (const f of sides) {
      const k = Math.max(1, Math.round(f.len / MODULE_W));
      const sx = (f.len + 0.2) / (k * MODULE_W); // overlap the corners
      const tx = f.nz;
      const tz = -f.nx;
      for (let i = 0; i < k; i++) {
        const along = -(f.len + 0.2) / 2 + (i + 0.5) * MODULE_W * sx;
        place('Cornice_Metal_Center', moduleMatrix(
          f.x + tx * along + f.nx * 0.1, sl.y + 0.1 - band, f.z + tz * along + f.nz * 0.1, f.nx, f.nz, sx, band, 1,
        ));
      }
    }
  }

  // ---- Ceiling lights: two fluorescent tubes under every slab ----
  const tubes = [];
  for (const sl of arena.slabs || []) {
    for (const off of [-0.22, 0.22]) tubes.push([sl.cx + sl.w * off, sl.y - SLAB - 0.04, sl.cz]);
  }

  // ---- Rooftop AC units (their colliders come from arena.js) ----
  for (const p of arena.rooftopProps || []) {
    const S = 1.5;
    const f = p.facing >= 0 ? 1 : -1;
    place('Prop_ACUnit', moduleMatrix(p.x - f * 0.035 * S, p.y, p.z - f * 0.155 * S, 0, f, S, S, S));
  }

  // ---- Street details: manholes in the open ground ----
  const r2 = rng(99);
  for (const p of arena.navPoints) {
    if (p.y !== 0 || r2() > 0.18) continue;
    place('Prop_ManholeCover', _m.makeRotationY(r2() * Math.PI).setPosition(p.x + 1.2, 0.005, p.z + 0.8));
  }

  // ---- One InstancedMesh per piece part and map chunk ----
  const group = new THREE.Group();
  group.name = 'city';
  let drawCalls = 0;
  const half = arena.half || 30;
  const chunkOf = (m) => `${Math.floor((m.elements[12] + half) / CHUNK)},${Math.floor((m.elements[14] + half) / CHUNK)}`;
  for (const piece of Object.values(pieces)) {
    const byChunk = new Map();
    for (const pm of piece.placements) {
      const k = chunkOf(pm);
      if (!byChunk.has(k)) byChunk.set(k, []);
      byChunk.get(k).push(pm);
    }
    for (const list of byChunk.values()) {
      for (const part of piece.parts) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        list.forEach((pm, i) => im.setMatrixAt(i, _m.multiplyMatrices(pm, part.matrix)));
        im.castShadow = true;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        group.add(im);
        drawCalls++;
      }
    }
  }
  // Fluorescent tubes: a dark housing with a glowing (HDR, so it blooms) strip
  if (tubes.length) {
    const housing = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.05, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, metalness: 0.5 }), tubes.length);
    const glow = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 0.03, 0.08),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.4, 2.1) }), tubes.length);
    tubes.forEach(([x, y, z], i) => {
      housing.setMatrixAt(i, _m.makeTranslation(x, y + 0.02, z));
      glow.setMatrixAt(i, _m.makeTranslation(x, y - 0.01, z));
    });
    group.add(housing, glow);
    drawCalls += 2;
  }

  scene.add(group);
  return { group, drawCalls };
}

// Glass reads as dark reflective panes (opaque: it blocks bullets in the game anyway);
// the fake interiors hide behind it.
const glass = new THREE.MeshStandardMaterial({ color: 0x1b2430, metalness: 0.9, roughness: 0.08 });
function fixMaterial(m) {
  if (/glass/i.test(m.name)) return glass;
  // The kit's vertex colours drive a wear shader in engines; as plain colours they turn
  // some walls nearly black
  m.vertexColors = false;
  m.side = THREE.FrontSide;
  if (m.transparent) { m.transparent = false; m.opacity = 1; }
  return m;
}
