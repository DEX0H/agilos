import * as THREE from 'three';

// First-person character with AABB collision against static boxes.
// Units are metres, time in seconds.

const HALF_W = 0.35;     // half width of the player's collision box
const STAND_H = 1.8;     // collision height standing
const CROUCH_H = 1.0;    // collision height crouched / sliding
const EYE_BELOW_TOP = 0.2; // camera sits this far below the top of the collision box

const GRAVITY = 30;
const JUMP_VEL = 9.5;          // ~1.5 m jump
const DOUBLE_JUMP_VEL = 8.5;   // ~1.2 m extra
const WALK_SPEED = 7;
const SPRINT_SPEED = 10;
const GROUND_ACCEL = 60;
const AIR_ACCEL = 8;
const STEP_HEIGHT = 0.55;      // auto step-up height
const MOUSE_SENS = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.05;
const PHYSICS_STEP = 1 / 120;
const MAX_HEALTH = 100;
const RESPAWN_TIME = 2.5;

// Slide (sprint + C on the ground)
const SLIDE_MIN_SPEED = 6.5;   // horizontal speed needed to start a slide
const SLIDE_START_SPEED = 10;  // slide starts at least this fast
const SLIDE_FRICTION = 1.1;    // exponential decay per second
const SLIDE_END_SPEED = 2.5;
const SLIDE_MAX_TIME = 1.6;
const SLIDE_COOLDOWN = 0.35;
const SLIDE_JUMP_BOOST = 1.12; // slide-jump keeps momentum and adds a little

// Wall jump and wall slide
const WALL_PROBE = 0.08;       // how far beside the body we look for a wall
const WALL_STICK = 0.18;       // seconds the wall jump stays available after touching a wall
const WALL_JUMP_UP = 9.0;
const WALL_JUMP_OUT = 8.5;
const WALL_JUMP_COOLDOWN = 0.2;
const WALL_SLIDE_MAX = 3.0;    // max fall speed while touching a wall

const WALL_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Player {
  constructor(camera, colliders, spawn) {
    this.camera = camera;
    this.colliders = colliders;
    this.spawn = spawn.clone();

    this.position = spawn.clone(); // feet
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.canDouble = true;

    // Stance
    this.height = STAND_H;
    this.eyeOff = STAND_H - EYE_BELOW_TOP;
    this.sliding = false;
    this.slideTime = 0;
    this.slideCooldown = 0;

    // Walls
    this.wallNormal = new THREE.Vector3();
    this.wallTimer = 0;
    this.wallCooldown = 0;

    this.state = 'air';

    this.health = MAX_HEALTH;
    this.dead = false;
    this.respawnTimer = 0;
    this.damageFlash = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;

    this.keys = new Set();
    this.jumpQueued = false;
    this.locked = false;

    this.camera.rotation.order = 'YXZ';

    document.addEventListener('click', () => {
      if (this.locked) return;
      const failed = () => document.dispatchEvent(new Event('agilos:lockfailed'));
      // Raw mouse input (no OS acceleration) where the browser supports it, plain lock otherwise
      let req;
      try {
        req = document.body.requestPointerLock({ unadjustedMovement: true });
      } catch {
        req = null;
      }
      if (req && typeof req.catch === 'function') {
        req.catch(() => {
          const plain = document.body.requestPointerLock();
          if (plain && typeof plain.catch === 'function') plain.catch(failed);
        });
      } else if (!req) {
        document.body.requestPointerLock();
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === document.body;
    });

    // Mouse look is applied the moment the event arrives. pointerrawupdate (Chrome/Edge)
    // fires at the mouse's own polling rate instead of once per frame.
    const look = (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * MOUSE_SENS;
      this.pitch -= e.movementY * MOUSE_SENS;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
      this.syncAim();
    };
    if ('onpointerrawupdate' in window) document.addEventListener('pointerrawupdate', look);
    else document.addEventListener('mousemove', look);
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) this.jumpQueued = true;
      }
      this.keys.add(e.code);
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  eye() {
    return new THREE.Vector3(this.position.x, this.position.y + this.eyeOff, this.position.z);
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.health = Math.max(0, this.health - amount);
    this.damageFlash = 0.35;
    if (this.health <= 0) {
      this.dead = true;
      this.respawnTimer = RESPAWN_TIME;
    }
  }

  // Recoil is a visual offset on the camera that decays back, so aim is not permanently moved.
  addRecoil(pitch, yaw) {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
  }

  respawn() {
    this.position.copy(this.spawn);
    this.velocity.set(0, 0, 0);
    this.health = MAX_HEALTH;
    this.dead = false;
    this.canDouble = true;
    this.endSlide();
    this.slideCooldown = 0;
    this.wallTimer = 0;
    this.height = STAND_H;
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

  update(dt) {
    this.damageFlash = Math.max(0, this.damageFlash - dt);
    const recoilDecay = Math.exp(-10 * dt);
    this.recoilPitch *= recoilDecay;
    this.recoilYaw *= recoilDecay;

    if (this.dead) {
      this.velocity.set(0, 0, 0);
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      this.state = 'dead';
      this.updateCamera(dt);
      return;
    }

    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);
    this.wallTimer = Math.max(0, this.wallTimer - dt);

    const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const crouchKey = this.keys.has('KeyC');
    const speed = sprint ? SPRINT_SPEED : WALK_SPEED;

    // Wish direction on the ground plane, relative to yaw
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wx = -sin * forward + cos * strafe;
    let wz = -cos * forward - sin * strafe;
    const len = Math.hypot(wx, wz);
    if (len > 0) { wx /= len; wz /= len; }

    // Start a slide: sprinting on the ground, C pressed
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    if (crouchKey && this.onGround && !this.sliding && this.slideCooldown <= 0 && hs >= SLIDE_MIN_SPEED) {
      this.startSlide(hs);
    }

    if (this.sliding) {
      // Momentum with friction; small steering only
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

    if (this.jumpQueued) {
      this.jumpQueued = false;
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
        // Wall jump: up and away from the wall, and the double jump comes back
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

    // Stance: low while sliding or holding C; stays low under a ceiling
    const wantLow = this.sliding || crouchKey;
    if (wantLow) this.height = CROUCH_H;
    else if (this.canStand()) this.height = STAND_H;

    // Sub-step physics so fast falls don't tunnel through thin boxes
    const steps = Math.max(1, Math.ceil(dt / PHYSICS_STEP));
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) this.physicsStep(sub);

    this.updateState();
    this.updateCamera(dt);
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

  // Overlap of a collider box with the player's body at the current height
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

      // Auto step-up for small ledges when grounded
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
      if (d < 0) this.position.y = box.max.y;          // landed on top
      else this.position.y = box.min.y - this.height;  // hit head
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

  // Looks for a solid right beside the body, between the feet and the head
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

  // Push the latest aim into the camera right now, so a shot uses exactly where you are looking
  syncAim() {
    this.camera.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, 0);
    this.camera.updateMatrixWorld(true);
  }

  updateCamera(dt) {
    const p = this.position;
    // Camera follows the stance smoothly
    const targetEye = this.height - EYE_BELOW_TOP;
    this.eyeOff += (targetEye - this.eyeOff) * Math.min(1, dt * 14);
    this.camera.position.set(p.x, p.y + this.eyeOff, p.z);
    this.camera.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, 0);
  }
}
