import * as THREE from 'three';
import { Character, NO_INPUT } from './character.js';
import { settings, radPerCount, capture } from './settings.js';

// The local player: a Character driven by keyboard and mouse, with the camera on its eyes.
// Keys come from the bindings in settings (physical key positions, any keyboard layout).

const MAX_PITCH = Math.PI / 2 - 0.05;

export class Player extends Character {
  constructor(camera, colliders, spawn) {
    super(colliders, spawn, 'You');
    this.camera = camera;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilRoll = 0;      // camera roll punch (doesn't move the aim)
    this.recoilRate = 10;     // how fast the recoil settles, per second
    this.recoilHold = 0;      // seconds before it starts settling (mid-spray)
    this.tilt = 0;            // slight roll into strafes
    this.sensScale = 1;   // the scope lowers it so aim feels the same zoomed in

    this.keys = new Set();
    this.jumpQueued = false;
    this.crouchQueued = false;
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
      if (!this.locked || this.dead) return; // dead: spectating, the body doesn't turn
      const s = radPerCount() * this.sensScale;
      this.yaw -= e.movementX * s;
      this.pitch -= e.movementY * s;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
      this.syncAim();
    };
    if ('onpointerrawupdate' in window) document.addEventListener('pointerrawupdate', look);
    else document.addEventListener('mousemove', look);

    document.addEventListener('keydown', (e) => {
      if (capture.action) return; // a key is being rebound
      if (e.code === settings.binds.jump) {
        e.preventDefault();
        if (!e.repeat) this.jumpQueued = true;
      }
      if (e.code === settings.binds.crouch && !e.repeat) this.crouchQueued = true;
      if (e.code === 'Space') e.preventDefault(); // never scroll the page
      this.keys.add(e.code);
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // Recoil moves the view (and so where shots go) on top of your aim. It holds while you
  // keep firing and settles back once you stop; pulling down against it is the skill.
  addRecoil(pitch, yaw, rate = 10, hold = 0, roll = 0) {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
    this.recoilRoll += roll;
    this.recoilRate = rate;
    this.recoilHold = hold;
  }

  // Push the latest aim into the camera right now, so a shot uses exactly where you are
  // looking. Only the camera's own matrix: this runs on every mouse event (up to 1000 a
  // second), and recomputing the whole viewmodel under it each time made frames uneven.
  syncAim() {
    this.camera.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, this.recoilRoll + this.tilt);
    this.camera.updateWorldMatrix(false, false);
  }

  update(dt) {
    this.preUpdate(dt);
    this.recoilHold -= dt;
    if (this.recoilHold <= 0) {
      const settle = Math.exp(-this.recoilRate * dt);
      this.recoilPitch *= settle;
      this.recoilYaw *= settle;
    }
    this.recoilRoll *= Math.exp(-18 * dt);

    if (this.tickDead(dt)) {
      this.jumpQueued = false;
      this.updateCamera(dt);
      return;
    }

    const k = this.keys;
    const b = settings.binds;
    const input = {
      forward: (k.has(b.forward) ? 1 : 0) - (k.has(b.back) ? 1 : 0),
      strafe: (k.has(b.right) ? 1 : 0) - (k.has(b.left) ? 1 : 0),
      sprint: k.has(b.sprint),
      crouch: k.has(b.crouch),
      jump: this.jumpQueued,
      jumpHeld: k.has(b.jump),
      crouchPressed: this.crouchQueued,
    };
    this.jumpQueued = false;
    this.crouchQueued = false;
    this.lastInput = input;
    this.simulate(dt, this.frozen ? NO_INPUT : input);
    this.updateCamera(dt);
  }

  updateCamera(dt = 0) {
    const p = this.position;
    // Ease up stair steps instead of popping 0.5 m in one frame
    this.stepOffset *= Math.exp(-16 * dt);
    if (this.stepOffset > -0.002) this.stepOffset = 0;
    // A slight roll into strafes (under a degree) so turning while moving feels fluid
    const lat = this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw);
    const want = this.dead ? 0 : THREE.MathUtils.clamp(-lat / 10, -1, 1) * 0.012;
    this.tilt += (want - this.tilt) * Math.min(1, dt * 8);
    this.camera.position.set(p.x, p.y + this.eyeOff + this.stepOffset, p.z);
    this.camera.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, this.recoilRoll + this.tilt);
  }
}
