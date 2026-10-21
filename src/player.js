import { Character, NO_INPUT } from './character.js';

// The local player: a Character driven by keyboard and mouse, with the camera on its eyes.

const MOUSE_SENS = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.05;

export class Player extends Character {
  constructor(camera, colliders, spawn) {
    super(colliders, spawn, 'You');
    this.camera = camera;
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

  // Recoil is a visual offset on the camera that decays back, so aim is not permanently moved.
  addRecoil(pitch, yaw) {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
  }

  // Push the latest aim into the camera right now, so a shot uses exactly where you are looking
  syncAim() {
    this.camera.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, 0);
    this.camera.updateMatrixWorld(true);
  }

  update(dt) {
    this.preUpdate(dt);
    const recoilDecay = Math.exp(-10 * dt);
    this.recoilPitch *= recoilDecay;
    this.recoilYaw *= recoilDecay;

    if (this.tickDead(dt)) {
      this.jumpQueued = false;
      this.updateCamera();
      return;
    }

    const k = this.keys;
    const input = {
      forward: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
      strafe: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      sprint: k.has('ShiftLeft') || k.has('ShiftRight'),
      crouch: k.has('KeyC'),
      jump: this.jumpQueued,
    };
    this.jumpQueued = false;
    this.simulate(dt, this.frozen ? NO_INPUT : input);
    this.updateCamera();
  }

  updateCamera() {
    const p = this.position;
    this.camera.position.set(p.x, p.y + this.eyeOff, p.z);
    this.camera.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, 0);
  }
}
