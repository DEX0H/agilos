import * as THREE from 'three';
import { raycastWorld } from './physics.js';

// Mob stats (metres, seconds, hp)
const MOB_HALF_W = 0.35;
const MOB_HEIGHT = 1.8;
const MOB_MAX_HP = 100;
const SIGHT_RANGE = 28;
const ALERT_TIME = 4;          // keeps chasing this long after losing sight
const CHASE_SPEED = 4.2;
const WANDER_SPEED = 1.6;
const ATTACK_RANGE = 1.8;
const ATTACK_DAMAGE = 7;
const ATTACK_COOLDOWN = 1.2;
const RESPAWN_DELAY = 6;
const ARENA_LIMIT = 28;        // keep mobs inside the walls

// Ground spawn points, chosen clear of crates and stairs
export const MOB_SPAWNS = [
  new THREE.Vector3(-16, 0, -8),
  new THREE.Vector3(14, 0, 6),
  new THREE.Vector3(-6, 0, 20),
  new THREE.Vector3(0, 0, -14),
  new THREE.Vector3(20, 0, 14),
];

const _ray = new THREE.Ray();
const _pt = new THREE.Vector3();

export class Mob {
  constructor(scene, colliders, spawn) {
    this.colliders = colliders;
    this.spawn = spawn.clone();
    this.position = spawn.clone();
    this.hp = MOB_MAX_HP;
    this.alive = true;
    this.alert = 0;
    this.attackTimer = 0;
    this.respawnTimer = 0;
    this.hitFlash = 0;
    this.wanderTimer = Math.random() * 2;
    this.wanderDir = new THREE.Vector2(0, 0);
    this.wandering = false;

    this.group = new THREE.Group();
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0x9b2c2c, roughness: 0.7 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0x7a2222, roughness: 0.6 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3, 0.8) }); // HDR eyes glow

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.45), this.bodyMat);
    body.position.y = 0.85;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), this.headMat);
    head.position.y = 1.55;
    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.02), eyeMat);
    eyeL.position.set(-0.12, 1.58, 0.26);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.12;
    this.group.add(body, head, eyeL, eyeR);
    this.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(this.group);
    this.syncGroup();
  }

  syncGroup() {
    this.group.position.copy(this.position);
  }

  hitBox() {
    const p = this.position;
    return new THREE.Box3(
      new THREE.Vector3(p.x - MOB_HALF_W, p.y, p.z - MOB_HALF_W),
      new THREE.Vector3(p.x + MOB_HALF_W, p.y + MOB_HEIGHT, p.z + MOB_HALF_W),
    );
  }

  // Returns true if this hit killed the mob.
  takeHit(damage) {
    if (!this.alive) return false;
    this.hp -= damage;
    this.hitFlash = 0.15;
    this.alert = ALERT_TIME;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.respawnTimer = RESPAWN_DELAY;
      this.group.visible = false;
      return true;
    }
    return false;
  }

  revive() {
    this.position.copy(this.spawn);
    this.hp = MOB_MAX_HP;
    this.alive = true;
    this.alert = 0;
    this.group.visible = true;
    this.syncGroup();
  }

  // Would a mob standing at p overlap any solid?
  blocked(p) {
    if (Math.abs(p.x) > ARENA_LIMIT || Math.abs(p.z) > ARENA_LIMIT) return true;
    for (const b of this.colliders) {
      if (b.min.x < p.x + MOB_HALF_W && b.max.x > p.x - MOB_HALF_W &&
          b.min.z < p.z + MOB_HALF_W && b.max.z > p.z - MOB_HALF_W &&
          b.min.y < p.y + MOB_HEIGHT && b.max.y > p.y + 0.05) {
        return true;
      }
    }
    return false;
  }

  moveAxis(axis, d) {
    if (d === 0) return true;
    const np = this.position.clone();
    np[axis] += d;
    if (this.blocked(np)) return false;
    this.position[axis] = np[axis];
    return true;
  }

  update(dt, player) {
    if (!this.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.revive();
      return;
    }

    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.bodyMat.emissive.setRGB(this.hitFlash / 0.15 * 0.6, 0, 0);
    this.headMat.emissive.setRGB(this.hitFlash / 0.15 * 0.6, 0, 0);
    this.attackTimer = Math.max(0, this.attackTimer - dt);

    // Sight check: from mob's eye to player's eye, with no solid in between
    const myEye = new THREE.Vector3(this.position.x, this.position.y + 1.5, this.position.z);
    const playerEye = player.eye();
    const toPlayer = playerEye.clone().sub(myEye);
    const dist3 = toPlayer.length();
    const sees = !player.dead && dist3 < SIGHT_RANGE &&
      raycastWorld(myEye, toPlayer.clone().normalize(), dist3, this.colliders) >= dist3 - 0.05;
    if (sees) this.alert = ALERT_TIME;
    else this.alert = Math.max(0, this.alert - dt);

    if (this.alert > 0 && !player.dead) {
      const dx = player.position.x - this.position.x;
      const dz = player.position.z - this.position.z;
      const hd = Math.hypot(dx, dz);
      this.group.rotation.y = Math.atan2(dx, dz);

      if (hd > ATTACK_RANGE) {
        const step = CHASE_SPEED * dt;
        const mx = (dx / hd) * step;
        const mz = (dz / hd) * step;
        if (!this.moveAxis('x', mx)) this.wanderTimer = 0;
        if (!this.moveAxis('z', mz)) this.wanderTimer = 0;
      } else if (this.attackTimer <= 0) {
        player.takeDamage(ATTACK_DAMAGE);
        this.attackTimer = ATTACK_COOLDOWN;
      }
    } else {
      // Wander: pick a new heading every few seconds, or when blocked
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wandering = Math.random() < 0.6;
        const a = Math.random() * Math.PI * 2;
        this.wanderDir.set(Math.sin(a), Math.cos(a));
        this.wanderTimer = 2 + Math.random() * 2;
      }
      if (this.wandering) {
        const step = WANDER_SPEED * dt;
        const mx = this.wanderDir.x * step;
        const mz = this.wanderDir.y * step;
        const okX = this.moveAxis('x', mx);
        const okZ = this.moveAxis('z', mz);
        if (!okX || !okZ) this.wanderTimer = 0;
        if (mx !== 0 || mz !== 0) this.group.rotation.y = Math.atan2(mx, mz);
      }
    }

    this.syncGroup();
  }
}

export class Enemies {
  constructor(scene, colliders, spawns = MOB_SPAWNS) {
    this.mobs = spawns.map((s) => new Mob(scene, colliders, s));
    this.colliders = colliders;
  }

  update(dt, player) {
    for (const mob of this.mobs) mob.update(dt, player);
  }

  // Nearest live mob along the ray, closer than maxDist and not behind walls.
  // Does not apply damage; the caller does that.
  raycastHit(origin, dir, maxDist) {
    _ray.set(origin, dir);
    let best = null;
    let bestDist = maxDist;
    for (const mob of this.mobs) {
      if (!mob.alive) continue;
      if (!_ray.intersectBox(mob.hitBox(), _pt)) continue;
      const d = origin.distanceTo(_pt);
      if (d < bestDist) {
        bestDist = d;
        best = {
          mob,
          point: _pt.clone(),
          headshot: _pt.y > mob.position.y + 1.3,
        };
      }
    }
    return best;
  }

  aliveCount() {
    return this.mobs.filter((m) => m.alive).length;
  }
}
