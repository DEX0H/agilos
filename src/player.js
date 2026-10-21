import * as THREE from 'three';

// First-person character with AABB collision against static boxes.
// Units are metres, time in seconds.

const HALF_W = 0.35;     // half width of the player's collision box
const HEIGHT = 1.8;      // collision box height
const EYE = 1.6;         // camera height above feet

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

export class Player {
  constructor(camera, colliders) {
    this.camera = camera;
    this.colliders = colliders;

    this.position = new THREE.Vector3(0, 0, 0); // feet
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.canDouble = true;

    this.keys = new Set();
    this.jumpQueued = false;
    this.locked = false;

    this.camera.rotation.order = 'YXZ';

    document.addEventListener('click', () => {
      if (!this.locked) document.body.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === document.body;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * MOUSE_SENS;
      this.pitch -= e.movementY * MOUSE_SENS;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    });
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

  update(dt) {
    const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = sprint ? SPRINT_SPEED : WALK_SPEED;

    // Wish direction on the ground plane, relative to yaw
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wx = -sin * forward + cos * strafe;
    let wz = -cos * forward - sin * strafe;
    const len = Math.hypot(wx, wz);
    if (len > 0) { wx /= len; wz /= len; }

    const accel = this.onGround ? GROUND_ACCEL : AIR_ACCEL;
    const k = 1 - Math.exp(-accel * dt);
    this.velocity.x += (wx * speed - this.velocity.x) * k;
    this.velocity.z += (wz * speed - this.velocity.z) * k;

    if (this.jumpQueued) {
      this.jumpQueued = false;
      if (this.onGround) {
        this.velocity.y = JUMP_VEL;
        this.onGround = false;
        this.canDouble = true;
      } else if (this.canDouble) {
        this.velocity.y = DOUBLE_JUMP_VEL;
        this.canDouble = false;
      }
    }

    // Sub-step physics so fast falls don't tunnel through thin boxes
    const steps = Math.max(1, Math.ceil(dt / PHYSICS_STEP));
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) this.physicsStep(sub);

    this.updateCamera();
  }

  physicsStep(dt) {
    this.velocity.y -= GRAVITY * dt;
    this.moveAxis('x', this.velocity.x * dt);
    this.moveAxis('z', this.velocity.z * dt);
    this.moveVertical(this.velocity.y * dt);
    this.updateGround();
  }

  overlaps(box) {
    const p = this.position;
    return p.x - HALF_W < box.max.x && p.x + HALF_W > box.min.x &&
           p.y < box.max.y && p.y + HEIGHT > box.min.y &&
           p.z - HALF_W < box.max.z && p.z + HALF_W > box.min.z;
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
      if (d < 0) this.position.y = box.max.y;     // landed on top
      else this.position.y = box.min.y - HEIGHT;  // hit head
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
        return;
      }
    }
  }

  updateCamera() {
    const p = this.position;
    this.camera.position.set(p.x, p.y + EYE, p.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }
}
