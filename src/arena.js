import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { surface, worldUVs } from './materials.js';
import { SUN_DIR } from './sky.js';

// Vertical city block: 60 x 60 m, nine open-sided buildings of 1 to 4 stories,
// external stairs, bridges between floors and rooftops, jumpable gaps between roofs.
// Every solid is an axis-aligned box that is both rendered and used for collision.

const STORY = 3.0;              // floor-to-floor height
const SLAB = 0.35;              // floor slab thickness
const STEP_RISE = 0.5;          // below the 0.55 m auto step-up
const STEP_RUN = 0.8;
const STAIR_W = 1.6;
const STAIR_INSET = 0.8;        // stairs start this far from their corner
const PILLAR = 0.6;
const WALL_T = 0.3;
const MAX_HEIGHT = 12;
const LOW = new THREE.Color(0x6b6f76);
const HIGH = new THREE.Color(0xb49a72);
const TRIM_COLOR = new THREE.Color(1.35, 0.6, 0.22); // warm ledge lights, a slight glow
const TRIM_W = 0.08;
const SIDE_ORDER = ['N', 'E', 'S', 'W'];

// Old surface names map onto the real textures; colours become a light tint
const KIND_SURFACE = { concrete: 'floor', concrete_wall: 'concrete', ground: 'asphalt', metal: 'rust', wood: 'planks' };
const WHITE = new THREE.Color(1, 1, 1);
function material(kind, color) {
  const s = KIND_SURFACE[kind] || kind;
  // Quantise the tint so similar colours share one material
  const t = WHITE.clone().lerp(color, 0.3);
  t.r = Math.round(t.r * 20) / 20;
  t.g = Math.round(t.g * 20) / 20;
  t.b = Math.round(t.b * 20) / 20;
  return surface(s, t);
}
const trimMat = new THREE.MeshBasicMaterial({ color: TRIM_COLOR });

// The sun and sky fill, created once (the map is rebuilt between matches, the light isn't).
// The sun's shadow box follows the player (see main.js), so big maps keep sharp shadows.
export function createLights(scene) {
  const sun = new THREE.DirectionalLight(0xffe2b8, 2.2);
  sun.position.copy(SUN_DIR).multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 150 });
  scene.add(sun, sun.target);
  // Cool sky fill from above, warm bounce from the ground
  scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x3a3228, 1.0));
  return sun;
}

// Deterministic randomness for generated maps
function rng(seed) {
  let x = (seed >>> 0) || 1;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

export const LOT = 17.5;            // building lot pitch: 12 m buildings, 5.5 m streets
export const halfFor = (lots) => (lots * LOT + 7.5) / 2;

// `lots` buildings per side: 3 is the hand-made map (60 x 60 m); 4 to 10 generate a city
// of that many lots (up to about 190 x 190 m) from `seed`.
export function buildArena(scene, { lots = 3, seed = 1 } = {}) {
  const half = halfFor(lots);
  const rand = rng(seed);
  const colliders = [];
  const group = new THREE.Group();
  scene.add(group);

  // Navigation points and explicit links (stairs, jumps) for bots
  const navPoints = [];
  const navLinks = [];
  const navJumps = [];
  const nav = (x, y, z) => navPoints.push(new THREE.Vector3(x, y, z)) - 1;
  // Jump between two roof edges. One-way for drops down to a lower roof.
  const jump = (a, b, oneWay = false) => navJumps.push([nav(...a), nav(...b), oneWay]);

  // Solid box centred on (x, z), from bottomY up to top.
  // `trim` puts thin glowing strips along the top edges so ledges are easy to read.
  function block(x, z, w, d, top, { bottomY = 0, color, kind = 'concrete', trim = false } = {}) {
    const h = top - bottomY;
    const c = color ?? LOW.clone().lerp(HIGH, Math.min(top / MAX_HEIGHT, 1));

    // Rounded edges catch light; the collider stays the exact box
    const radius = Math.min(0.15, w / 3, h / 3, d / 3);
    const geom = new RoundedBoxGeometry(w, h, d, 3, radius);
    const centre = new THREE.Vector3(x, bottomY + h / 2, z);
    const mat = material(kind, c);
    worldUVs(geom, centre, KIND_SURFACE[kind] || kind);

    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(centre);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    if (trim) {
      const y = top + 0.012;
      const strips = [
        [x, z - d / 2 + TRIM_W / 2, w, TRIM_W],
        [x, z + d / 2 - TRIM_W / 2, w, TRIM_W],
        [x - w / 2 + TRIM_W / 2, z, TRIM_W, d],
        [x + w / 2 - TRIM_W / 2, z, TRIM_W, d],
      ];
      for (const [sx, sz, sw, sd] of strips) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.025, sd), trimMat);
        strip.position.set(sx, y, sz);
        group.add(strip);
      }
    }

    const box = new THREE.Box3(
      new THREE.Vector3(x - w / 2, bottomY, z - d / 2),
      new THREE.Vector3(x + w / 2, top, z + d / 2),
    );
    colliders.push(box);
    mesh.userData.collider = box;
    return mesh;
  }

  // Walls that get city facade modules (see city.js): outer face centre, outward normal,
  // length along the face, bottom and height. `mesh` is the plain box, hidden once the
  // facade has loaded (its collider stays).
  const facades = [];
  // Floor slabs and roofs, for edge bands and ceiling lights (city.js)
  const slabs = [];
  const roofs = [];
  // Rooftop AC units: solid, so their colliders are added here; city.js draws them
  const rooftopProps = [];
  // Stairs are walked as smooth ramps (see character.js); their steps still stop bullets
  const ramps = [];

  // One flight of floating steps outside side `side` of footprint b, from baseY up one story.
  // N runs +x from the west corner, E runs +z from the north corner,
  // S runs -x from the east corner, W runs -z from the south corner.
  const stairColor = new THREE.Color(0x6b7078);

  // Point `along` metres from a side's start corner, `out` metres outside the footprint
  function sidePoint(b, side, along, out) {
    if (side === 'N') return [b.x0 + along, b.z0 - out];
    if (side === 'E') return [b.x1 + out, b.z0 + along];
    if (side === 'S') return [b.x1 - along, b.z1 + out];
    return [b.x0 - out, b.z1 - along];
  }

  function stairs(b, side, baseY) {
    const steps = Math.round(STORY / STEP_RISE);

    // Bot nav: inside at the bottom -> first step -> top step -> inside at the top
    const first = STAIR_INSET + STEP_RUN / 2;
    const last = STAIR_INSET + STEP_RUN * (steps - 1) + STEP_RUN / 2;
    const [ax, az] = sidePoint(b, side, first, -0.7);
    const [bx, bz] = sidePoint(b, side, first, STAIR_W / 2);
    const [cx2, cz2] = sidePoint(b, side, last, STAIR_W / 2);
    const [dx, dz] = sidePoint(b, side, last, -0.7);
    const A = nav(ax, baseY, az);
    const B = nav(bx, baseY + STEP_RISE, bz);
    const C = nav(cx2, baseY + STORY, cz2);
    const D = nav(dx, baseY + STORY, dz);
    navLinks.push([A, B], [B, C], [C, D]);

    for (let k = 0; k < steps; k++) {
      const top = baseY + STEP_RISE * (k + 1);
      const along = STAIR_INSET + STEP_RUN * k + STEP_RUN / 2;
      let cx, cz, sx, sz;
      if (side === 'N') { cx = b.x0 + along; cz = b.z0 - STAIR_W / 2; sx = STEP_RUN; sz = STAIR_W; }
      if (side === 'E') { cx = b.x1 + STAIR_W / 2; cz = b.z0 + along; sx = STAIR_W; sz = STEP_RUN; }
      if (side === 'S') { cx = b.x1 - along; cz = b.z1 + STAIR_W / 2; sx = STEP_RUN; sz = STAIR_W; }
      if (side === 'W') { cx = b.x0 - STAIR_W / 2; cz = b.z1 - along; sx = STAIR_W; sz = STEP_RUN; }
      const step = block(cx, cz, sx, sz, top, { bottomY: top - 0.3, kind: 'metal', color: stairColor });
      step.userData.collider.stair = true; // walked as the ramp below, not step by step
    }

    // The ramp: a sloped slab through the middle of every step's top, flat on the last
    // half step so it meets the floor above. Movement uses it instead of the steps.
    const a0 = STAIR_INSET;
    const a1 = STAIR_INSET + STEP_RUN * steps;
    const [p0x, p0z] = sidePoint(b, side, a0, 0);
    const [p1x, p1z] = sidePoint(b, side, a1, STAIR_W);
    const axis = side === 'N' || side === 'S' ? 'x' : 'z';
    const start = axis === 'x' ? p0x : p0z;
    const dir = side === 'N' || side === 'E' ? 1 : -1;
    ramps.push({
      min: new THREE.Vector3(Math.min(p0x, p1x), baseY - 0.5, Math.min(p0z, p1z)),
      max: new THREE.Vector3(Math.max(p0x, p1x), baseY + STORY, Math.max(p0z, p1z)),
      axis, dir, start,
      y0: baseY + STEP_RISE / 2,       // height where the ramp starts (half a step up)
      slope: STEP_RISE / STEP_RUN,
      yTop: baseY + STORY,
      thick: 0.5,                      // solid this far under the surface (headroom below)
    });
  }

  // Full-height wall on the half of a side away from where that side's stairs start
  const wallColor = new THREE.Color(0x8a8478);
  function wallChunk(b, side, baseY, topY) {
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.z0 + b.z1) / 2;
    // Brick on most buildings, painted plaster on some, for variety
    const opts = { bottomY: baseY, color: wallColor, kind: (Math.round(b.x0 + b.z0) & 2) ? 'plaster' : 'brick' };
    const f = { bottomY: baseY, height: topY - baseY, ground: baseY === 0 };
    if (side === 'N') Object.assign(f, { mesh: block((cx + b.x1) / 2, b.z0 + WALL_T / 2, b.x1 - cx, WALL_T, topY, opts),
      x: (cx + b.x1) / 2, z: b.z0, nx: 0, nz: -1, length: b.x1 - cx });
    if (side === 'E') Object.assign(f, { mesh: block(b.x1 - WALL_T / 2, (cz + b.z1) / 2, WALL_T, b.z1 - cz, topY, opts),
      x: b.x1, z: (cz + b.z1) / 2, nx: 1, nz: 0, length: b.z1 - cz });
    if (side === 'S') Object.assign(f, { mesh: block((b.x0 + cx) / 2, b.z1 - WALL_T / 2, cx - b.x0, WALL_T, topY, opts),
      x: (b.x0 + cx) / 2, z: b.z1, nx: 0, nz: 1, length: cx - b.x0 });
    if (side === 'W') Object.assign(f, { mesh: block(b.x0 + WALL_T / 2, (b.z0 + cz) / 2, WALL_T, cz - b.z0, topY, opts),
      x: b.x0, z: (b.z0 + cz) / 2, nx: -1, nz: 0, length: cz - b.z0 });
    facades.push(f);
  }

  // Open-sided building: corner pillars, a floor slab per story, one wall chunk per story,
  // external stairs per story, and a cover crate on the roof.
  const pillarColor = new THREE.Color(0x5c6068);
  const crateColor = new THREE.Color(0xb08a5e);
  function building(cx, cz, w, d, stories, stairSides, wallSides) {
    const b = { x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 };
    const roof = stories * STORY;

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        block(cx + sx * (w / 2 - PILLAR / 2), cz + sz * (d / 2 - PILLAR / 2), PILLAR, PILLAR, roof,
          { color: pillarColor, kind: 'concrete_wall' });
      }
    }

    for (let i = 1; i <= stories; i++) {
      block(cx, cz, w, d, i * STORY, { bottomY: i * STORY - SLAB, trim: true });
      slabs.push({ cx, cz, w, d, y: i * STORY, roof: i === stories });
    }
    roofs.push({ cx, cz, w, d, y: roof });

    for (let i = 0; i < stories; i++) {
      let side = wallSides ? wallSides[i] : SIDE_ORDER[i % 4];
      // Never wall off the edge where the stairs from below arrive
      if (!wallSides && i > 0 && stairSides[i - 1] === side) side = SIDE_ORDER[(i + 1) % 4];
      wallChunk(b, side, i * STORY, (i + 1) * STORY - SLAB);
    }

    for (let i = 0; i < stories; i++) stairs(b, stairSides[i], i * STORY);

    // Nav point at the centre of every floor, including the ground floor and the roof
    for (let i = 0; i <= stories; i++) nav(cx, i * STORY, cz);

    // Roof cover kept off the centre lines so bots can cross the roof
    block(cx + w * 0.25, cz - d * 0.25, 2, 1, roof + 1.0, { bottomY: roof, kind: 'wood', color: crateColor });
    return Object.assign(b, { cx, cz, w, d, stories });
  }

  // Ground (top at y = 0)
  const size = half * 2;
  block(0, 0, size, size, 0, { bottomY: -1, color: new THREE.Color(0x6a6258), kind: 'ground' });

  // Perimeter walls, tall enough that the tower roof can't see over them
  const wallTop = 16;
  const perimeter = new THREE.Color(0x7d8590);
  block(0, -half, size, 1, wallTop, { kind: 'corrugated', color: perimeter });
  block(0, half, size, 1, wallTop, { kind: 'corrugated', color: perimeter });
  block(-half, 0, 1, size, wallTop, { kind: 'corrugated', color: perimeter });
  block(half, 0, 1, size, wallTop, { kind: 'corrugated', color: perimeter });

  // Wall-jump chimneys: a free wall 1.4 m from the perimeter wall. Kick back and forth
  // to climb to 9 m.
  const chimney = new THREE.Color(0x8a8f99);
  const chimneys = [];
  const chimneyAt = (x, z) => {
    const alongZ = Math.abs(x) > Math.abs(z);
    block(x, z, alongZ ? 0.4 : 5, alongZ ? 5 : 0.4, 9, { kind: 'concrete_wall', color: chimney, trim: true });
    chimneys.push(new THREE.Vector3(x, 0, z));
  };
  let playerSpawn;
  let mobSpawns = [];

  if (lots === 3) {
  chimneyAt(-27.9, -7.5);
  chimneyAt(27.9, 7.5);

  // ---- Buildings ----
  // Centre tower, 4 stories (roof 12 m). Wall sides chosen to keep bridges and stairs clear.
  building(0, 0, 12, 12, 4, ['S', 'E', 'N', 'W'], ['W', 'E', 'W', 'S']);
  // Corners
  building(-17.5, -17.5, 12, 12, 3, ['W', 'N', 'E']);   // NW, roof 9 m
  building(17.5, -17.5, 12, 12, 2, ['N', 'E']);        // NE, roof 6 m
  building(-17.5, 17.5, 12, 12, 2, ['S', 'W']);        // SW, roof 6 m
  building(17.5, 17.5, 12, 12, 3, ['E', 'S', 'W']);    // SE, roof 9 m
  // Edges, 3 m streets to the tower
  building(-16, 0, 14, 12, 1, ['W']);                  // W, roof 3 m
  building(16, 0, 14, 12, 2, ['E', 'S']);              // E, roof 6 m
  building(0, -16, 8, 14, 1, ['N']);                   // N, roof 3 m
  building(0, 16, 8, 14, 2, ['S', 'W']);               // S, roof 6 m

  // ---- Bridges from tower floors to neighbouring roofs ----
  const bridgeColor = new THREE.Color(0x7a6a55);
  block(-7.5, 0, 3, 2, 3, { bottomY: 3 - SLAB, kind: 'metal', color: bridgeColor, trim: true }); // W roof <-> tower 1F
  block(0, -7.5, 2, 3, 3, { bottomY: 3 - SLAB, kind: 'metal', color: bridgeColor, trim: true }); // N roof <-> tower 1F
  block(7.5, 0, 3, 2, 6, { bottomY: 6 - SLAB, kind: 'metal', color: bridgeColor, trim: true });  // E roof <-> tower 2F
  block(0, 7.5, 2, 3, 6, { bottomY: 6 - SLAB, kind: 'metal', color: bridgeColor, trim: true });  // S roof <-> tower 2F

  // Hop platform between the SW and S roofs (both 6 m), 2.75 m jumps each side
  block(-7.75, 17, 2, 2, 6, { bottomY: 6 - SLAB, kind: 'metal', color: bridgeColor, trim: true });

  // King-of-the-hill lookout on the tower roof: one jump up from the 12 m roof
  block(-2.5, 2.5, 3, 3, 13.5, { bottomY: 12, trim: true });

  // Hop crates next to the 3 m and 6 m buildings: crate, then jump to the first floor
  for (const [x, z] of [[-16, -7.2], [16, 7.2], [-5.2, -16], [5.2, 16]]) {
    block(x, z, 1.4, 1.4, 1.6, { kind: 'wood', color: crateColor });
  }
  // Street cover
  for (const [x, z] of [[-26, 10], [26, -10], [10, 26], [-10, -26]]) {
    block(x, z, 1.4, 1.4, 1.0, { kind: 'wood', color: crateColor });
  }

  // Roof-to-roof jumps for bots. Points sit 0.7 m inside each roof edge.
  jump([17, 6, -12.2], [17, 6, -5.3]);              // NE roof <-> E roof, 5.5 m gap
  jump([-12.2, 6, 17], [-7.75, 6, 17]);             // SW roof <-> hop platform
  jump([-7.75, 6, 17], [-3.3, 6, 17]);              // hop platform <-> S roof
  jump([-17, 9, -12.2], [-17, 3, -5.3], true);      // NW roof drops to W roof
  jump([-12.2, 9, -16], [-3.3, 3, -16], true);      // NW roof drops to N roof
  jump([12.2, 6, -16], [3.3, 3, -16], true);        // NE roof drops to N roof
  jump([15, 9, 12.2], [15, 6, 5.3], true);          // SE roof drops to E roof
  jump([10.8, 9, 17], [3.3, 6, 17], true);          // SE roof drops to S roof
  jump([-17, 6, 12.2], [-17, 3, 5.3], true);        // SW roof drops to W roof
  jump([5.3, 12, -3], [9.7, 6, -3], true);          // tower roof drops to E roof
  jump([-5.3, 12, -3], [-9.7, 3, -3], true);        // tower roof drops to W roof

  playerSpawn = new THREE.Vector3(0, 0, 26);
  mobSpawns = [
    // Streets
    new THREE.Vector3(-26, 0, 0),
    new THREE.Vector3(26, 0, 0),
    new THREE.Vector3(0, 0, -26),
    new THREE.Vector3(26, 0, 26),
    new THREE.Vector3(-26, 0, -26),
    // Upper floors
    new THREE.Vector3(2, 3, 2),          // tower 1F
    new THREE.Vector3(-17.5, 6, -14),    // NW 2F
    new THREE.Vector3(17.5, 6, 17.5),    // SE 2F
  ];
  } else {
    generateCity();
  }

  // ---- Generated city: a grid of lots with buildings of 1 to 4 stories, taller toward
  // the middle, some empty plazas, bridges between neighbouring floors, street cover ----
  function generateCity() {
    const centre = (i) => (i - (lots - 1) / 2) * LOT;
    const sides = ['N', 'E', 'S', 'W'];
    const built = [];
    for (let i = 0; i < lots; i++) {
      built.push([]);
      for (let k = 0; k < lots; k++) {
        const cx = centre(i);
        const cz = centre(k);
        if (rand() < 0.1 && Math.hypot(cx, cz) > LOT) { built[i].push(null); continue; } // plaza
        const w = 8 + 2 * Math.floor(rand() * 3);        // 8, 10 or 12 m: streets stay wide
        const d = 8 + 2 * Math.floor(rand() * 3);
        const r = Math.hypot(cx, cz) / half;
        const stories = Math.max(1, Math.min(4, Math.round(1 + rand() * 2.6 * (1.25 - r * 0.7))));
        const stair = [];
        for (let s = 0; s < stories; s++) {
          let side = sides[Math.floor(rand() * 4)];
          if (s > 0 && side === stair[s - 1]) side = sides[(sides.indexOf(side) + 1) % 4];
          stair.push(side);
        }
        built[i].push(building(cx, cz, w, d, stories, stair));
      }
    }

    // Lookout on the tallest building nearest the middle
    let top = null;
    for (const row of built) for (const b of row) if (b && (!top || b.stories > top.stories || (b.stories === top.stories && Math.hypot(b.cx, b.cz) < Math.hypot(top.cx, top.cz)))) top = b;
    if (top && top.stories >= 3) block(top.cx - top.w * 0.2, top.cz + top.d * 0.2, 3, 3, top.stories * STORY + 1.5, { bottomY: top.stories * STORY, trim: true });

    // Bridges across the street between floors at the same height
    const bridgeColor = new THREE.Color(0x7a6a55);
    const clear = (x0, z0, x1, z1, y0, y1) => {
      const box = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
      return !colliders.some((c) => c.intersectsBox(box));
    };
    const bridge = (a, b, alongX) => {
      const level = 1 + Math.floor(rand() * Math.min(a.stories, b.stories));
      const y = level * STORY;
      for (const off of [0, -2.2, 2.2]) {
        if (alongX) {
          const z = (a.cz + b.cz) / 2 + off;
          if (Math.abs(z - a.cz) > a.d / 2 - 1.2 || Math.abs(z - b.cz) > b.d / 2 - 1.2) continue;
          // Gap free, and walkable 0.7 m into each building (no wall or pillar in the way)
          if (!clear(a.x1 + 0.02, z - 1, b.x0 - 0.02, z + 1, y - SLAB, y + 2)) continue;
          if (!clear(a.x1 - 0.8, z - 0.6, a.x1, z + 0.6, y + 0.05, y + 1.9)) continue;
          if (!clear(b.x0, z - 0.6, b.x0 + 0.8, z + 0.6, y + 0.05, y + 1.9)) continue;
          block((a.x1 + b.x0) / 2, z, b.x0 - a.x1 + 0.2, 2, y, { bottomY: y - SLAB, kind: 'metal', color: bridgeColor, trim: true });
          nav(a.x1 - 0.7, y, z); nav(b.x0 + 0.7, y, z);
        } else {
          const x = (a.cx + b.cx) / 2 + off;
          if (Math.abs(x - a.cx) > a.w / 2 - 1.2 || Math.abs(x - b.cx) > b.w / 2 - 1.2) continue;
          if (!clear(x - 1, a.z1 + 0.02, x + 1, b.z0 - 0.02, y - SLAB, y + 2)) continue;
          if (!clear(x - 0.6, a.z1 - 0.8, x + 0.6, a.z1, y + 0.05, y + 1.9)) continue;
          if (!clear(x - 0.6, b.z0, x + 0.6, b.z0 + 0.8, y + 0.05, y + 1.9)) continue;
          block(x, (a.z1 + b.z0) / 2, 2, b.z0 - a.z1 + 0.2, y, { bottomY: y - SLAB, kind: 'metal', color: bridgeColor, trim: true });
          nav(x, y, a.z1 - 0.7); nav(x, y, b.z0 + 0.7);
        }
        return;
      }
    };
    for (let i = 0; i < lots; i++) {
      for (let k = 0; k < lots; k++) {
        const a = built[i][k];
        if (!a) continue;
        if (i + 1 < lots && built[i + 1][k] && rand() < 0.45) bridge(a, built[i + 1][k], true);
        if (k + 1 < lots && built[i][k + 1] && rand() < 0.45) bridge(a, built[i][k + 1], false);
      }
    }

    // Street cover and hop crates at random spots that are free
    const crates = Math.round(lots * lots * 0.9);
    for (let n = 0, tries = 0; n < crates && tries < crates * 20; tries++) {
      const x = (rand() * 2 - 1) * (half - 3);
      const z = (rand() * 2 - 1) * (half - 3);
      const h = rand() < 0.5 ? 1.0 : 1.6;
      if (!clear(x - 2, z - 2, x + 2, z + 2, 0.05, 4)) continue;
      block(x, z, 1.4, 1.4, h, { kind: 'wood', color: crateColor });
      n++;
    }

    // A wall-jump chimney on each side of the map
    for (const [sx, sz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      for (let t = 0; t < 10; t++) {
        const along = (rand() * 2 - 1) * (half - 10);
        const x = sx ? sx * (half - 2.1) : along;
        const z = sz ? sz * (half - 2.1) : along;
        if (!clear(x - 2.6, z - 2.6, x + 2.6, z + 2.6, 0.05, 9)) continue;
        chimneyAt(x, z);
        break;
      }
    }
  }

  // Rooftop AC units in roof corners, clear of the crate, stairs, jumps and nav points
  const AC_W = 1.35;
  const AC_D = 0.55;
  const AC_H = 0.9;
  for (const r of roofs) {
    const corners = [[-1, 1], [1, 1], [-1, -1]]; // the crate sits in the (+x, -z) quadrant
    let placed = 0;
    for (const [sx, sz] of corners) {
      if (placed >= 2) break;
      const x = r.cx + sx * (r.w / 2 - 1.4);
      const z = r.cz + sz * (r.d / 2 - 1.2);
      const clear = navPoints.every((p) => Math.abs(p.y - r.y) > 0.5 || Math.hypot(p.x - x, p.z - z) > 1.8);
      if (!clear) continue;
      const box = new THREE.Box3(
        new THREE.Vector3(x - AC_W / 2, r.y, z - AC_D / 2),
        new THREE.Vector3(x + AC_W / 2, r.y + AC_H, z + AC_D / 2),
      );
      if (colliders.some((c) => c.intersectsBox(box))) continue;
      colliders.push(box);
      rooftopProps.push({ x, y: r.y, z, facing: sz }); // vents face the nearer roof edge
      placed++;
    }
  }

  // Ground grid of nav points wherever a body fits
  const g0 = -half + 2.5;
  for (let x = g0; x <= -g0 + 0.01; x += 5) {
    for (let z = g0; z <= -g0 + 0.01; z += 5) {
      let free = true;
      for (const c of colliders) {
        if (c.min.x < x + 0.45 && c.max.x > x - 0.45 && c.min.z < z + 0.45 && c.max.z > z - 0.45 &&
            c.min.y < 1.8 && c.max.y > 0.05) {
          free = false;
          break;
        }
      }
      if (free) nav(x, 0, z);
    }
  }

  // Generated maps: spawns spread over the streets (the match adds more from nav points)
  if (!playerSpawn) {
    const street = navPoints.filter((p) => p.y === 0).sort(() => rand() - 0.5);
    playerSpawn = street.find((p) => p.z > half * 0.6) || street[0];
    playerSpawn = playerSpawn.clone();
    for (const p of street) {
      if (mobSpawns.length >= 15) break;
      if ([playerSpawn, ...mobSpawns].every((q) => q.distanceTo(p) > half * 0.35)) mobSpawns.push(p.clone());
    }
  }

  // Inner faces of the perimeter walls get full city-block facades
  const inner = half - 0.5;
  const perimeterFaces = [
    { x: 0, z: -inner, nx: 0, nz: 1, length: size - 2 },
    { x: 0, z: inner, nx: 0, nz: -1, length: size - 2 },
    { x: -inner, z: 0, nx: 1, nz: 0, length: size - 2 },
    { x: inner, z: 0, nx: -1, nz: 0, length: size - 2 },
  ];

  return {
    colliders, group, playerSpawn, mobSpawns, navPoints, navLinks, navJumps,
    facades, perimeterFaces, chimneys, slabs, roofs, rooftopProps, half, lots, ramps,
  };
}
