import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { raycastWorld } from './physics.js';

// Combat knife: melee slash in a short arc, plus a flip animation (F, or automatically when idle).
const RANGE = 1.9;             // reach in metres
const ARC_COS = 0.55;          // roughly 57 degrees to each side of the view centre
const DAMAGE = 60;
const COOLDOWN = 0.45;
const SLASH_TIME = 0.3;
const FLIP_TIME = 0.75;
const IDLE_FLIP_AFTER = 6;     // seconds of no input before an idle flip
const BASE = new THREE.Vector3(0.24, -0.24, -0.4);

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();

export class Knife {
  constructor(camera, scene, player) {
    this.camera = camera;
    this.scene = scene;
    this.player = player;
    this.cooldown = 0;
    this.slashTimer = 0;
    this.slashSide = 1;
    this.flipTimer = 0;
    this.idleTimer = 0;

    // Model. Blade points along -z; the pivot group rotates around the grip.
    this.model = new THREE.Group();
    this.pivot = new THREE.Group();
    this.model.add(this.pivot);

    const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.2, metalness: 1.0 });
    const edge = new THREE.MeshStandardMaterial({ color: 0x8e96a1, roughness: 0.3, metalness: 1.0 });
    const handleMat = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.55, metalness: 0.1 });
    const brass = new THREE.MeshStandardMaterial({ color: 0x9a7a3a, roughness: 0.35, metalness: 0.9 });

    // Blade profile in the XY plane, extruded along Z, then turned so it points forward
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.017);
    shape.lineTo(0.13, -0.016);
    shape.lineTo(0.2, -0.002);
    shape.lineTo(0.205, 0.0);
    shape.lineTo(0.13, 0.015);
    shape.lineTo(0, 0.017);
    shape.closePath();
    const depth = 0.007;
    const bladeGeom = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelSize: 0.002,
      bevelThickness: 0.002,
      bevelSegments: 2,
      curveSegments: 1,
    });
    bladeGeom.translate(0, 0, -depth / 2);
    const blade = new THREE.Mesh(bladeGeom, steel);
    blade.castShadow = true;
    const blade2 = blade.clone();
    blade2.material = edge;

    const handle = new THREE.Mesh(new RoundedBoxGeometry(0.13, 0.03, 0.026, 3, 0.01), handleMat);
    handle.position.set(-0.065, 0, 0);
    const guard = new THREE.Mesh(new RoundedBoxGeometry(0.012, 0.042, 0.024, 2, 0.004), brass);
    guard.position.set(0.002, 0, 0);
    const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.0165, 12, 8), brass);
    pommel.position.set(-0.132, 0, 0);

    const bladeGroup = new THREE.Group();
    bladeGroup.add(blade, blade2, handle, guard, pommel);
    bladeGroup.rotation.y = Math.PI / 2; // +x (length) becomes -z (forward)
    this.pivot.add(bladeGroup);
    this.pivot.rotation.order = 'XZY';

    this.model.position.copy(BASE);
    this.model.rotation.y = -0.05;
    this.model.visible = false;
    camera.add(this.model);
  }

  reload() {} // no magazine

  flip() {
    if (this.flipTimer > 0 || this.slashTimer > 0) return;
    this.flipTimer = FLIP_TIME;
    this.idleTimer = 0;
  }

  // Returns { hit, headshot, kill } like the handgun.
  fire(enemies, colliders) {
    const result = { hit: false, headshot: false, kill: false };
    if (this.cooldown > 0 || this.player.dead) return result;

    this.cooldown = COOLDOWN;
    this.slashTimer = SLASH_TIME;
    this.slashSide = -this.slashSide;
    this.flipTimer = 0;
    this.idleTimer = 0;

    this.camera.getWorldPosition(_origin);
    this.camera.getWorldDirection(_dir);

    let best = null;
    let bestDist = RANGE;
    for (const mob of enemies.mobs) {
      if (!mob.alive) continue;
      _to.set(mob.position.x, mob.position.y + 0.9, mob.position.z).sub(_origin);
      const d = _to.length();
      if (d > bestDist) continue;
      if (_to.dot(_dir) / d < ARC_COS) continue;
      if (raycastWorld(_origin, _to.clone().normalize(), d, colliders) < d - 0.05) continue;
      best = mob;
      bestDist = d;
    }

    if (best) {
      result.hit = true;
      result.kill = best.takeHit(DAMAGE);
    }
    return result;
  }

  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    let lift = 0;
    let push = 0;
    let rotX = 0, rotZ = 0, rotY = 0;

    if (this.slashTimer > 0) {
      this.slashTimer = Math.max(0, this.slashTimer - dt);
      const s = 1 - this.slashTimer / SLASH_TIME; // 0 to 1
      const sweep = Math.sin(s * Math.PI);
      rotZ = this.slashSide * sweep * 0.9;
      rotY = -this.slashSide * sweep * 0.35;
      push = sweep * 0.1;
    } else if (this.flipTimer > 0) {
      this.flipTimer = Math.max(0, this.flipTimer - dt);
      const t = 1 - this.flipTimer / FLIP_TIME;
      const eased = t * t * (3 - 2 * t);      // smoothstep
      rotX = eased * Math.PI * 2;             // one full end-over-end turn
      lift = Math.sin(t * Math.PI) * 0.05;
    } else {
      this.idleTimer += dt;
      if (this.idleTimer > IDLE_FLIP_AFTER && this.model.visible) this.flip();
    }

    this.pivot.rotation.set(rotX, rotY, rotZ);
    this.model.position.set(BASE.x, BASE.y + lift, BASE.z + push);
  }
}
