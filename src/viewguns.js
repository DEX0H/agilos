import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RARITY_COLORS } from './gun.js';

// Detailed first-person guns, modelled in code in the spirit of CS:GO's viewmodels:
// a USP/Glock-style pistol with iron sights, an M4-style rifle with a red dot, a compact
// SMG with a holographic sight, and an AWP-style green sniper with a big scope.
// Shapes are side profiles extruded and bevelled, plus machined details (rails, slots,
// serrations, ports), with fine surface noise so the metal and polymer catch the light.
//
// Convention (same as the other gun models): metres, barrel along -Z, y up, origin at the
// hand on the grip. Each gun returns:
//   object   the model (a Group)
//   muzzle   barrel tip, in object space
//   mag      the magazine group (dropped and reinserted by the reload animation)
//   slide    moving part that kicks back on each shot (pistol slide, rifle bolt carrier)
//   sight    { x, y, z }: the point that lines up with the screen centre when aiming
//            (front post tip / red dot / holo ring), `dist`: how far in front of your eye
//            it sits, `tilt`: optional pitch of the gun while aiming
//   view     { pos, scale, hip }: where the model sits in the viewmodel, and where the
//            viewmodel sits on screen at the hip (CS:GO-like: big, lower right)

// ---- Surface detail: tiny noise normal maps so surfaces aren't flat plastic ----
function noiseNormal(size, strength, blur) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = Math.random();
  // A little blur so it reads as a finish, not static
  for (let pass = 0; pass < blur; pass++) {
    const t = h.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += t[((y + dy + size) % size) * size + ((x + dx + size) % size)];
        h[y * size + x] = s / 9;
      }
    }
  }
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)]) * strength;
      const dy = (h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x]) * strength;
      const i = (y * size + x) * 4;
      img.data[i] = 128 - dx * 127;
      img.data[i + 1] = 128 - dy * 127;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  return tex;
}

let M = null;
function materials() {
  if (M) return M;
  const fine = noiseNormal(128, 1.2, 1);
  const stipple = noiseNormal(128, 3.5, 0);
  // Reflections a bit stronger than the world's, so dark finishes still show their shape
  const std = (o) => new THREE.MeshStandardMaterial({ normalMap: fine, normalScale: new THREE.Vector2(0.25, 0.25), envMapIntensity: 1.8, ...o });
  M = {
    // Parkerized steel and anodised aluminium: dark, slightly metallic, satin
    steel: std({ color: 0x45484d, metalness: 0.8, roughness: 0.34 }),
    alloy: std({ color: 0x3a3d41, metalness: 0.6, roughness: 0.42 }),
    bright: std({ color: 0xa4a8ae, metalness: 0.95, roughness: 0.22 }), // bore, bolt face, slide back
    polymer: std({ color: 0x2c2d30, metalness: 0.0, roughness: 0.6 }),
    grip: new THREE.MeshStandardMaterial({ color: 0x2a2b2e, metalness: 0, roughness: 0.8, envMapIntensity: 1.5, normalMap: stipple, normalScale: new THREE.Vector2(0.9, 0.9) }),
    green: std({ color: 0x4d5a3c, metalness: 0.05, roughness: 0.62 }), // AWP furniture
    black: new THREE.MeshStandardMaterial({ color: 0x050506, metalness: 0, roughness: 0.9, side: THREE.DoubleSide }), // ports, slots, holes, sight tubes
    white: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.15, 1.6, 0.35) }), // tritium night-sight dots
    // Reticle: a saturated red that survives tone mapping (too bright and it turns white)
    red: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.9, 0.03, 0.02), fog: false }),
    glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.02, 0.01), transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    lens: new THREE.MeshPhysicalMaterial({
      color: 0x99d6c8, metalness: 0, roughness: 0.05, transparent: true, opacity: 0.1, depthWrite: false,
    }),
    // The front glass of the red dot / holo: clear with a faint blue-green coating tint
    window: new THREE.MeshPhysicalMaterial({
      color: 0x5fa8b8, metalness: 0.2, roughness: 0.04, transparent: true, opacity: 0.16, depthWrite: false, envMapIntensity: 2,
    }),
    coated: new THREE.MeshStandardMaterial({ color: 0x0b1a26, metalness: 0.9, roughness: 0.05, emissive: 0x0a2440, emissiveIntensity: 0.5 }),
    accent: {},
  };
  for (const [k, c] of Object.entries(RARITY_COLORS)) {
    M.accent[k] = new THREE.MeshStandardMaterial({ color: new THREE.Color(c), metalness: 0.4, roughness: 0.35, emissive: new THREE.Color(c), emissiveIntensity: 0.25 });
  }
  return M;
}

// ---- Geometry helpers ----
// Side profile in (z, y) extruded `w` wide across x, centred, with a small bevel
function profile(points, w, bevel = 0.0025, holes = []) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([z, y]) => new THREE.Vector2(z, y))));
  const b = Math.min(bevel, w * 0.3);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.0005, w - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 10,
  });
  // Shape x -> world z, extrusion -> world x, centred on x = 0
  geo.rotateY(-Math.PI / 2);
  geo.translate((w - 2 * b) / 2, 0, 0);
  return geo;
}
const rbox = (w, h, d, r = 0.003) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.01, h / 2.01, d / 2.01));
const cyl = (r, len, seg = 20, r2 = r) => new THREE.CylinderGeometry(r2, r, len, seg).rotateX(Math.PI / 2); // along z, r at +z end
const tubeOpen = (r, len, seg = 28) => new THREE.CylinderGeometry(r, r, len, seg, 1, true).rotateX(Math.PI / 2);

class Builder {
  constructor() {
    this.group = new THREE.Group();
    this.byMat = new Map();
  }
  // Static parts are merged per material at the end (few draw calls, lots of detail)
  add(geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const n of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(n)) g.deleteAttribute(n);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
    if (!this.byMat.has(mat)) this.byMat.set(mat, []);
    this.byMat.get(mat).push(g);
  }
  // A separately moving part (magazine, slide); its own builder, merged the same way
  sub(name) {
    const b = new Builder();
    b.group.name = name;
    this.group.add(b.group);
    (this.subs ||= []).push(b);
    return b;
  }
  // Repeat a part along z (rails, serrations, slots)
  row(geo, mat, x, y, z0, z1, n, ry = 0) {
    for (let i = 0; i < n; i++) this.add(geo, mat, x, y, z0 + ((z1 - z0) * i) / Math.max(1, n - 1), 0, ry);
  }
  build() {
    for (const [mat, list] of this.byMat) {
      const mesh = new THREE.Mesh(mergeGeometries(list, false), mat);
      for (const g of list) g.dispose();
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      if (mat.transparent) mesh.renderOrder = 3;
      this.group.add(mesh);
    }
    for (const s of this.subs || []) s.build();
    return this.group;
  }
}

// Picatinny rail: base with cross slots
function rail(b, m, y, z0, z1, w = 0.021) {
  const len = z0 - z1;
  b.add(rbox(w, 0.005, len, 0.001), m.alloy, 0, y + 0.0025, (z0 + z1) / 2);
  const n = Math.floor(len / 0.0105);
  b.row(rbox(w + 0.003, 0.0045, 0.0052, 0.0008), m.alloy, 0, y + 0.0065, z0 - 0.005, z1 + 0.005, n);
}

// ---- Pistol: USP/Glock-like, iron sights with white dots ----
function pistol(m, accent) {
  const b = new Builder();
  const slide = b.sub('slide');
  // Slide: bore at y = 0.018; top flat at 0.031; tapered nose
  slide.add(profile([[0.07, 0.004], [0.07, 0.031], [-0.104, 0.031], [-0.118, 0.026], [-0.12, 0.004]], 0.025, 0.003), m.steel, 0, 0, 0);
  // Rear serrations, both sides
  for (const sx of [-1, 1]) slide.row(rbox(0.0015, 0.02, 0.0018, 0.0004), m.black, sx * 0.0122, 0.018, 0.064, 0.036, 8);
  // Ejection port with the barrel hood showing
  slide.add(rbox(0.012, 0.0025, 0.03, 0.0008), m.black, 0.004, 0.0305, -0.005);
  slide.add(rbox(0.0105, 0.002, 0.026, 0.0008), m.bright, 0.004, 0.0298, -0.006);
  // Front sight post with a white dot facing you
  slide.add(rbox(0.0035, 0.0065, 0.004, 0.0006), m.steel, 0, 0.0342, -0.108);
  slide.add(new THREE.CircleGeometry(0.0013, 14), m.white, 0, 0.0352, -0.1059);
  // Rear sight: two ears with a notch, white dots
  for (const sx of [-1, 1]) {
    slide.add(rbox(0.0068, 0.0065, 0.006, 0.0008), m.steel, sx * 0.0055, 0.0342, 0.062);
    slide.add(new THREE.CircleGeometry(0.0012, 14), m.white, sx * 0.0055, 0.0352, 0.0651);
  }
  // Back of the slide: a machined end plate with the striker cover, cocking serrations
  slide.add(rbox(0.021, 0.022, 0.003, 0.0012), m.bright, 0, 0.0175, 0.0705);
  slide.add(rbox(0.008, 0.012, 0.0015, 0.0006), m.steel, 0, 0.016, 0.0722);
  slide.row(rbox(0.023, 0.0012, 0.0012, 0.0003), m.black, 0, 0.025, 0.072, 0.072, 1);
  slide.add(rbox(0.026, 0.002, 0.07, 0.0008), m.bright, 0, 0.0312, -0.02);       // flat top strip
  // Barrel crown in the nose
  slide.add(cyl(0.0058, 0.006, 16), m.black, 0, 0.018, -0.1205);
  slide.add(new THREE.TorusGeometry(0.0062, 0.0011, 6, 18), m.bright, 0, 0.018, -0.1209);

  // Frame (polymer) with dust cover rail and the trigger guard
  b.add(profile([[0.06, 0.004], [0.06, -0.006], [-0.02, -0.006], [-0.03, -0.012], [-0.112, -0.012], [-0.112, 0.004]], 0.024, 0.0025), m.polymer);
  b.row(rbox(0.018, 0.003, 0.004, 0.0006), m.polymer, 0, -0.0135, -0.04, -0.1, 5);
  b.add(profile([[-0.002, -0.006], [-0.062, -0.012], [-0.068, -0.03], [-0.052, -0.044], [0.0, -0.044], [0.008, -0.03]], 0.012, 0.002,
    [[[-0.006, -0.014], [-0.052, -0.016], [-0.058, -0.03], [-0.048, -0.038], [-0.004, -0.038], [0.002, -0.028]]]), m.polymer);
  b.add(profile([[-0.016, -0.012], [-0.02, -0.024], [-0.014, -0.034], [-0.012, -0.034], [-0.017, -0.024], [-0.012, -0.012]], 0.005, 0.001), m.steel); // trigger
  // Beavertail over the web of the hand
  b.add(profile([[0.058, -0.004], [0.078, -0.006], [0.082, -0.014], [0.064, -0.016]], 0.022, 0.002), m.polymer);
  // Grip, angled back, stippled, with finger grooves on the front strap
  b.add(profile([[0.06, -0.006], [0.07, -0.02], [0.084, -0.11], [0.072, -0.122], [0.03, -0.122], [0.012, -0.044], [0.0, -0.006]], 0.028, 0.004), m.grip);
  for (let i = 0; i < 3; i++) b.add(rbox(0.029, 0.004, 0.006, 0.0015), m.polymer, 0, -0.06 - i * 0.02, 0.016 + i * 0.004);
  b.add(rbox(0.0045, 0.012, 0.002, 0.0005), accent, 0.0145, -0.08, 0.06); // rarity inlay
  // Magazine: shows below the grip as a base plate; the body sits inside the grip
  const mag = b.sub('mag');
  mag.add(rbox(0.022, 0.1, 0.03, 0.002), m.steel, 0, -0.07, 0.048, 0.2);
  mag.add(rbox(0.03, 0.008, 0.044, 0.002), m.polymer, 0, -0.126, 0.052);

  b.build();
  return {
    object: b.group, slide: slide.group, mag: mag.group,
    muzzle: new THREE.Vector3(0, 0.018, -0.124),
    // Aim point: the front post's tip; the gun tilts a little toward you so you see the
    // top of the slide and the front post sits in the rear notch
    sight: { x: 0, y: 0.0374, z: -0.108, dist: 0.47, tilt: -0.035 },
    // Arms: grip targets for the IK hands (wrist position, finger direction f, palm
    // normal n, in gun space), the finger curl, and shoulder / elbow hints (camera space)
    arms: {
      right: { palm: [0, -0.042, 0.048], pos: [0.016, -0.088, 0.098], f: [-0.12, 0.42, -0.9], n: [-1, 0, -0.1], curl: 'trigger', shoulder: [0.2, -0.34, 0.16], pole: [0.42, -0.62, 0.1] },
      left: { fromPose: true, pos: [-0.03, -0.105, 0.075], f: [0.35, 0.4, -0.85], n: [1, 0.1, 0], curl: 'cup', shoulder: [-0.18, -0.36, 0.14], pole: [-0.42, -0.62, 0.05] },
      mag: { pos: [-0.02, -0.17, 0.08], f: [0.2, 0.9, -0.3], n: [1, 0, 0] },
    },
    view: { pos: new THREE.Vector3(0, -0.02, 0.02), scale: 1.15, hip: { x: 0.1, y: -0.055, z: -0.27 } },
  };
}

// ---- Rifle: M4-style with a red dot ----
function rifle(m, accent) {
  const b = new Builder();
  // Upper receiver (bore y = 0) with forward assist and ejection port
  b.add(profile([[0.12, -0.016], [0.12, 0.024], [0.1, 0.03], [-0.13, 0.03], [-0.13, -0.016]], 0.03, 0.003), m.alloy);
  rail(b, m, 0.03, 0.115, -0.13);
  b.add(cyl(0.007, 0.03, 12), m.alloy, 0.018, 0.012, 0.075, 0, 0.35);           // forward assist
  b.add(rbox(0.002, 0.014, 0.05, 0.0006), m.black, 0.0152, 0.004, 0.02);         // ejection port
  b.add(rbox(0.0012, 0.013, 0.046, 0.0005), m.bright, 0.0155, 0.004, 0.02);      // bolt carrier
  b.add(rbox(0.02, 0.008, 0.02, 0.002), m.alloy, 0, 0.026, 0.13);                // charging handle
  b.add(rbox(0.036, 0.006, 0.01, 0.002), m.alloy, 0, 0.026, 0.142);
  // Lower receiver, magwell, trigger guard, trigger
  b.add(profile([[0.105, -0.016], [0.105, -0.05], [0.04, -0.05], [0.02, -0.04], [-0.035, -0.04], [-0.04, -0.075], [-0.1, -0.075], [-0.105, -0.016]], 0.029, 0.003), m.alloy);
  b.add(profile([[0.04, -0.05], [-0.032, -0.05], [-0.032, -0.064], [0.04, -0.066]], 0.01, 0.0015, [[[0.034, -0.054], [-0.026, -0.054], [-0.026, -0.06], [0.034, -0.061]]]), m.alloy);
  b.add(profile([[0.012, -0.04], [0.008, -0.056], [0.014, -0.06], [0.016, -0.058], [0.014, -0.04]], 0.005, 0.001), m.steel);
  b.add(rbox(0.031, 0.004, 0.06, 0.001), m.black, 0, -0.016, -0.04);              // receiver seam
  // Pistol grip
  b.add(profile([[0.05, -0.05], [0.085, -0.05], [0.11, -0.142], [0.096, -0.152], [0.074, -0.152], [0.048, -0.06]], 0.028, 0.004), m.grip);
  // Handguard: free-float, octagonal, M-LOK slots, rail on top
  b.add(cyl(0.024, 0.3, 8), m.alloy, 0, 0.002, -0.28, 0, 0, Math.PI / 8);
  rail(b, m, 0.024, -0.135, -0.42);
  for (const sx of [-1, 1]) b.row(rbox(0.004, 0.007, 0.022, 0.002), m.black, sx * 0.0222, -0.004, -0.17, -0.39, 6);
  b.row(rbox(0.012, 0.004, 0.022, 0.002), m.black, 0, -0.0215, -0.17, -0.39, 6);
  // Barrel, gas block, flash hider with slots
  b.add(cyl(0.0078, 0.12, 16), m.steel, 0, 0, -0.49);
  b.add(rbox(0.022, 0.026, 0.02, 0.003), m.steel, 0, 0.002, -0.44);
  b.add(cyl(0.011, 0.055, 16), m.steel, 0, 0, -0.575);
  for (let i = 0; i < 4; i++) b.add(rbox(0.0025, 0.024, 0.032, 0.001), m.black, 0, 0, -0.585, 0, 0, (i * Math.PI) / 4);
  b.add(cyl(0.0045, 0.004, 12), m.black, 0, 0, -0.6025);
  // Buffer tube and collapsible stock
  b.add(cyl(0.0145, 0.2, 18), m.alloy, 0, -0.004, 0.215);
  b.add(profile([[0.2, -0.022], [0.2, 0.018], [0.33, 0.022], [0.345, 0.02], [0.345, -0.075], [0.33, -0.078], [0.28, -0.05], [0.24, -0.035]], 0.036, 0.005,
    [[[0.29, -0.025], [0.325, -0.02], [0.325, -0.055], [0.3, -0.045]]]), m.polymer);
  b.add(rbox(0.04, 0.1, 0.012, 0.004), m.grip, 0, -0.028, 0.352);                // butt pad
  b.add(rbox(0.004, 0.006, 0.07, 0.001), accent, 0.0165, 0.016, -0.04);           // rarity inlay
  // Red dot: mount, open tube (you look through it), lenses, reticle
  const sy = 0.0725;
  b.add(rbox(0.024, 0.016, 0.04, 0.002), m.alloy, 0, 0.044, -0.03);
  b.add(rbox(0.03, 0.006, 0.03, 0.002), m.alloy, 0, 0.038, -0.03);
  b.add(tubeOpen(0.0175, 0.05), m.alloy, 0, sy, -0.03);
  b.add(tubeOpen(0.0162, 0.05), m.black, 0, sy, -0.03);
  for (const z of [-0.055, -0.005]) b.add(new THREE.TorusGeometry(0.0172, 0.0022, 8, 28), m.alloy, 0, sy, z);
  b.add(rbox(0.012, 0.008, 0.01, 0.002), m.alloy, 0, sy + 0.019, -0.03);          // elevation turret
  b.add(cyl(0.0055, 0.008, 14).rotateY(Math.PI / 2), m.alloy, 0.021, sy, -0.03);  // windage turret
  b.add(new THREE.CircleGeometry(0.016, 28), m.window, 0, sy, -0.0545);          // front glass
  b.add(new THREE.CircleGeometry(0.016, 28), m.lens, 0, sy, -0.006);
  b.add(new THREE.CircleGeometry(0.0019, 16), m.red, 0, sy, -0.05);               // the dot
  b.add(new THREE.CircleGeometry(0.0042, 20), m.glow, 0, sy, -0.0499);            // its glow
  // Magazine: curved STANAG with ribs
  const mag = b.sub('mag');
  mag.add(profile([[-0.04, -0.074], [-0.098, -0.074], [-0.122, -0.22], [-0.064, -0.226]], 0.023, 0.002), m.alloy);
  for (let i = 0; i < 3; i++) mag.add(rbox(0.0245, 0.003, 0.05, 0.001), m.alloy, 0, -0.12 - i * 0.03, -0.084 - i * 0.005, -0.12);
  mag.add(rbox(0.027, 0.008, 0.064, 0.002), m.polymer, 0, -0.226, -0.094, -0.15);
  // Bolt carrier "slide" barely moves; the charging handle kicks instead
  const slide = b.sub('slide');
  slide.add(rbox(0.004, 0.004, 0.01, 0.001), m.bright, 0.0162, 0.004, 0.03);

  b.build();
  return {
    object: b.group, slide: slide.group, mag: mag.group,
    muzzle: new THREE.Vector3(0, 0, -0.605),
    sight: { x: 0, y: sy, z: -0.05, dist: 0.18 },
    arms: {
      right: { palm: [0, -0.085, 0.086], pos: [0.017, -0.14, 0.14], f: [-0.12, 0.55, -0.83], n: [-1, 0, -0.1], curl: 'trigger', shoulder: [0.24, -0.33, 0.16], pole: [0.48, -0.6, 0.1] },
      left: { cradle: { at: [0, -0.01, -0.33], f: [0.45, -0.15, -0.88], n: [0.7, 0.7, 0] }, pos: [-0.085, -0.05, -0.258], f: [1, 0.15, -0.35], n: [0, 1, 0], curl: 'support', shoulder: [-0.32, -0.36, 0.02], pole: [-0.15, -0.7, -0.1] },
      mag: { pos: [-0.02, -0.27, -0.07], f: [0.25, 0.9, -0.35], n: [1, 0, 0] },
    },
    view: { pos: new THREE.Vector3(0, 0.035, -0.06), scale: 0.78, hip: { x: 0.16, y: -0.135, z: -0.29 } },
  };
}

// ---- SMG: compact, holographic sight with ring and dot ----
function smg(m, accent) {
  const b = new Builder();
  b.add(profile([[0.08, -0.03], [0.08, 0.026], [0.065, 0.03], [-0.17, 0.03], [-0.19, 0.02], [-0.19, -0.03]], 0.036, 0.004), m.polymer);
  rail(b, m, 0.03, 0.075, -0.17, 0.019);
  for (const sx of [-1, 1]) b.row(rbox(0.003, 0.012, 0.012, 0.002), m.black, sx * 0.0175, -0.004, -0.06, -0.16, 5);
  b.add(rbox(0.002, 0.012, 0.035, 0.0006), m.black, 0.0185, 0.012, 0.01);          // ejection port
  b.add(cyl(0.0075, 0.06, 16), m.steel, 0, 0.002, -0.215);
  b.add(cyl(0.0105, 0.03, 16), m.steel, 0, 0.002, -0.245);
  b.add(cyl(0.004, 0.004, 12), m.black, 0, 0.002, -0.2605);
  // Vertical fore grip
  b.add(cyl(0.012, 0.075, 16).rotateX(Math.PI / 2), m.grip, 0, -0.068, -0.13);
  b.add(cyl(0.014, 0.008, 16).rotateX(Math.PI / 2), m.polymer, 0, -0.106, -0.13);
  // Trigger guard + grip
  b.add(profile([[0.03, -0.03], [-0.035, -0.03], [-0.035, -0.046], [0.03, -0.048]], 0.01, 0.0015, [[[0.024, -0.034], [-0.029, -0.034], [-0.029, -0.042], [0.024, -0.043]]]), m.polymer);
  b.add(profile([[0.04, -0.03], [0.07, -0.03], [0.092, -0.125], [0.078, -0.134], [0.058, -0.134], [0.034, -0.04]], 0.028, 0.004), m.grip);
  // Folding stock rods and butt plate
  for (const sx of [-1, 1]) b.add(cyl(0.0042, 0.2, 10), m.steel, sx * 0.014, 0.008, 0.18);
  b.add(rbox(0.04, 0.075, 0.012, 0.004), m.polymer, 0, -0.012, 0.284);
  b.add(rbox(0.004, 0.006, 0.06, 0.001), accent, 0.0185, -0.018, -0.05);
  // Holographic sight: base, hood, window, reticle ring + dot
  const sy = 0.068;
  b.add(rbox(0.03, 0.012, 0.06, 0.003), m.alloy, 0, 0.039, -0.05);
  for (const sx of [-1, 1]) b.add(rbox(0.004, 0.034, 0.05, 0.0015), m.alloy, sx * 0.0175, 0.06, -0.05);
  b.add(rbox(0.039, 0.004, 0.05, 0.0015), m.alloy, 0, 0.078, -0.05);
  b.add(new THREE.PlaneGeometry(0.031, 0.028), m.window, 0, sy - 0.001, -0.074);
  b.add(new THREE.PlaneGeometry(0.031, 0.028), m.lens, 0, sy - 0.001, -0.028);
  b.add(new THREE.RingGeometry(0.0046, 0.0054, 32), m.red, 0, sy, -0.07);
  b.add(new THREE.CircleGeometry(0.001, 12), m.red, 0, sy, -0.0699);
  b.add(new THREE.CircleGeometry(0.0072, 32), m.glow, 0, sy, -0.0698);
  const mag = b.sub('mag');
  mag.add(profile([[-0.03, -0.03], [-0.07, -0.03], [-0.08, -0.17], [-0.046, -0.172]], 0.022, 0.002), m.steel);
  mag.add(rbox(0.025, 0.008, 0.042, 0.002), m.polymer, 0, -0.172, -0.063, -0.08);
  const slide = b.sub('slide');
  slide.add(rbox(0.006, 0.006, 0.012, 0.0015), m.steel, 0, 0.034, 0.07);          // cocking knob

  b.build();
  return {
    object: b.group, slide: slide.group, mag: mag.group,
    muzzle: new THREE.Vector3(0, 0.002, -0.262),
    sight: { x: 0, y: sy, z: -0.07, dist: 0.22 },
    arms: {
      right: { palm: [0, -0.07, 0.064], pos: [0.016, -0.125, 0.115], f: [-0.12, 0.5, -0.86], n: [-1, 0, -0.1], curl: 'trigger', shoulder: [0.24, -0.33, 0.16], pole: [0.48, -0.6, 0.1] },
      left: { mirror: { palm: [0, -0.07, -0.13], turn: 0.22, inset: -0.002, wrapIndex: true }, pos: [-0.035, -0.11, -0.065], f: [0.12, 0.5, -0.86], n: [1, 0, 0], curl: 'fist', shoulder: [-0.3, -0.37, 0.04], pole: [-0.62, -0.5, -0.1] },
      mag: { pos: [-0.02, -0.2, -0.04], f: [0.25, 0.9, -0.35], n: [1, 0, 0] },
    },
    view: { pos: new THREE.Vector3(0, 0.03, -0.03), scale: 0.95, hip: { x: 0.155, y: -0.13, z: -0.29 } },
  };
}

// ---- Sniper: AWP-style green thumbhole stock, fluted barrel, big scope ----
function sniper(m, accent) {
  const b = new Builder();
  // One-piece stock with a thumbhole and forend
  b.add(profile([
    [0.44, 0.012], [0.44, -0.11], [0.4, -0.112], [0.25, -0.05], [0.14, -0.05], [0.115, -0.14], [0.085, -0.142], [0.07, -0.05],
    [-0.08, -0.04], [-0.33, -0.032], [-0.34, -0.012], [-0.08, -0.006], [0.12, -0.006], [0.2, 0.028], [0.36, 0.03],
  ], 0.05, 0.006, [[[0.22, -0.012], [0.33, 0.006], [0.33, -0.04], [0.26, -0.05], [0.2, -0.032]]]), m.green);
  b.add(rbox(0.054, 0.12, 0.016, 0.005), m.polymer, 0, -0.04, 0.446);             // recoil pad
  b.add(rbox(0.04, 0.012, 0.12, 0.003), m.green, 0, 0.04, 0.3);                   // cheek riser
  // Receiver, bolt with knob, trigger guard, magazine well
  b.add(cyl(0.019, 0.22, 20), m.steel, 0, 0.012, -0.0);
  b.add(rbox(0.004, 0.012, 0.06, 0.001), m.black, 0.0185, 0.016, 0.0);
  b.add(cyl(0.004, 0.05, 10).rotateY(Math.PI / 2), m.bright, 0.035, 0.018, 0.075);
  b.add(new THREE.SphereGeometry(0.0095, 14, 10), m.steel, 0.062, 0.016, 0.075);
  b.add(profile([[0.06, -0.04], [-0.01, -0.04], [-0.01, -0.056], [0.06, -0.058]], 0.012, 0.0015, [[[0.054, -0.044], [-0.004, -0.044], [-0.004, -0.052], [0.054, -0.053]]]), m.steel);
  // Barrel: long, fluted, muzzle brake with ports
  b.add(cyl(0.0115, 0.42, 20), m.steel, 0, 0.012, -0.32);
  for (let i = 0; i < 6; i++) b.add(rbox(0.0035, 0.0035, 0.22, 0.001), m.black, Math.cos((i * Math.PI) / 3) * 0.0112, 0.012 + Math.sin((i * Math.PI) / 3) * 0.0112, -0.3);
  b.add(rbox(0.03, 0.026, 0.07, 0.004), m.steel, 0, 0.012, -0.565);
  for (const sx of [-1, 1]) b.row(rbox(0.004, 0.016, 0.01, 0.001), m.black, sx * 0.0145, 0.012, -0.545, -0.585, 3);
  b.add(cyl(0.006, 0.004, 12), m.black, 0, 0.012, -0.6005);
  b.add(rbox(0.004, 0.008, 0.1, 0.001), accent, 0.0255, -0.02, 0.18);
  // Scope: tube, bells, turrets, rings, lenses
  const sy = 0.078;
  b.add(cyl(0.0155, 0.24, 24), m.alloy, 0, sy, -0.02);
  b.add(cyl(0.0255, 0.08, 28, 0.0155), m.alloy, 0, sy, -0.18);
  b.add(cyl(0.0255, 0.03, 28), m.alloy, 0, sy, -0.235);
  b.add(cyl(0.0155, 0.07, 24, 0.019), m.alloy, 0, sy, 0.13);
  b.add(cyl(0.0105, 0.016, 16).rotateX(-Math.PI / 2), m.alloy, 0, sy + 0.022, -0.03);
  b.add(cyl(0.0095, 0.016, 16).rotateY(Math.PI / 2), m.alloy, 0.022, sy, -0.03);
  for (const z of [-0.08, 0.04]) {
    b.add(new THREE.TorusGeometry(0.0175, 0.004, 8, 24), m.steel, 0, sy, z);
    b.add(rbox(0.016, 0.03, 0.018, 0.002), m.steel, 0, sy - 0.03, z);
  }
  b.add(new THREE.CircleGeometry(0.0235, 28), m.coated, 0, sy, -0.2505);
  b.add(new THREE.CircleGeometry(0.017, 24), m.coated, 0, sy, 0.1655);
  const mag = b.sub('mag');
  mag.add(rbox(0.032, 0.05, 0.075, 0.003), m.steel, 0, -0.06, -0.05);
  mag.add(rbox(0.036, 0.008, 0.08, 0.002), m.polymer, 0, -0.088, -0.05);
  const slide = b.sub('slide');
  slide.add(rbox(0.002, 0.002, 0.002, 0.0005), m.steel, 0, 0, 0);

  b.build();
  return {
    object: b.group, slide: slide.group, mag: mag.group,
    muzzle: new THREE.Vector3(0, 0.012, -0.602),
    sight: { x: 0, y: sy, z: 0.165, dist: 0.08 },
    arms: {
      right: { palm: [0, -0.078, 0.102], pos: [0.02, -0.13, 0.15], f: [-0.12, 0.6, -0.79], n: [-1, 0, -0.1], curl: 'trigger', shoulder: [0.24, -0.33, 0.16], pole: [0.48, -0.6, 0.1] },
      left: { cradle: { at: [0, 0.0, -0.24], f: [0.45, -0.15, -0.88], n: [0.7, 0.7, 0] }, pos: [-0.09, -0.066, -0.168], f: [1, 0.15, -0.35], n: [0, 1, 0], curl: 'support', shoulder: [-0.32, -0.36, 0.02], pole: [-0.15, -0.7, -0.1] },
      mag: { pos: [-0.02, -0.13, -0.02], f: [0.25, 0.9, -0.35], n: [1, 0, 0] },
    },
    view: { pos: new THREE.Vector3(0, 0.02, -0.02), scale: 0.72, hip: { x: 0.17, y: -0.14, z: -0.31 } },
  };
}

const BUILDERS = { pistol, rifle, smg, sniper };

export function buildViewGun(spec) {
  const m = materials();
  const accent = m.accent[spec.rarity] || m.bright;
  const e = BUILDERS[spec.model](m, accent);
  e.object.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  e.magHome = e.mag.position.clone();
  e.slideHome = e.slide.position.clone();
  return e;
}
