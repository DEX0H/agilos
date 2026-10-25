import * as THREE from 'three';

// Health pickups: medkits (+100) and syringes (+40) spread over the map, floating over a
// glowing ring. Walk over one while hurt to use it (at full health you leave it for
// later). Taken items come back after a while. Bots go for them when they're hurt.
// Everything is instanced: three draw calls however many items there are.

export const KINDS = {
  medkit: { heal: 100, respawn: 45, label: 'MEDKIT' },
  syringe: { heal: 40, respawn: 25, label: 'SYRINGE' },
};
const MAX = 32;
const REACH = 1.1;       // metres, horizontally
const SPACING = 9;       // between items

function crossTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e9ecef';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#d42a2a';
  ctx.fillRect(25, 12, 14, 40);
  ctx.fillRect(12, 25, 40, 14);
  ctx.strokeStyle = '#9aa1a8';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, 60, 60);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class HealthPickups {
  constructor(scene, world) {
    this.world = world;
    this.items = [];
    const kit = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.46, 0.3, 0.34),
      new THREE.MeshStandardMaterial({ map: crossTexture(), roughness: 0.5, emissive: 0x401010, emissiveIntensity: 0.4 }),
      MAX,
    );
    // Syringe: green glowing barrel with a plunger and needle, merged into one shape
    const parts = [
      new THREE.CylinderGeometry(0.045, 0.045, 0.32, 14),
      new THREE.CylinderGeometry(0.06, 0.06, 0.02, 14).translate(0, 0.17, 0),
      new THREE.CylinderGeometry(0.012, 0.012, 0.12, 6).translate(0, 0.24, 0),
      new THREE.CylinderGeometry(0.004, 0.004, 0.1, 6).translate(0, -0.21, 0),
    ];
    const syr = new THREE.InstancedMesh(
      mergeAll(parts),
      new THREE.MeshStandardMaterial({ color: 0x9cffb4, emissive: new THREE.Color(0.2, 1.1, 0.4), emissiveIntensity: 1, roughness: 0.25, metalness: 0.2 }),
      MAX,
    );
    const ring = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.42, 0.55, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 1.6, 0.6), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX,
    );
    this.meshes = { medkit: kit, syringe: syr, ring };
    for (const m of [kit, syr, ring]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
    }
    kit.castShadow = true;
    this.onPickup = null; // (character, item) => void
  }

  // A new map: spread items over its walkable spots (street and floors)
  setMap(navPoints, half, rand = Math.random) {
    const area = (half * 2) ** 2;
    const count = Math.min(MAX, Math.round(6 * Math.sqrt(area / 3600) * 1.15));
    const pool = [...navPoints];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    this.items = [];
    for (const p of pool) {
      if (this.items.length >= count) break;
      if (this.items.some((it) => it.pos.distanceTo(p) < SPACING)) continue;
      const kind = this.items.length % 3 === 0 ? 'medkit' : 'syringe';
      // Next to the nav point, not on it, so it doesn't block the path visually
      this.items.push({ kind, pos: new THREE.Vector3(p.x + 0.8, p.y, p.z + 0.6), timer: 0, phase: Math.random() * 6 });
    }
  }

  available() {
    return this.items.filter((it) => it.timer <= 0);
  }

  update(dt, t) {
    const m4 = _m4;
    const q = _q;
    const s = _s;
    const p = _p;
    const counts = { medkit: 0, syringe: 0, ring: 0 };
    for (const it of this.items) {
      if (it.timer > 0) {
        it.timer -= dt;
        continue;
      }
      // Anyone hurt who steps on it uses it (on a network client the host decides)
      for (const c of this.follower ? [] : this.world.combatants) {
        if (c.dead || c.health >= c.maxHealth) continue;
        if (Math.abs(c.position.y - it.pos.y) > 1.4) continue;
        if (Math.hypot(c.position.x - it.pos.x, c.position.z - it.pos.z) > REACH) continue;
        c.health = Math.min(c.maxHealth, c.health + KINDS[it.kind].heal);
        it.timer = KINDS[it.kind].respawn;
        if (this.onPickup) this.onPickup(c, it);
        break;
      }
      if (it.timer > 0) continue;
      const bob = Math.sin(t * 2 + it.phase) * 0.06;
      q.setFromAxisAngle(_Y, t * 1.2 + it.phase);
      if (it.kind === 'syringe') q.multiply(_tilt);
      p.set(it.pos.x, it.pos.y + 0.55 + bob, it.pos.z);
      this.meshes[it.kind].setMatrixAt(counts[it.kind]++, m4.compose(p, q, s.set(1, 1, 1)));
      const pulse = 1 + Math.sin(t * 3 + it.phase) * 0.06;
      p.set(it.pos.x, it.pos.y + 0.02, it.pos.z);
      this.meshes.ring.setMatrixAt(counts.ring++, m4.compose(p, _q0, s.set(pulse, 1, pulse)));
    }
    for (const [k, n] of Object.entries(counts)) {
      const mesh = this.meshes[k];
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

const _Y = new THREE.Vector3(0, 1, 0);
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5);

function mergeAll(geos) {
  // Small local merge so this file doesn't need the addons import for four cylinders
  const pos = [];
  const nor = [];
  for (const g of geos) {
    const ng = g.index ? g.toNonIndexed() : g;
    pos.push(...ng.attributes.position.array);
    nor.push(...ng.attributes.normal.array);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}
