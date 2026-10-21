import * as THREE from 'three';

// Real PBR surfaces (Poly Haven, CC0): colour, normal and ARM (ambient occlusion,
// roughness, metalness) maps, 1K WebP, mapped in world space so they line up across
// blocks and never stretch.

const base = import.meta.env.BASE_URL;
const loader = new THREE.TextureLoader();

// Metres covered by one repeat of each texture
export const SURFACES = {
  asphalt: { tile: 6 },
  floor: { tile: 3 },
  concrete: { tile: 3 },
  brick: { tile: 2.5 },
  plaster: { tile: 3 },
  rust: { tile: 2 },
  corrugated: { tile: 3, metalness: 0.4 },
  planks: { tile: 1.6 },
};

const texCache = new Map();
function tex(name, color) {
  if (!texCache.has(name)) {
    const t = loader.load(`${base}textures/${name}.webp`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(name, t);
  }
  return texCache.get(name);
}

const matCache = new Map();
// `tint` multiplies the colour map, for subtle variation between buildings
export function surface(kind, tint = 0xffffff) {
  const c = new THREE.Color(tint);
  const key = kind + c.getHexString();
  if (!matCache.has(key)) {
    const arm = tex(`${kind}_arm`);
    matCache.set(key, new THREE.MeshStandardMaterial({
      map: tex(`${kind}_diff`, true),
      normalMap: tex(`${kind}_nor`),
      aoMap: arm,
      aoMapIntensity: 0.8,
      roughnessMap: arm,
      metalnessMap: arm,
      roughness: 1,
      metalness: SURFACES[kind].metalness ?? 1, // the ARM map's blue channel decides
      color: c,
    }));
  }
  return matCache.get(key);
}

// Planar UVs from world position on each face's dominant axis, in texture tiles.
// `offset` is where the geometry will sit in the world.
export function worldUVs(geom, offset, kind) {
  const tile = SURFACES[kind].tile;
  const pos = geom.attributes.position;
  const nor = geom.attributes.normal;
  const uv = geom.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + offset.x;
    const y = pos.getY(i) + offset.y;
    const z = pos.getZ(i) + offset.z;
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    if (ay >= ax && ay >= az) uv.setXY(i, x / tile, z / tile);
    else if (ax >= az) uv.setXY(i, z / tile, y / tile);
    else uv.setXY(i, x / tile, y / tile);
  }
  uv.needsUpdate = true;
}
