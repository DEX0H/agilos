import * as THREE from 'three';

// Shared movement and health for anything that plays: the local player, bots,
// and later network players. Input comes in as a plain object each frame, so the
// same simulation runs no matter where the input comes from.
// Units are metres, time in seconds.

export const HALF_W = 0.35;     // half width of the collision box
export const STAND_H = 1.8;     // collision height standing
export const CROUCH_H = 1.0;    // collision height crouched / sliding
const EYE_BELOW_TOP = 0.2;      // eyes sit this far below the top of the box

const GRAVITY = 30;
const JUMP_VEL = 9.5;           // ~1.5 m jump
const DOUBLE_JUMP_VEL = 8.5;    // ~1.2 m extra
const WALK_SPEED = 7;
const SPRINT_SPEED = 10;
const GROUND_ACCEL = 60;
const AIR_ACCEL = 8;
const STEP_HEIGHT = 0.55;       // auto step-up height
const PHYSICS_STEP = 1 / 120;
const MAX_HEALTH = 100;

// Slide (sprint + crouch on the ground)
const SLIDE_MIN_SPEED = 6.5;
const SLIDE_START_SPEED = 10;
const SLIDE_FRICTION = 1.1;
const SLIDE_END_SPEED = 2.5;
const SLIDE_MAX_TIME = 1.6;
const SLIDE_COOLDOWN = 0.35;
const SLIDE_JUMP_BOOST = 1.12;

// Wall jump and wall slide
const WALL_PROBE = 0.08;
const WALL_STICK = 0.18;
const WALL_JUMP_UP = 9.0;
const WALL_JUMP_OUT = 8.5;
const WALL_JUMP_COOLDOWN = 0.2;
const WALL_SLIDE_MAX = 3.0;

const WALL_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Empty input, for frames where nothing is pressed
export const NO_INPUT = Object.freeze({ forward: 0, strafe: 0, sprint: false, crouch: false, jump: false });

export class Character {
  constructor(colliders, spawn, name = 'player') {
    this.colliders = colliders;
    this.name = name;
    this.spawn = spawn.clone();

    this.position = spawn.clone(); // feet
    this.velocity = new THREE.Vector3();
    this.yaw = 0;                  // look direction; yaw 0 faces -z
    this.pitch = 0;
    this.onGround = false;
    this.canDouble = true;

    this.height = STAND_H;
    this.eyeOff = STAND_H - EYE_BELOW_TOP;
    this.sliding = false;
    this.slideTime = 0;
    this.slideCooldown = 0;

    this.wallNormal = new THREE.Vector3();
    this.wallTimer = 0;
    this.wallCooldown = 0;

    this.state = 'air';

    this.maxHealth = MAX_HEALTH;
    this.health = MAX_HEALTH;
    this.dead = false;
    this.respawnTime = 2.5;
    this.respawnTimer = 0;
    this.damageFlash = 0;
    this.kills = 0;
    this.deaths = 0;
    this.lastAttacker = null;
  }

  eye() {
    return new THREE.Vector3(this.position.x, this.position.y + this.eyeOff, this.position.z);
  }

  // Unit vector of where this character is looking
  aimDir(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  hitBox() {
    const p = this.position;
    return new THREE.Box3(
      new THREE.Vector3(p.x - HALF_W, p.y, p.z - HALF_W),
      new THREE.Vector3(p.x + HALF_W, p.y + this.height, p.z + HALF_W),
    );
  }

  // Returns true if this damage killed the character
  takeDamage(amount, attacker = null) {
    if (this.dead) return false;
    this.health = Math.max(0, this.health - amount);
    this.damageFlash = 0.35;
    this.lastAttacker = attacker;
    if (this.health <= 0) {
      this.dead = true;
      this.respawnTimer = this.respawnTime;
      this.deaths++;
      return true;
    }
    return false;
  }

  respawn() {
    this.position.copy(this.spawn);
    this.velocity.set(0, 0, 0);
    this.health = this.maxHealth;
    this.dead = false;
    this.canDouble = true;
    this.sliding = false;
    this.slideCooldown = 0;
    this.wallTimer = 0;
    this.height = STAND_H;
    this.eyeOff = STAND_H - EYE_BELOW_TOP;
  }

  // Timers that run every frame, alive or dead
  preUpdate(dt) {
    this.damageFlash = Math.max(0, this.damageFlash - dt);
  }

  // Counts down the respawn while dead. Returns true while still dead.
  tickDead(dt) {
    if (!this.dead) return false;
    this.velocity.set(0, 0, 0);
    this.respawnTimer -= dt;
    this.state = 'dead';
    if (this.respawnTimer <= 0) this.respawn();
    return this.dead;
  }

  startSlide(hs) {
    this.sliding = true;
    this.slideTime = 0;
    const boost = Math.max(hs, SLIDE_START_SPEED) / Math.max(hs, 1e-3);
    this.velocity.x *= boost;
    this.velocity.z *= boost;
  }

  endSlide() {
    if (!this.sliding) return;
    this.sliding = false;
    this.slideCooldown = SLIDE_COOLDOWN;
  }

  // input: { forward -1..1, strafe -1..1, sprint, crouch, jump (true on the frame it is pressed) }
  simulate(dt, input) {
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);
    this.wallTimer = Math.max(0, this.wallTimer - dt);

    const speed = input.sprint ? SPRINT_SPEED : WALK_SPEED;

    // Wish direction on the ground plane, relative to yaw
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wx = -sin * input.forward + cos * input.strafe;
    let wz = -cos * input.forward - sin * input.strafe;
    const len = Math.hypot(wx, wz);
    if (len > 0) { wx /= len; wz /= len; }

    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    if (input.crouch && this.onGround && !this.sliding && this.slideCooldown <= 0 && hs >= SLIDE_MIN_SPEED) {
      this.startSlide(hs);
    }

    if (this.sliding) {
      const decay = Math.exp(-SLIDE_FRICTION * dt);
      this.velocity.x *= decay;
      this.velocity.z *= decay;
      const k = 1 - Math.exp(-3 * dt);
      this.velocity.x += (wx * speed - this.velocity.x) * k * 0.3;
      this.velocity.z += (wz * speed - this.velocity.z) * k * 0.3;
      this.slideTime += dt;
      if (hs < SLIDE_END_SPEED || this.slideTime > SLIDE_MAX_TIME || !this.onGround) this.endSlide();
    } else {
      const accel = this.onGround ? GROUND_ACCEL : AIR_ACCEL;
      const k = 1 - Math.exp(-accel * dt);
      this.velocity.x += (wx * speed - this.velocity.x) * k;
      this.velocity.z += (wz * speed - this.velocity.z) * k;
    }

    if (input.jump) {
      if (this.onGround) {
        this.velocity.y = JUMP_VEL;
        this.onGround = false;
        this.canDouble = true;
        if (this.sliding) {
          this.velocity.x *= SLIDE_JUMP_BOOST;
          this.velocity.z *= SLIDE_JUMP_BOOST;
          this.endSlide();
        }
      } else if (this.wallTimer > 0 && this.wallCooldown <= 0) {
        this.velocity.y = WALL_JUMP_UP;
        this.velocity.x = this.wallNormal.x * WALL_JUMP_OUT;
        this.velocity.z = this.wallNormal.z * WALL_JUMP_OUT;
        this.wallTimer = 0;
        this.wallCooldown = WALL_JUMP_COOLDOWN;
        this.canDouble = true;
      } else if (this.canDouble) {
        this.velocity.y = DOUBLE_JUMP_VEL;
        this.canDouble = false;
      }
    }

    // Stance: low while sliding or crouching; stays low under a ceiling
    if (this.sliding || input.crouch) this.height = CROUCH_H;
    else if (this.canStand()) this.height = STAND_H;

    const steps = Math.max(1, Math.ceil(dt / PHYSICS_STEP));
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) this.physicsStep(sub);

    this.updateState();
    const targetEye = this.height - EYE_BELOW_TOP;
    this.eyeOff += (targetEye - this.eyeOff) * Math.min(1, dt * 14);
  }

  updateState() {
    if (this.sliding) this.state = 'slide';
    else if (!this.onGround && this.wallTimer > 0) this.state = 'wall';
    else if (!this.onGround) this.state = 'air';
    else if (this.height < STAND_H) this.state = 'crouch';
    else this.state = 'ground';
  }

  physicsStep(dt) {
    this.velocity.y -= GRAVITY * dt;
    if (this.wallTimer > 0 && this.velocity.y < -WALL_SLIDE_MAX) this.velocity.y = -WALL_SLIDE_MAX;
    this.moveAxis('x', this.velocity.x * dt);
    this.moveAxis('z', this.velocity.z * dt);
    this.moveVertical(this.velocity.y * dt);
    this.updateGround();
    this.updateWall();
  }

  overlapsWith(box, h) {
    const p = this.position;
    return p.x - HALF_W < box.max.x && p.x + HALF_W > box.min.x &&
           p.y < box.max.y && p.y + h > box.min.y &&
           p.z - HALF_W < box.max.z && p.z + HALF_W > box.min.z;
  }

  overlaps(box) {
    return this.overlapsWith(box, this.height);
  }

  canStand() {
    for (const box of this.colliders) {
      if (this.overlapsWith(box, STAND_H)) return false;
    }
    return true;
  }

  moveAxis(axis, d) {
    if (d === 0) return;
    this.position[axis] += d;
    for (const box of this.colliders) {
      if (!this.overlaps(box)) continue;
      const ledge = box.max.y - this.position.y;
      if (this.onGround && ledge > 0 && ledge <= STEP_HEIGHT) {
        this.position.y = box.max.y;
        continue;
      }
      if (d > 0) this.position[axis] = box.min[axis] - HALF_W;
      else this.position[axis] = box.max[axis] + HALF_W;
      this.velocity[axis] = 0;
    }
  }

  moveVertical(d) {
    this.position.y += d;
    for (const box of this.colliders) {
      if (!this.overlaps(box)) continue;
      if (d < 0) this.position.y = box.max.y;
      else this.position.y = box.min.y - this.height;
      this.velocity.y = 0;
    }
  }

  updateGround() {
    this.onGround = false;
    if (this.velocity.y > 0) return;
    const p = this.position;
    for (const box of this.colliders) {
      if (Math.abs(box.max.y - p.y) > 0.05) continue;
      const overlapsXZ = p.x + HALF_W > box.min.x && p.x - HALF_W < box.max.x &&
                         p.z + HALF_W > box.min.z && p.z - HALF_W < box.max.z;
      if (overlapsXZ) {
        this.onGround = true;
        this.canDouble = true;
        this.wallTimer = 0;
        return;
      }
    }
  }

  updateWall() {
    if (this.onGround) return;
    const p = this.position;
    const ex = HALF_W + WALL_PROBE;
    const inner = HALF_W - 0.05;
    const y0 = p.y + 0.1;
    const y1 = p.y + this.height - 0.1;
    for (const [dx, dz] of WALL_DIRS) {
      let x0, x1, z0, z1;
      if (dx !== 0) {
        x0 = dx > 0 ? p.x + HALF_W : p.x - ex;
        x1 = dx > 0 ? p.x + ex : p.x - HALF_W;
        z0 = p.z - inner;
        z1 = p.z + inner;
      } else {
        z0 = dz > 0 ? p.z + HALF_W : p.z - ex;
        z1 = dz > 0 ? p.z + ex : p.z - HALF_W;
        x0 = p.x - inner;
        x1 = p.x + inner;
      }
      for (const b of this.colliders) {
        if (b.min.x < x1 && b.max.x > x0 && b.min.y < y1 && b.max.y > y0 &&
            b.min.z < z1 && b.max.z > z0) {
          this.wallNormal.set(-dx, 0, -dz);
          this.wallTimer = WALL_STICK;
          return;
        }
      }
    }
  }
}
