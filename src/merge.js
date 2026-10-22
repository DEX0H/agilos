import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Merges the arena's static meshes into a few big ones: one per texture set (tints
// become vertex colours) and shadow setting. Hundreds of draw calls (twice: once for the
// screen and once for the sun's shadow map) become about a dozen. Collision is unaffected:
// it uses the Box3 colliders, not these meshes.

const _c = new THREE.Color();
const merged = new Map(); // vertex-coloured copies of the arena materials, made once

export function mergeStatic(group, half = 30, chunk = 64) {
  group.updateMatrixWorld(true);
  const buckets = new Map();
  const old = [];
  group.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || Array.isArray(o.material)) return;
    old.push(o);
    for (let p = o; p && p !== group.parent; p = p.parent) if (!p.visible) return; // hidden: just dropped
    const m = o.material;
    // Same textures and settings share one material; only the tint differs. Big maps are
    // split into chunks so the parts behind you are skipped.
    const cell = `${Math.floor((o.matrixWorld.elements[12] + half) / chunk)},${Math.floor((o.matrixWorld.elements[14] + half) / chunk)}`;
    const key = `${m.type}|${m.map ? m.map.uuid : m.uuid}|${m.transparent}|${o.castShadow}|${o.receiveShadow}|${cell}`;
    let b = buckets.get(key);
    if (!b) {
      // One vertex-coloured material per texture set, shared by all chunks
      const mkey = `${m.type}|${m.map ? m.map.uuid : m.uuid}|${m.transparent}`;
      let mat = merged.get(mkey);
      if (!mat) {
        mat = m.clone();
        mat.color.set(0xffffff);
        mat.vertexColors = true;
        merged.set(mkey, mat);
      }
      b = { mat, geoms: [], cast: o.castShadow, receive: o.receiveShadow };
      buckets.set(key, b);
    }
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    g.applyMatrix4(o.matrixWorld);
    _c.copy(m.color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    b.geoms.push(g);
  });

  for (const o of old) {
    o.removeFromParent();
    o.geometry.dispose();
  }
  // The group itself sits at the origin; merged geometry is already in world space
  group.position.set(0, 0, 0);
  group.rotation.set(0, 0, 0);
  group.scale.set(1, 1, 1);
  for (const b of buckets.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(b.geoms, false), b.mat);
    for (const g of b.geoms) g.dispose();
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.receive;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }
  return { before: old.length, after: buckets.size };
}

// Collapses a model made of many small meshes (the FBX guns have dozens) into one mesh
// per material. The result includes `root`'s own transform (an FBX root often carries a
// scale), so it replaces `root` under the same parent. `root` is left untouched.
export function mergeByMaterial(root) {
  root.updateMatrixWorld(true);
  const inv = root.parent ? new THREE.Matrix4().copy(root.parent.matrixWorld).invert() : new THREE.Matrix4();
  const m4 = new THREE.Matrix4();
  const buckets = new Map();
  const add = (mat, g, cast, receive) => {
    const key = `${mat.type}|${mat.name}|${mat.color ? mat.color.getHexString() : ''}|${mat.roughness}|${mat.metalness}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat, geoms: [], cast, receive }));
    b.geoms.push(g);
  };
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p && p !== root.parent; p = p.parent) if (!p.visible) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(m4.multiplyMatrices(inv, o.matrixWorld));
    if (Array.isArray(o.material)) {
      const groups = g.groups.length ? g.groups : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
      for (const gr of groups) {
        const mat = o.material[gr.materialIndex];
        if (!mat) continue;
        const part = new THREE.BufferGeometry();
        for (const name of ['position', 'normal']) {
          const a = g.attributes[name];
          part.setAttribute(name, new THREE.BufferAttribute(a.array.slice(gr.start * 3, (gr.start + gr.count) * 3), 3));
        }
        add(mat, part, o.castShadow, o.receiveShadow);
      }
      g.dispose();
    } else {
      g.clearGroups();
      add(o.material, g, o.castShadow, o.receiveShadow);
    }
  });
  const out = new THREE.Group();
  for (const b of buckets.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(b.geoms, false), b.mat);
    for (const g of b.geoms) g.dispose();
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.receive;
    out.add(mesh);
  }
  return out;
}
