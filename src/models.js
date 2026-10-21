import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Shared model loading. Each file is fetched once; callers clone what they need.
// All models are CC0 by Quaternius (see public/models/CREDITS.md):
//   char_male.glb                   Universal Base Characters (Standard), optimised
//   anims.glb                       Universal Animation Library (Standard), 17 clips kept
//   guns/Pistol_*.fbx               Ultimate Gun Pack

const base = `${import.meta.env.BASE_URL}models/`;
const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const fbx = new FBXLoader();
const cache = new Map();

function once(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

export const loadCharacter = (kind) => once(`char_${kind}`, () => gltf.loadAsync(`${base}char_${kind}.glb`));
export const loadAnimations = () => once('anims', () => gltf.loadAsync(`${base}anims.glb`).then((g) => g.animations));
export const PISTOL = 'Pistol_4';
export const loadPistol = (name = PISTOL) => once(`gun_${name}`, () => fbx.loadAsync(`${base}guns/${name}.fbx`));

// Turn any gun model into a predictable one: barrel along -Z, grip down,
// `length` metres long, origin where the hand holds the grip.
// The muzzle end is the end farther from the grip, so no per-model tuning is needed.
// Returns { object, muzzle } where muzzle is the barrel tip in the object's space.
// The FBX export reads as fully transparent with near-black colours, so gun materials are
// rebuilt as PBR materials from their names.
const GUN_PALETTE = {
  Metal: 0x4d5157, LightMetal: 0x8d9198, DarkMetal: 0x2c2f33, Black: 0x1c1d20,
  Wood: 0x7a4f30, Brown: 0x7a4f30, Grey: 0x6b6e73, Gray: 0x6b6e73, Green: 0x5b6a45,
};
function gunMaterial(m) {
  const metal = /metal/i.test(m.name);
  const fallback = m.color ? m.color.clone().multiplyScalar(4) : new THREE.Color(0x555555);
  return new THREE.MeshStandardMaterial({
    name: m.name,
    color: GUN_PALETTE[m.name] !== undefined ? new THREE.Color(GUN_PALETTE[m.name]) : fallback,
    roughness: metal ? 0.35 : 0.65,
    metalness: metal ? 0.8 : 0.1,
  });
}

export function normalizeGun(source, length) {
  const gun = source.clone(true);
  gun.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.material = Array.isArray(o.material) ? o.material.map(gunMaterial) : gunMaterial(o.material);
    }
  });
  gun.updateMatrixWorld(true);

  // All vertex positions in the gun's own space
  const pts = [];
  const v = new THREE.Vector3();
  gun.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 3) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).clone());
  });
  const box = new THREE.Box3().setFromPoints(pts);
  const size = box.getSize(new THREE.Vector3());

  // Height is the smaller of the vertical candidates; the barrel runs along the longest horizontal axis
  const long = size.x >= size.z ? 'x' : 'z';
  const gripCut = box.min.y + size.y * 0.35;
  let gripSum = 0;
  let gripN = 0;
  for (const p of pts) if (p.y < gripCut) { gripSum += p[long]; gripN++; }
  const grip = gripN ? gripSum / gripN : (box.min[long] + box.max[long]) / 2;
  const centre = (box.min[long] + box.max[long]) / 2;
  const muzzleSign = grip < centre ? 1 : -1; // muzzle is on the side away from the grip

  // Rotate so the muzzle direction maps to -Z
  const turn = new THREE.Group();
  turn.add(gun);
  if (long === 'x') turn.rotation.y = muzzleSign > 0 ? Math.PI / 2 : -Math.PI / 2;
  else turn.rotation.y = muzzleSign > 0 ? Math.PI : 0;
  const s = length / Math.max(1e-6, size[long]);
  turn.scale.setScalar(s);
  turn.updateMatrixWorld(true);

  // Re-measure in the turned space and put the hand point at the origin
  const tpts = pts.map((p) => p.clone().applyMatrix4(turn.matrixWorld));
  const tbox = new THREE.Box3().setFromPoints(tpts);
  const tsize = tbox.getSize(new THREE.Vector3());
  const tGripCut = tbox.min.y + tsize.y * 0.35;
  let gz = 0;
  let gn = 0;
  for (const p of tpts) if (p.y < tGripCut) { gz += p.z; gn++; }
  const handZ = gn ? gz / gn : (tbox.min.z + tbox.max.z) / 2;
  const handY = tbox.min.y + tsize.y * 0.62;
  const handX = (tbox.min.x + tbox.max.x) / 2;

  const object = new THREE.Group();
  object.add(turn);
  turn.position.set(-handX, -handY, -handZ);
  const muzzle = new THREE.Vector3(0, tbox.max.y - tsize.y * 0.18 - handY, tbox.min.z - handZ);
  return { object, muzzle, size: tsize };
}
