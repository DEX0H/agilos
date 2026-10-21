import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RARITY_COLORS } from './gun.js';
import { loadPistol, normalizeGun } from './models.js';

// Low-poly models for the mystery box weapons, built from primitives so they need no
// downloads. Same convention as normalizeGun(): metres, barrel along -Z, origin where
// the hand holds the grip. Returns { object, muzzle }.

let mats = null;
function materials() {
  if (mats) return mats;
  mats = {
    metal: new THREE.MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.35, metalness: 0.8 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.5, metalness: 0.6 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.8, metalness: 0.05 }),
    tan: new THREE.MeshStandardMaterial({ color: 0x8a7656, roughness: 0.75, metalness: 0.05 }),
    olive: new THREE.MeshStandardMaterial({ color: 0x4c5440, roughness: 0.7, metalness: 0.05 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x0c1a24, roughness: 0.05, metalness: 0.9, emissive: 0x1a3c66, emissiveIntensity: 0.6,
    }),
    accent: {},
  };
  for (const [k, c] of Object.entries(RARITY_COLORS)) {
    const col = new THREE.Color(c);
    mats.accent[k] = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.6, roughness: 0.4 });
  }
  return mats;
}

// Magazine parts go in their own group so the reload animation can drop and insert them
function magGroup(g) {
  let mag = g.getObjectByName('mag');
  if (!mag) {
    mag = new THREE.Group();
    mag.name = 'mag';
    g.add(mag);
  }
  return mag;
}

function part(group, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  group.add(m);
  return m;
}

const box = (w, h, d, r = 0.008) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2) * 0.99);
const tube = (r, len, seg = 12) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2);

function smg(g, m, accent) {
  part(g, box(0.06, 0.085, 0.3, 0.012), m.polymer, 0, 0.045, -0.09);       // receiver
  part(g, box(0.052, 0.03, 0.26, 0.006), m.metal, 0, 0.1, -0.09);          // top rail
  part(g, tube(0.016, 0.1), m.dark, 0, 0.055, -0.28);                      // shroud
  part(g, tube(0.009, 0.05), m.metal, 0, 0.055, -0.35);                    // barrel tip
  part(magGroup(g), box(0.038, 0.2, 0.055, 0.006), m.dark, 0, -0.08, -0.13, 0.08); // magazine
  part(g, box(0.042, 0.11, 0.05, 0.012), m.polymer, 0, -0.045, 0.01, 0.3); // grip
  part(g, box(0.05, 0.035, 0.07, 0.006), m.metal, 0, 0.13, -0.06);         // red dot base
  part(g, box(0.045, 0.04, 0.012, 0.004), m.glass, 0, 0.165, -0.06);       // red dot glass
  // Folding stock: two rods and a butt plate
  part(g, tube(0.006, 0.2, 6), m.metal, 0.018, 0.05, 0.16);
  part(g, tube(0.006, 0.2, 6), m.metal, -0.018, 0.05, 0.16);
  part(g, box(0.05, 0.1, 0.02, 0.006), m.polymer, 0, 0.03, 0.27);
  part(g, box(0.062, 0.012, 0.18, 0.004), accent, 0, 0.02, -0.09);        // rarity stripe
  return new THREE.Vector3(0, 0.055, -0.38);
}

function rifle(g, m, accent) {
  part(g, box(0.064, 0.095, 0.36, 0.012), m.tan, 0, 0.05, -0.06);         // receiver
  part(g, box(0.06, 0.075, 0.26, 0.014), m.polymer, 0, 0.055, -0.36);     // handguard
  part(g, box(0.05, 0.022, 0.6, 0.005), m.metal, 0, 0.11, -0.2);          // top rail
  part(g, tube(0.011, 0.14), m.dark, 0, 0.06, -0.55);                     // barrel
  part(g, tube(0.017, 0.05, 8), m.metal, 0, 0.06, -0.63);                 // muzzle brake
  // Curved magazine
  part(magGroup(g), box(0.038, 0.12, 0.07, 0.006), m.dark, 0, -0.05, -0.13, 0.12);
  part(magGroup(g), box(0.038, 0.1, 0.065, 0.006), m.dark, 0, -0.14, -0.105, 0.35);
  part(g, box(0.042, 0.11, 0.05, 0.012), m.polymer, 0, -0.045, 0.02, 0.3); // grip
  part(g, box(0.05, 0.11, 0.24, 0.02), m.tan, 0, 0.03, 0.24);             // stock
  part(g, box(0.055, 0.12, 0.02, 0.006), m.polymer, 0, 0.025, 0.36);      // butt pad
  part(g, box(0.05, 0.05, 0.08, 0.008), m.dark, 0, 0.15, -0.08);          // holo sight body
  part(g, box(0.042, 0.045, 0.01, 0.003), m.glass, 0, 0.165, -0.11);      // holo glass
  part(g, box(0.066, 0.012, 0.22, 0.004), accent, 0, 0.02, -0.06);        // rarity stripe
  return new THREE.Vector3(0, 0.06, -0.66);
}

function sniper(g, m, accent) {
  part(g, box(0.07, 0.09, 0.42, 0.014), m.olive, 0, 0.04, -0.05);        // chassis
  part(g, box(0.06, 0.07, 0.28, 0.016), m.olive, 0, 0.045, -0.38);       // forend
  part(g, tube(0.012, 0.5), m.dark, 0, 0.06, -0.66);                     // long barrel
  part(g, box(0.034, 0.034, 0.08, 0.006), m.metal, 0, 0.06, -0.93);      // muzzle brake
  part(g, box(0.06, 0.12, 0.3, 0.025), m.olive, 0, 0.02, 0.3);           // stock
  part(g, box(0.05, 0.035, 0.16, 0.01), m.polymer, 0, 0.1, 0.27);        // cheek rest
  part(g, box(0.065, 0.14, 0.025, 0.008), m.polymer, 0, 0.0, 0.46);      // butt pad
  part(g, box(0.042, 0.11, 0.05, 0.012), m.polymer, 0, -0.045, 0.06, 0.3); // grip
  part(magGroup(g), box(0.04, 0.06, 0.08, 0.006), m.dark, 0, -0.03, -0.12); // box magazine
  // Bolt handle
  part(g, tube(0.005, 0.06, 6).rotateY(Math.PI / 2), m.metal, 0.05, 0.07, 0.04);
  part(g, new THREE.SphereGeometry(0.011, 10, 8), m.metal, 0.08, 0.07, 0.04);
  // Scope: tube, bells, lenses, mounts
  part(g, tube(0.022, 0.3, 16), m.dark, 0, 0.15, -0.08);
  part(g, tube(0.032, 0.07, 16), m.dark, 0, 0.15, -0.27);
  part(g, tube(0.028, 0.06, 16), m.dark, 0, 0.15, 0.1);
  part(g, tube(0.029, 0.004, 16), m.glass, 0, 0.15, -0.305);
  part(g, tube(0.025, 0.004, 16), m.glass, 0, 0.15, 0.13);
  part(g, box(0.03, 0.06, 0.03, 0.005), m.metal, 0, 0.1, -0.16);
  part(g, box(0.03, 0.06, 0.03, 0.005), m.metal, 0, 0.1, 0.01);
  part(g, box(0.074, 0.014, 0.26, 0.004), accent, 0, 0.015, -0.05);      // rarity stripe
  return new THREE.Vector3(0, 0.06, -0.98);
}

const BUILDERS = { smg, rifle, sniper };

// Real models (Quaternius Ultimate Gun Pack, CC0) that replace the primitive ones once
// loaded: [file, length in metres]. Their magazines aren't separate parts, so the reload
// shows a stand-in magazine dropping out below the gun and a new one going in.
const FBX_MODELS = {
  smg: ['SubmachineGun_3', 0.62],
  rifle: ['AssaultRifle2_1', 0.95],
  sniper: ['SniperRifle_2', 1.35],
};
// Stand-in magazine: size and where it sits relative to the grip
const FAKE_MAGS = {
  smg: [[0.03, 0.17, 0.05], [0, -0.1, -0.1], 0.05],
  rifle: [[0.032, 0.18, 0.07], [0, -0.1, -0.15], 0.2],
  sniper: [[0.035, 0.08, 0.08], [0, -0.06, -0.14], 0],
};

// Returns { object, muzzle, mag, fakeMag, listeners }. `object` is a container: it starts
// with the primitive model and swaps in the real one when it arrives, then calls each
// function in `listeners` so holders can move their muzzle point.
export function buildGunModel(spec) {
  const m = materials();
  const group = new THREE.Group();
  const proc = new THREE.Group();
  group.add(proc);
  const accent = m.accent[spec.rarity] || m.accent.common;
  const muzzle = BUILDERS[spec.model](proc, m, accent);
  const entry = { object: group, muzzle, mag: proc.getObjectByName('mag'), fakeMag: false, magHome: null, listeners: [] };

  const def = FBX_MODELS[spec.model];
  if (def) {
    loadPistol(def[0]).then((src) => {
      const { object, muzzle: mz } = normalizeGun(src, def[1]);
      group.add(object);
      proc.visible = false;
      // Thin rarity stripe along the left side so the colour still reads
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.012, def[1] * 0.3), accent);
      stripe.position.set(-0.03, 0.0, -def[1] * 0.2);
      group.add(stripe);
      const [size, pos, tilt] = FAKE_MAGS[spec.model];
      const mag = new THREE.Mesh(box(...size, 0.006), m.dark);
      mag.position.set(...pos);
      mag.rotation.x = tilt;
      mag.visible = false;
      group.add(mag);
      entry.muzzle.copy(mz);
      entry.mag = mag;
      entry.fakeMag = true;
      entry.magHome = mag.position.clone();
      for (const fn of entry.listeners) fn(entry);
    }).catch((e) => console.warn(`Gun model ${def[0]} failed to load; keeping the simple one`, e));
  }
  return entry;
}
