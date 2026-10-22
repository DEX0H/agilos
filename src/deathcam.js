import * as THREE from 'three';

// What the player sees when they die, and when a new match starts.
//
// Death: the view drops to the floor with a roll while the colour drains out, then the
// camera lifts up and back over the body and turns to whoever killed you (or keeps
// circling the body for ring and fall deaths). The elimination card shows who, how and
// where you placed.
// New match: a quick fade to black, then the camera swoops down from above your spawn
// into your eyes during the countdown.

const FALL = 0.7;          // seconds to hit the floor
const HOLD = 0.55;         // lying there
const LIFT = 1.3;          // rising into the spectator view
const FLOOR_EYE = 0.28;    // eye height lying down
const BACK = 4.2;          // spectator camera: distance back from the body
const UP = 3.2;            // and height above it
const INTRO = 1.5;         // swoop from the sky into the player's eyes

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _target = new THREE.Vector3();
const _cam = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

const ease = (t) => t * t * (3 - 2 * t);
const easeIn = (t) => t * t;

// Quaternion that looks from `from` to `to`
function lookQuat(from, to, out) {
  _m.lookAt(from, to, Y);
  return out.setFromRotationMatrix(_m);
}

export class DeathCam {
  constructor({ camera, player, world, grade }) {
    this.camera = camera;
    this.player = player;
    this.world = world;
    this.grade = grade;           // colour-grade uniforms (saturation, vignette, contrast)
    this.base = {
      sat: grade.uSaturation.value, vig: grade.uVignette.value, con: grade.uContrast.value,
    };
    this.active = false;
    this.t = 0;
    this.body = new THREE.Vector3();   // where you went down (floor level)
    this.yaw = 0;
    this.pitch = 0;
    this.rollDir = 1;
    this.killer = null;
    this.orbit = 0;
    this.drain = 0;                    // 0 = full colour, 1 = drained
    this.intro = 0;                    // seconds left of the new-match swoop
    this.introFrom = new THREE.Vector3();
    this.introLook = new THREE.Vector3();
  }

  // Called the moment the player dies
  start(killer) {
    const p = this.player;
    this.active = true;
    this.t = 0;
    this.body.copy(p.position);
    this.eye = p.eyeOff;
    this.yaw = p.yaw;
    this.pitch = p.pitch;
    this.rollDir = Math.random() < 0.5 ? -1 : 1;
    this.killer = killer && killer !== p ? killer : null;
    this.orbit = this.yaw;
    this.intro = 0;
    this.spect = null;
  }

  // Back to normal (new match)
  reset() {
    this.active = false;
    this.killer = null;
  }

  // The swoop into first person at the start of a match
  startIntro() {
    this.intro = INTRO;
    const p = this.player.position;
    const yaw = this.player.yaw;
    // Up and behind where the player will be facing; straight up if a wall is in the way
    _v.set(p.x, p.y + 1.6, p.z);
    let best = null;
    for (const [back, up] of [[7, 16], [4, 16], [0, 16]]) {
      _dir.set(Math.sin(yaw) * back, up, Math.cos(yaw) * back);
      const want = _dir.length();
      _dir.normalize();
      const d = Math.min(want, this.world.raycastWorld(_v, _dir, want)) - 0.5;
      if (!best || d > best.d + 2) best = { d, x: _dir.x, y: _dir.y, z: _dir.z };
      if (d >= want - 0.6) break;
    }
    const d = Math.max(1, best.d);
    this.introFrom.set(_v.x + best.x * d, _v.y + best.y * d, _v.z + best.z * d);
    // A little ahead of the player (also keeps a straight-down look well defined)
    this.introLook.set(p.x - Math.sin(yaw) * 1.5, p.y + 1, p.z - Math.cos(yaw) * 1.5);
  }

  // Runs after the player has placed the camera at their eyes; overrides it while dead or
  // during the intro. Returns true while the death view is showing.
  update(dt) {
    const cam = this.camera;
    // Colour drains on death and comes back on a new match
    const want = this.active ? 1 : 0;
    this.drain += (want - this.drain) * Math.min(1, dt * (this.active ? 2.2 : 4));
    const d = this.drain;
    this.grade.uSaturation.value = THREE.MathUtils.lerp(this.base.sat, 0.06, d);
    this.grade.uVignette.value = THREE.MathUtils.lerp(this.base.vig, 1.25, d);
    this.grade.uContrast.value = THREE.MathUtils.lerp(this.base.con, 1.28, d);

    if (!this.active) {
      if (this.intro > 0) {
        this.intro = Math.max(0, this.intro - dt);
        const k = ease(1 - this.intro / INTRO);
        // Arc in: position eases from the sky to the eyes, the view turns from looking
        // down at the spawn to the player's own aim
        _cam.lerpVectors(this.introFrom, cam.position, k);
        lookQuat(this.introFrom, this.introLook, _q1);
        _q2.copy(cam.quaternion);
        cam.position.copy(_cam);
        cam.quaternion.slerpQuaternions(_q1, _q2, easeIn(k));
        cam.updateMatrixWorld(true);
      }
      return false;
    }

    this.t += dt;
    const t = this.t;

    // 1. Fall: eye height drops, the head rolls to one side and tips down a little
    const f = Math.min(1, t / FALL);
    const fe = easeIn(f);
    const eye = THREE.MathUtils.lerp(this.eye, FLOOR_EYE, fe);
    const bounce = f >= 1 ? Math.max(0, Math.sin((t - FALL) * 14) * 0.04 * Math.exp(-(t - FALL) * 6)) : 0;
    _v.set(this.body.x, this.body.y + eye + bounce, this.body.z);
    _e.set(
      THREE.MathUtils.lerp(this.pitch, -0.12, fe),
      this.yaw + 0.25 * this.rollDir * fe,
      1.25 * this.rollDir * fe,
    );
    _q1.setFromEuler(_e);

    // 2. Lift into a spectator view over the body, facing the killer if there is one
    const lift = ease(THREE.MathUtils.clamp((t - FALL - HOLD) / LIFT, 0, 1));
    if (lift <= 0) {
      cam.position.copy(_v);
      cam.quaternion.copy(_q1);
      cam.updateMatrixWorld(true);
      return true;
    }
    const k = this.killer;
    const watchKiller = k && !k.dead;
    if (watchKiller) {
      // Stand behind the body on the far side from the killer
      _dir.set(this.body.x - k.position.x, 0, this.body.z - k.position.z);
      if (_dir.lengthSq() < 0.01) _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      _dir.normalize();
      _target.set(k.position.x, k.position.y + 1.3, k.position.z);
      // Halfway between body and killer when they're far, so both stay on screen
      _target.lerp(_v.set(this.body.x, this.body.y + 0.5, this.body.z), 0.25);
    } else {
      this.orbit += dt * 0.25;
      _dir.set(Math.sin(this.orbit), 0, Math.cos(this.orbit));
      _target.set(this.body.x, this.body.y + 0.4, this.body.z);
    }
    // Keep the camera out of walls: pull it in front of whatever is in the way
    const origin = _v.set(this.body.x, this.body.y + 0.9, this.body.z);
    _cam.set(_dir.x * BACK, UP - 0.9, _dir.z * BACK);
    const reach = _cam.length();
    _cam.normalize();
    const hit = this.world.raycastWorld(origin, _cam, reach);
    const dist = Math.max(0.6, Math.min(reach, hit) - 0.35);
    _cam.multiplyScalar(dist).add(origin);
    lookQuat(_cam, _target, _q2);

    // The spectator pose follows the killer smoothly rather than snapping
    if (!this.spect) {
      this.spect = { pos: _cam.clone(), quat: _q2.clone() };
    } else {
      this.spect.pos.lerp(_cam, 1 - Math.exp(-4 * dt));
      this.spect.quat.slerp(_q2, 1 - Math.exp(-5 * dt));
    }

    // Blend from the floor pose into the spectator pose
    _v.set(this.body.x, this.body.y + eye + bounce, this.body.z);
    cam.position.lerpVectors(_v, this.spect.pos, lift);
    cam.quaternion.slerpQuaternions(_q1, this.spect.quat, lift);
    cam.updateMatrixWorld(true);
    return true;
  }
}
