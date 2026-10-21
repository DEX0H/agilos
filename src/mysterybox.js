import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BOX_WEAPONS, RARITY_COLORS, rollBoxWeapon } from './gun.js';
import { buildGunModel } from './gunmodels.js';

// Mystery boxes: a few crates placed at random spots against walls each match. Use one
// and it spins through the weapons for a moment, then the one it lands on goes straight
// into your hands. Afterwards the box recharges before it can be used again.

export const BOX_COUNT = 4;
export const USE_RANGE = 2.3;       // metres from the box centre
const SPIN_TIME = 1.1;              // short spin, then the weapon is equipped
const SHOW_TIME = 0.9;              // the result hovers a moment after it is handed over
const COOLDOWN = 20;                // seconds before the same box can be used again
const MIN_SPACING = 12;             // metres between boxes

const LEN = 1.3;                    // box size: long side, height, depth
const HGT = 0.62;
const DEP = 0.66;
const DIRS = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const BEAM_HEIGHT = 26;
const BEAM_READY = new THREE.Color(0.2, 0.65, 1.0);
const BEAM_USED = new THREE.Color(0.6, 0.16, 0.12);
const BULBS = 28;                   // casino marquee bulbs around the lid edge
const RARITY = Object.fromEntries(Object.entries(RARITY_COLORS).map(([k, c]) => [k, new THREE.Color(c)]));
const BULB_IDLE = new THREE.Color(1.0, 0.72, 0.35);
const _c = new THREE.Color();
const _m = new THREE.Matrix4();

const _v = new THREE.Vector3();
const _box = new THREE.Box3();

function questionTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#120d0a';
  ctx.fillRect(0, 0, 256, 128);
  ctx.font = '700 104px Teko, Rajdhani, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#5fe1ff';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#bff4ff';
  for (const x of [52, 128, 204]) ctx.fillText('?', x, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function beamTexture() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0.9)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

let shared = null;
function sharedAssets() {
  if (shared) return shared;
  const q = questionTexture();
  shared = {
    wood: new THREE.MeshStandardMaterial({ color: 0x3d2a1b, roughness: 0.8, metalness: 0.05 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xb38a3e, roughness: 0.3, metalness: 0.9 }),
    panel: new THREE.MeshStandardMaterial({
      map: q, emissiveMap: q, emissive: 0xffffff, emissiveIntensity: 1.4, roughness: 0.6,
    }),
    beamTex: beamTexture(),
    body: new RoundedBoxGeometry(LEN, HGT, DEP, 2, 0.04),
    lid: new RoundedBoxGeometry(LEN + 0.04, 0.09, DEP + 0.04, 2, 0.03),
    post: new THREE.BoxGeometry(0.06, HGT + 0.02, 0.06),
    band: new THREE.BoxGeometry(LEN + 0.03, 0.05, DEP + 0.03),
  };
  return shared;
}

class MysteryBox {
  constructor(scene) {
    const a = sharedAssets();
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    const body = new THREE.Mesh(a.body, a.wood);
    body.position.y = HGT / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const p = new THREE.Mesh(a.post, a.trim);
        p.position.set(sx * (LEN / 2 - 0.02), HGT / 2, sz * (DEP / 2 - 0.02));
        this.group.add(p);
      }
    }
    for (const y of [0.06, HGT - 0.06]) {
      const b = new THREE.Mesh(a.band, a.trim);
      b.position.y = y;
      this.group.add(b);
    }
    // Glowing "?" panels on both long sides
    for (const side of [1, -1]) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(LEN * 0.82, HGT * 0.62), this.panelMat ||= a.panel.clone());
      panel.position.set(0, HGT / 2, side * (DEP / 2 + 0.018));
      if (side < 0) panel.rotation.y = Math.PI;
      this.group.add(panel);
    }

    // Lid, hinged along the back edge (local -Z, against the wall)
    this.hinge = new THREE.Group();
    this.hinge.position.set(0, HGT, -DEP / 2);
    const lid = new THREE.Mesh(a.lid, a.wood);
    lid.position.set(0, 0.045, DEP / 2);
    lid.castShadow = true;
    this.hinge.add(lid);
    const lidTrim = new THREE.Mesh(new THREE.BoxGeometry(LEN + 0.06, 0.03, 0.05), a.trim);
    lidTrim.position.set(0, 0.06, DEP);
    this.hinge.add(lidTrim);
    this.group.add(this.hinge);

    // Light beam so boxes can be found from across the map
    this.beamMat = new THREE.MeshBasicMaterial({
      map: a.beamTex, color: BEAM_READY.clone(), transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.45, BEAM_HEIGHT, 16, 1, true), this.beamMat);
    this.beam = beam;
    this.group.add(beam);
    // Marquee bulbs around the top edge of the box, one instanced mesh, colours per bulb
    this.bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.032, 8, 6), new THREE.MeshBasicMaterial(), BULBS);
    const perim = 2 * (LEN + DEP);
    for (let i = 0; i < BULBS; i++) {
      let d = (i / BULBS) * perim;
      let x;
      let z;
      const hl = LEN / 2 + 0.03;
      const hd = DEP / 2 + 0.03;
      if (d < LEN) { x = -hl + d * (2 * hl / LEN); z = hd; }
      else if ((d -= LEN) < DEP) { x = hl; z = hd - d * (2 * hd / DEP); }
      else if ((d -= DEP) < LEN) { x = hl - d * (2 * hl / LEN); z = -hd; }
      else { d -= LEN; x = -hl; z = -hd + d * (2 * hd / DEP); }
      _m.makeTranslation(x, HGT - 0.035, z);
      this.bulbs.setMatrixAt(i, _m);
      this.bulbs.setColorAt(i, BULB_IDLE);
    }
    this.group.add(this.bulbs);

    this.light = new THREE.PointLight(0x7fe3ff, 1.5, 6, 1.6);
    this.light.position.set(0, HGT + 0.6, 0.2);
    this.group.add(this.light);

    // The weapons that flash past during a spin
    this.display = new THREE.Group();
    this.display.position.set(0, HGT + 0.3, 0);
    this.group.add(this.display);
    this.models = new Map();
    for (const spec of BOX_WEAPONS) {
      const { object } = buildGunModel(spec);
      object.rotation.y = Math.PI / 2; // barrel along the box
      object.visible = false;
      this.display.add(object);
      this.models.set(spec, object);
    }

    this.collider = new THREE.Box3();
    this.state = 'ready';   // ready -> spinning -> showing -> cooldown -> ready
    this.timer = 0;
    this.open = 0;
    this.result = null;
    this.user = null;
    this.onResult = null;
    this.shown = null;
    this.flick = 0;
  }

  get position() { return this.group.position; }

  // `wall` is the direction from the box to the wall behind it
  place(pos, wall, beamHeight = BEAM_HEIGHT) {
    const dir = wall;
    this.group.position.copy(pos);
    this.group.rotation.y = Math.atan2(-dir.x, -dir.z); // local +Z (front) faces away from the wall
    this.beam.scale.y = Math.max(0.05, beamHeight / BEAM_HEIGHT);
    this.beam.position.y = HGT + beamHeight / 2;
    this.group.visible = true;
    const alongX = Math.abs(dir.z) > 0.5;
    const hx = (alongX ? LEN : DEP) / 2;
    const hz = (alongX ? DEP : LEN) / 2;
    this.collider.min.set(pos.x - hx, pos.y, pos.z - hz);
    this.collider.max.set(pos.x + hx, pos.y + HGT, pos.z + hz);
    this.reset();
  }

  reset() {
    this.state = 'ready';
    this.timer = 0;
    this.open = 0;
    this.user = null;
    this.onResult = null;
    this.result = null;
    this.showModel(null);
  }

  showModel(spec) {
    if (this.shown === spec) return;
    for (const [s, m] of this.models) m.visible = s === spec;
    this.shown = spec;
  }

  get ready() { return this.state === 'ready'; }

  // Start a spin for `user`; `onResult(spec)` runs the moment the spin lands
  spin(user, onResult) {
    if (!this.ready) return false;
    this.state = 'spinning';
    this.timer = 0;
    this.user = user;
    this.onResult = onResult;
    this.result = rollBoxWeapon();
    this.flick = 0;
    return true;
  }

  update(dt, t, eye) {
    this.timer += dt;
    let wantOpen = 0;
    if (this.state === 'spinning') {
      wantOpen = 1;
      // Cycle fast at first, slowing toward the end
      const k = this.timer / SPIN_TIME;
      this.flick -= dt;
      if (this.flick <= 0) {
        this.flick = 0.05 + 0.16 * k * k;
        const others = BOX_WEAPONS.filter((s) => s !== this.shown);
        this.showModel(others[Math.floor(Math.random() * others.length)]);
      }
      this.display.position.y = HGT + 0.15 + 0.55 * Math.min(1, k * 1.6);
      if (this.timer >= SPIN_TIME) {
        this.state = 'showing';
        this.timer = 0;
        this.showModel(this.result);
        const give = this.onResult;
        this.onResult = null;
        if (give) give(this.result);
      }
    } else if (this.state === 'showing') {
      wantOpen = 1;
      this.display.position.y = HGT + 0.7 + Math.sin(this.timer * 6) * 0.03;
      if (this.timer >= SHOW_TIME) {
        this.state = 'cooldown';
        this.timer = 0;
        this.showModel(null);
        this.user = null;
      }
    } else if (this.state === 'cooldown' && this.timer >= COOLDOWN) {
      this.state = 'ready';
      this.timer = 0;
    }

    this.open += (wantOpen - this.open) * Math.min(1, dt * 10);
    this.hinge.rotation.x = -1.9 * this.open;
    this.display.rotation.y = t * 2.2;

    this.updateLights(dt, t, eye);
  }

  // Casino look: while spinning, the beam, light, bulbs and "?" panels flash the rarity
  // colour of whichever weapon is showing; on landing they settle on the result's colour.
  updateLights(dt, t, eye) {
    const st = this.state;
    const rarity = this.shown && this.shown.rarity ? RARITY[this.shown.rarity] : null;
    let beamCol = BEAM_READY;
    let beamPulse = 0.85 + 0.15 * Math.sin(t * 3 + this.group.position.x);
    if (st === 'cooldown') { beamCol = BEAM_USED; beamPulse = 0.35; }
    if ((st === 'spinning' || st === 'showing') && rarity) {
      beamCol = rarity;
      beamPulse = st === 'showing' ? 0.75 + 0.25 * Math.sin(this.timer * 14) : 0.6;
    }
    this.beamMat.color.lerp(_c.copy(beamCol).multiplyScalar(0.7), Math.min(1, dt * (st === 'spinning' ? 25 : 5)));
    // Fade the beam up close so it doesn't blind whoever is using the box
    const near = eye ? Math.hypot(eye.x - this.group.position.x, eye.z - this.group.position.z) : 99;
    const fade = 0.08 + 0.92 * THREE.MathUtils.smoothstep(near, 2.5, 12);
    this.beamMat.opacity = beamPulse * fade;

    // Point light: soft, tinted by rarity while open
    if (rarity && st !== 'ready' && st !== 'cooldown') this.light.color.copy(rarity);
    else this.light.color.setRGB(0.5, 0.9, 1);
    this.light.intensity = st === 'cooldown' ? 0.4 : 1.2 + this.open * 1.3;

    // "?" panels glow in the rarity colour during a roll
    const pe = this.panelMat.emissive;
    const rolling = rarity && (st === 'spinning' || st === 'showing');
    if (rolling) pe.copy(rarity);
    else pe.lerp(st === 'cooldown' ? BEAM_USED : _c.setRGB(1, 1, 1), Math.min(1, dt * 5));
    this.panelMat.emissiveIntensity = st === 'cooldown' ? 0.5 : rolling ? 0.9 : 1.2;

    // Bulbs: lazy twinkle when ready, a fast chase in rarity colours while spinning,
    // all flashing the result's colour when it lands, dark while recharging
    const chase = Math.floor(t * 22);
    for (let i = 0; i < BULBS; i++) {
      let k;
      if (st === 'spinning' && rarity) {
        k = (i + chase) % 4 === 0 ? 1.6 : 0.15;
        _c.copy(rarity);
      } else if (st === 'showing' && rarity) {
        k = Math.floor(this.timer * 8) % 2 === 0 ? 1.6 : 0.35;
        _c.copy(rarity);
      } else if (st === 'cooldown') {
        k = 0.12;
        _c.copy(BEAM_USED);
      } else {
        k = 0.45 + 0.4 * Math.max(0, Math.sin(t * 2.5 - i * 0.7));
        _c.copy(BULB_IDLE);
      }
      this.bulbs.setColorAt(i, _c.multiplyScalar(k));
    }
    this.bulbs.instanceColor.needsUpdate = true;
  }

  // Seconds left before it can be used again (0 when ready)
  get cooldownLeft() {
    return this.state === 'cooldown' ? Math.max(0, COOLDOWN - this.timer) : 0;
  }
}

export class MysteryBoxes {
  constructor(scene, world, navPoints, count = BOX_COUNT) {
    this.world = world;
    this.boxes = [];
    for (let i = 0; i < count; i++) this.boxes.push(new MysteryBox(scene));
    this.spots = this.findSpots(navPoints);
    this.place();
  }

  // Every spot where a box fits flat on a floor with its back against a wall,
  // next to a walkable nav point (so the nav point itself stays clear for bots)
  findSpots(navPoints) {
    const spots = [];
    const colliders = this.world.colliders;
    const hits = (b) => colliders.some((c) => c.intersectsBox(b));
    const floorAt = (x, y, z) => {
      _v.set(x, y + 0.4, z);
      const d = this.world.raycastWorld(_v, DOWN, 1.2);
      return d < 1.2 ? y + 0.4 - d : null;
    };
    for (const p of navPoints) {
      const floor = floorAt(p.x, p.y, p.z);
      if (floor === null || Math.abs(floor - p.y) > 0.15) continue;
      for (const d of DIRS) {
        const alongX = Math.abs(d.z) > 0.5;
        const hx = (alongX ? LEN : DEP) / 2 + 0.05;
        const hz = (alongX ? DEP : LEN) / 2 + 0.05;
        for (let dist = 1.1; dist <= 3.6; dist += 0.15) {
          const cx = p.x + d.x * dist;
          const cz = p.z + d.z * dist;
          // Room for the box, its open lid and the weapon above it
          _box.min.set(cx - hx, floor + 0.05, cz - hz);
          _box.max.set(cx + hx, floor + 2.0, cz + hz);
          if (hits(_box)) break;
          // A wall right behind it?
          _box.min.set(cx - hx + d.x * 0.2, floor + 0.2, cz - hz + d.z * 0.2);
          _box.max.set(cx + hx + d.x * 0.2, floor + 1.4, cz + hz + d.z * 0.2);
          if (!hits(_box)) continue;
          // Solid, level floor under both ends and where the player stands in front
          const px = alongX ? LEN / 2 - 0.1 : 0;
          const pz = alongX ? 0 : LEN / 2 - 0.1;
          const f1 = floorAt(cx + px, floor, cz + pz);
          const f2 = floorAt(cx - px, floor, cz - pz);
          const f3 = floorAt(cx - d.x * 1.0, floor, cz - d.z * 1.0);
          const level = (f) => f !== null && Math.abs(f - floor) < 0.06;
          if (level(f1) && level(f2) && level(f3)) {
            spots.push({ pos: new THREE.Vector3(cx, floor, cz), wall: d.clone() });
          }
          break;
        }
      }
    }
    return spots;
  }

  // New random spots, spread out. Called at the start of every match.
  place() {
    const colliders = this.world.colliders;
    for (const b of this.boxes) {
      const i = colliders.indexOf(b.collider);
      if (i >= 0) colliders.splice(i, 1);
    }
    const pool = [...this.spots].sort(() => Math.random() - 0.5);
    const chosen = [];
    for (const s of pool) {
      if (chosen.length >= this.boxes.length) break;
      if (chosen.every((c) => c.pos.distanceTo(s.pos) >= MIN_SPACING)) chosen.push(s);
    }
    this.boxes.forEach((b, i) => {
      const s = chosen[i];
      if (!s) {
        b.group.visible = false;
        return;
      }
      // The beam stops at whatever is overhead (a floor above, a roof)
      _v.set(s.pos.x, s.pos.y + HGT + 0.05, s.pos.z);
      const ceiling = this.world.raycastWorld(_v, UP, BEAM_HEIGHT);
      b.place(s.pos, s.wall, ceiling);
      colliders.push(b.collider);
    });
  }

  active() {
    return this.boxes.filter((b) => b.group.visible);
  }

  // The box `c` could use right now: in reach and roughly in front of them
  inReach(c, facing = null) {
    let best = null;
    let bestD = USE_RANGE;
    for (const b of this.active()) {
      const p = b.position;
      const dy = c.position.y - p.y;
      if (dy < -0.6 || dy > 1.2) continue;
      const d = Math.hypot(p.x - c.position.x, p.z - c.position.z);
      if (d > bestD) continue;
      if (facing) {
        _v.set(p.x - c.position.x, 0, p.z - c.position.z).normalize();
        if (_v.x * facing.x + _v.z * facing.z < 0.2 && d > 1.2) continue;
      }
      best = b;
      bestD = d;
    }
    return best;
  }

  update(dt, t, eye = null) {
    for (const b of this.boxes) if (b.group.visible) b.update(dt, t, eye);
  }
}
