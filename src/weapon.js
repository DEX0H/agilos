import * as THREE from 'three';
import { GunState, HANDGUN } from './gun.js';
import { settings, capture } from './settings.js';
import { buildViewGun } from './viewguns.js';
import { basisQuat, ARMS } from './fparms.js';

// The player's gun slot: first-person viewmodel and effects on top of the shared GunState.
// It starts with the handgun; a mystery box swaps in an SMG, assault rifle or sniper.
const KICK_STIFF = 320;         // the gun's recoil spring: stiffness and damping
const KICK_DAMP = 30;
const SWAY = 0.9;               // the gun lags behind your aim by this much of the turn
const SWAY_MAX = 0.06;          // radians
const VIEW_BASE_Z = -0.42;
const VIEW_BASE_Y = -0.2;
const DRAW_TIME = 0.22;         // the new gun swings up; it can fire straight away
const BASE_FOV = 75;
const SCOPE_SPEED = 12;         // how fast the scope zooms in and out
const ADS_SPEED = 16;           // how fast the gun comes up to your eye (about 0.15 s)
const ease = (t) => t * t * (3 - 2 * t);
const _sp = new THREE.Vector3();
const _hp = new THREE.Vector3();
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _vec = (a, v) => v.set(a[0], a[1], a[2]);
// Finger curl between two poses (support grip -> holding the magazine), without allocating
const _blend = { fingers: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], thumb: [0, 0, 0] };
function blendCurl(a, b, t) {
  for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) _blend.fingers[i][k] = a.fingers[i][k] + (b.fingers[i][k] - a.fingers[i][k]) * t;
  for (let k = 0; k < 3; k++) _blend.thumb[k] = a.thumb[k] + (b.thumb[k] - a.thumb[k]) * t;
  return _blend;
}
// Finger curls (radians per joint: base, middle, tip), for index, middle, ring, pinky and thumb
const grip = [1.2, 1.3, 0.85];
export const CURLS = {
  trigger: { fingers: [[0.35, 0.55, 0.35], grip, grip, grip], thumb: [0.25, 0.45, 0.3] },
  support: { fingers: [[0.95, 1.05, 0.7], [1, 1.1, 0.75], [1, 1.1, 0.75], [0.95, 1.05, 0.7]], thumb: [0.3, 0.3, 0.2] },
  cup: { fingers: [[1.15, 1.25, 0.85], [1.2, 1.3, 0.9], [1.2, 1.3, 0.9], [1.1, 1.2, 0.85]], thumb: [0.45, 0.45, 0.3] },
  mag: { fingers: [[1.05, 1.15, 0.8], [1.1, 1.2, 0.85], [1.1, 1.2, 0.85], [1.0, 1.1, 0.8]], thumb: [0.55, 0.55, 0.35] },
  fist: { fingers: [[1.25, 1.35, 0.9], grip, grip, grip], thumb: [0.5, 0.6, 0.4] },
};
const _X = new THREE.Vector3(1, 0, 0);
const _Zax = new THREE.Vector3(0, 0, 1);

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

export class Firearm {
  constructor(camera, scene, player) {
    this.camera = camera;
    this.scene = scene;
    this.player = player;
    this.gun = new GunState(HANDGUN, player);
    // Recoil in your hands: a damped spring per axis (back, muzzle flip, sideways, roll)
    this.kick = { back: [0, 0], flip: [0, 0], side: [0, 0], roll: [0, 0] };
    this.spray = 0;            // shots in the current burst (drives the recoil pattern)
    this.sinceShot = 9;
    this.sway = { yaw: 0, pitch: 0 };
    this.lastAim = null;
    this.bob = 0;              // walk cycle phase
    this.bobAmt = 0;
    this.flashTimer = 0;
    this.drawTimer = 0;
    this.triggerHeld = false;  // held left mouse, for automatic weapons
    this.scopeHeld = false;    // right mouse held: aim down sights (the sniper scopes in)
    this.aim = 0;              // 0 = hip, 1 = aiming down sights
    this.zoom = 0;             // 0 = hip, 1 = fully scoped (scoped weapons only)

    // First-person viewmodel, parented to the camera. The detailed guns (viewguns.js)
    // are built on first use and kept.
    this.model = new THREE.Group();
    this.muzzle = new THREE.Object3D();
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 10, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 4, 1.5) }), // HDR, blooms
    );
    this.flash.visible = false;
    this.muzzle.add(this.flash);
    this.model.position.set(0.24, VIEW_BASE_Y, VIEW_BASE_Z);
    this.model.rotation.y = -0.05;
    camera.add(this.model);
    this.views = {};
    this.slideKick = 0;
    this.leftOnMag = 0;
    this.equip(HANDGUN);

    document.addEventListener('keydown', (e) => {
      if (!capture.action && e.code === settings.binds.reload && !e.repeat) this.gun.reload();
    });
  }

  // Grip targets for the first-person arms (fparms.js): Object3Ds on the gun, so the
  // hands follow it. The left one moves to the magazine during a reload.
  addHands(entry) {
    const A = entry.arms;
    const target = (def) => {
      const o = new THREE.Object3D();
      o.position.set(...def.pos);
      basisQuat(new THREE.Vector3(...def.f), new THREE.Vector3(...def.n), o.quaternion);
      entry.object.add(o);
      return o;
    };
    entry.tR = target(A.right);
    entry.tL = target(A.left);
    entry.leftSupport = { pos: entry.tL.position.clone(), quat: entry.tL.quaternion.clone() };
    entry.leftMag = {
      pos: new THREE.Vector3(...A.mag.pos),
      quat: basisQuat(new THREE.Vector3(...A.mag.f), new THREE.Vector3(...A.mag.n)),
    };
  }

  // Once the animator's pistol grip has loaded: the right hand (every gun) and the
  // pistol's left hand take their placement and finger pose from it, around each gun's
  // palm point
  applyPose(e) {
    const P = ARMS.pose;
    const A = e.arms;
    const k = 1 / e.view.scale; // pose offsets are metres; the gun model is scaled
    // The pose's reference point lies on the hand bone, inside the hand; the grip sits in
    // the palm hollow, a couple of centimetres toward the palm (to the gun's left)
    const palmInset = 0.024;
    const place = (t, rel) => {
      t.position.set(...A.right.palm).addScaledVector(rel.pos, k);
      t.position.x += palmInset * k;
      t.quaternion.copy(rel.quat);
      t.userData.direct = true;
    };
    place(e.tR, P.right);
    // Left hand on a fore grip or handguard: the right hand's grip mirrored, around the
    // left palm point, turned by `turn` (radians about the gun's x axis): about 0 for a
    // vertical fore grip, -1.35 to lie along a handguard (index finger forward, thumb over
    // the top, fingers wrapping underneath)
    // Left hand cradling a handguard from below: palm up against it, fingers across to the
    // far side and wrapped up around it, thumb along the near side. The hand's own finger
    // and palm directions are measured from the mirrored grip, then turned to point there.
    if (A.left.cradle) {
      const C = A.left.cradle;
      const m = P.mirrored;
      const toGrip = m.pos.clone().negate();                       // hand -> grip, gun frame
      const qInv = m.quat.clone().invert();
      const fLocal = P.leftFinger.clone();                          // wrist -> knuckles, hand space
      const pLocal = toGrip.clone().applyQuaternion(qInv).normalize(); // hand -> grip (palm), hand space
      const hLocal = m.pos.clone().applyQuaternion(qInv);           // grip -> hand, hand space
      const want = basisQuat(new THREE.Vector3(...C.f), new THREE.Vector3(...C.n));
      const have = basisQuat(fLocal, pLocal);
      const q = want.multiply(have.invert());
      e.tL.quaternion.copy(q);
      e.tL.position.set(...C.at).add(hLocal.applyQuaternion(q).multiplyScalar(k));
      e.tL.userData.direct = true;
      e.leftSupport = { pos: e.tL.position.clone(), quat: e.tL.quaternion.clone() };
    }
    if (A.left.mirror) {
      const L = A.left.mirror;
      const R = new THREE.Quaternion().setFromAxisAngle(_X, L.turn || 0)
        .multiply(new THREE.Quaternion().setFromAxisAngle(_Zax, L.roll || 0));
      const off = P.mirrored.pos.clone().multiplyScalar(k);
      off.x -= (palmInset + (L.inset || 0)) * k;
      e.tL.position.set(...L.palm).add(off.applyQuaternion(R));
      e.tL.quaternion.copy(R).multiply(P.mirrored.quat);
      e.tL.userData.direct = true;
      e.leftSupport = { pos: e.tL.position.clone(), quat: e.tL.quaternion.clone() };
    }
    if (A.left.fromPose) {
      place(e.tL, P.left);
      e.leftSupport = { pos: e.tL.position.clone(), quat: e.tL.quaternion.clone() };
      e.leftMag.quat = e.tL.quaternion.clone(); // keeps the same hand angle while reloading
    }
    e.posed = true;
  }

  // Pose for the arms this frame
  armPose() {
    const e = this.entry;
    const A = e.arms;
    if (ARMS.pose && !e.posed) this.applyPose(e);
    const reloading = this.gun.reloadTimer > 0;
    const hand = ARMS.pose ? { pose: ARMS.pose.fingers } : null;
    let leftCurl = blendCurl(CURLS[A.left.curl], CURLS.mag, reloading ? this.leftOnMag : 0);
    if (ARMS.pose && A.left.fromPose) leftCurl = hand;
    else if (ARMS.pose && A.left.mirror && !(reloading && this.leftOnMag > 0.5)) leftCurl = { pose: A.left.mirror.wrapIndex ? ARMS.pose.mirrorWrap : ARMS.pose.mirrorFingers };
    else if (ARMS.pose && A.left.cradle && !(reloading && this.leftOnMag > 0.5)) leftCurl = { pose: ARMS.pose.mirrorWrap };
    return {
      right: { target: e.tR, shoulder: _vec(A.right.shoulder, _s1), pole: _vec(A.right.pole, _p1), curl: hand || CURLS[A.right.curl] },
      left: { target: e.tL, shoulder: _vec(A.left.shoulder, _s2), pole: _vec(A.left.pole, _p2), curl: leftCurl },
    };
  }

  attachMuzzle(parent, pos) {
    this.muzzle.removeFromParent();
    this.muzzle.position.copy(pos);
    parent.add(this.muzzle);
  }

  // Swap the gun in this slot. Full ammo, usable immediately.
  equip(spec) {
    this.gun = new GunState(spec, this.player);
    this.drawTimer = DRAW_TIME;
    this.zoom = 0;
    this.aim = 0;
    this.spray = 0;
    this.slideKick = 0;
    if (this.kick) for (const k of Object.values(this.kick)) { k[0] = 0; k[1] = 0; }
    let entry = this.views[spec.model];
    if (!entry) {
      entry = buildViewGun(spec);
      entry.object.position.copy(entry.view.pos);
      entry.object.scale.setScalar(entry.view.scale);
      this.addHands(entry);
      this.model.add(entry.object);
      this.views[spec.model] = entry;
    }
    for (const e of Object.values(this.views)) e.object.visible = e === entry;
    this.entry = entry;
    this.current = entry.object;
    this.attachMuzzle(entry.object, entry.muzzle);
  }

  get scoped() { return this.zoom > 0.85; }
  get aiming() { return this.aim > 0.6; }

  // Where the viewmodel group goes so the gun's sights (front post, red dot, holo
  // reticle) sit exactly on the centre of the screen, with the eye behind the rear sight
  sight() {
    const e = this.entry;
    const v = e.view;
    const s = e.sight;
    const p = _sp.set(s.x, s.y, s.z).multiplyScalar(v.scale).add(v.pos);
    if (s.tilt) p.applyAxisAngle(_X, s.tilt);
    return { x: -p.x, y: -p.y, z: -s.dist - p.z, tilt: s.tilt || 0 };
  }

  get spec() { return this.gun.spec; }
  get ammo() { return this.gun.ammo; }
  get magSize() { return this.gun.magSize; }
  get reserve() { return this.gun.reserve; }
  get reloadTimer() { return this.gun.reloadTimer; }

  reload() {
    this.gun.reload();
  }

  currentSpread() {
    return this.gun.spread();
  }

  // Fires along the camera's exact aim. Returns { fired, hit, headshot, kill, ... }.
  fire(world) {
    this.camera.getWorldPosition(_origin);
    this.camera.getWorldDirection(_dir);
    const r = this.gun.fire(world, _origin, _dir);
    if (!r.fired) return r;

    const spec = this.gun.spec;
    this.flashTimer = 0.05;
    this.flash.visible = true;
    this.slideKick = 1;
    this.applyRecoil(spec.kick);
    this.muzzle.getWorldPosition(_muzzle);
    world.addTracer(_muzzle, r.end);
    return r;
  }


  // One shot's recoil. The view climbs a fixed amount per shot (less once the climb cap is
  // reached), and after a few shots in a spray it sways side to side in the same pattern
  // every time, so it can be learned and pulled against. Crouching or sliding softens it.
  applyRecoil(k) {
    const n = this.spray++;
    this.sinceShot = 0;
    const p = this.player;
    const steady = (p.state === 'crouch' || p.sliding ? 0.75 : 1) * (this.aiming ? 0.85 : 1);
    let up = k.up;
    if (p.recoilPitch > k.maxClimb) up *= 0.2;
    const sway = n >= k.sideStart ? k.side * Math.sin((n - k.sideStart) * 0.55 + 0.9) : 0;
    const side = sway + (Math.random() - 0.5) * k.jitter;
    const roll = (Math.random() - 0.5) * 2 * k.roll;
    p.addRecoil(up * steady, side * steady, k.recover, k.delay, roll);
    // The gun itself: snaps back and flips up, then springs home (less when aiming)
    const scope = this.scoped ? 0.3 : this.aiming ? 0.55 : 1;
    this.kick.back[0] += k.vmBack * scope;
    this.kick.flip[0] += k.vmFlip * scope * (0.85 + Math.random() * 0.3);
    this.kick.side[0] += (Math.random() - 0.5) * k.vmFlip * 0.4;
    this.kick.roll[0] += (Math.random() - 0.5) * 2 * k.vmRoll;
  }

  // Drop the scope and the trigger (weapon switch, death, menu)
  release() {
    this.triggerHeld = false;
    this.scopeHeld = false;
  }

  // Reload: tilt and roll the gun, drop the magazine out, bring a fresh one up into the
  // well, slap it home, then settle back. Timed to the gun's real reload time.
  animateReload(draw) {
    const g = this.gun;
    const reloading = g.reloadTimer > 0;
    const p = reloading ? 1 - g.reloadTimer / g.spec.reloadTime : 1;
    const ss = THREE.MathUtils.smoothstep;
    const pose = reloading ? Math.min(ss(p, 0, 0.15), 1 - ss(p, 0.86, 1)) : 0;
    const slap = reloading ? Math.max(0, 1 - Math.abs(p - 0.76) / 0.05) : 0; // jolt when the mag seats

    // Muzzle up, rolled so the right side and the magazine well face you, raised into view
    this.model.rotation.x = 0.32 * pose + 0.6 * draw - 0.08 * slap;
    this.model.rotation.z = 0.5 * pose;
    this.model.rotation.y = -0.05 + 0.1 * pose;
    this.model.position.x = this.entry.view.hip.x - 0.08 * pose;
    this.model.position.y += 0.015 * slap + 0.07 * pose;

    // Magazine: out by 45%, back in by 75%. It drops along the grip and a fresh one rises.
    const drop = reloading ? (p < 0.45 ? ss(p, 0.12, 0.45) : 1 - ss(p, 0.45, 0.75)) : 0;
    const e = this.entry;
    if (!e) return;
    e.mag.position.set(e.magHome.x, e.magHome.y - 0.3 * drop, e.magHome.z + 0.03 * drop);
    e.mag.rotation.x = -0.3 * drop;
    e.mag.visible = drop < 0.97;
    // Left hand: leaves the handguard, grabs the magazine, pulls it out, brings a fresh
    // one up from below, seats it, and goes back
    const grab = reloading ? Math.min(ss(p, 0.03, 0.13), 1 - ss(p, 0.8, 0.94)) : 0;
    const L = e.tL;
    this.leftOnMag = grab;
    _hp.copy(e.leftMag.pos).add(e.mag.position).sub(e.magHome);
    L.position.lerpVectors(e.leftSupport.pos, _hp, grab);
    L.quaternion.slerpQuaternions(e.leftSupport.quat, e.leftMag.quat, grab);
    // The slide/bolt kicks back on each shot; a pistol's slide locks back when empty
    const travel = g.spec.model === 'pistol' ? 0.03 : 0.012;
    const locked = g.spec.model === 'pistol' && g.ammo === 0 && !reloading ? 1 : 0;
    e.slide.position.z = e.slideHome.z + travel * Math.max(this.slideKick, locked);
  }

  update(dt) {
    this.gun.update(dt);
    const spec = this.gun.spec;

    // Aim down sights while right mouse is held (not during a reload or the draw). Every
    // gun zooms in a little and brings its sights to the centre; the sniper scopes in.
    const wantAim = this.scopeHeld && this.model.visible && !this.player.dead
      && this.gun.reloadTimer <= 0 && this.drawTimer <= 0.05 ? 1 : 0;
    this.aim += (wantAim - this.aim) * Math.min(1, dt * (spec.scope ? SCOPE_SPEED : ADS_SPEED));
    if (Math.abs(wantAim - this.aim) < 0.01) this.aim = wantAim;
    this.zoom = spec.scope ? this.aim : 0;
    const aimFov = spec.scope ? spec.scopeFov : spec.adsFov || 62;
    const fov = BASE_FOV + (aimFov - BASE_FOV) * (spec.scope ? this.aim : ease(this.aim));
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // The mouse slows with the zoom so the same hand movement covers the same on screen
    const half = (f) => Math.tan(THREE.MathUtils.degToRad(f / 2));
    this.player.sensScale = half(fov) / half(BASE_FOV);
    this.player.ads = this.scoped;
    this.player.aiming = this.aiming;

    this.slideKick *= Math.exp(-28 * dt);
    // A burst ends once the trigger has been off for a moment
    this.sinceShot += dt;
    if (this.sinceShot > Math.max(0.22, spec.fireInterval * 1.6)) this.spray = 0;

    // Recoil springs, integrated in small steps so they stay stable at low frame rates
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      for (const s of Object.values(this.kick)) {
        s[1] += (-KICK_STIFF * s[0] - KICK_DAMP * s[1]) * h;
        s[0] += s[1] * h;
      }
    }

    // Sway: the gun trails a little behind fast turns and catches up
    const p = this.player;
    if (!this.lastAim) this.lastAim = { yaw: p.yaw, pitch: p.pitch };
    const dYaw = p.yaw - this.lastAim.yaw;
    const dPitch = p.pitch - this.lastAim.pitch;
    this.lastAim.yaw = p.yaw;
    this.lastAim.pitch = p.pitch;
    const clamp = THREE.MathUtils.clamp;
    const swayK = (1 - this.zoom) * SWAY;
    this.sway.yaw += (clamp(-dYaw * swayK * 6, -SWAY_MAX, SWAY_MAX) - this.sway.yaw) * Math.min(1, dt * 12);
    this.sway.pitch += (clamp(-dPitch * swayK * 6, -SWAY_MAX, SWAY_MAX) - this.sway.pitch) * Math.min(1, dt * 12);

    // Bob: a gentle figure-eight with your steps on the ground
    const hs = Math.hypot(p.velocity.x, p.velocity.z);
    const walking = p.onGround && !p.sliding && hs > 0.6 && !p.dead;
    this.bobAmt += ((walking ? Math.min(1, hs / 10) : 0) - this.bobAmt) * Math.min(1, dt * 8);
    this.bob += dt * (4 + hs * 0.9);
    const bobX = Math.sin(this.bob) * 0.008 * this.bobAmt * (1 - this.zoom);
    const bobY = -Math.abs(Math.cos(this.bob)) * 0.01 * this.bobAmt * (1 - this.zoom);

    // A new gun swings up from below
    this.drawTimer = Math.max(0, this.drawTimer - dt);
    const draw = this.drawTimer / DRAW_TIME;
    const pos = this.model.position;
    const rot = this.model.rotation;
    const hip = this.entry.view.hip;
    pos.z = hip.z;
    pos.y = hip.y - 0.22 * draw * draw - 0.12 * this.zoom;
    // Behind the scope the gun itself is hidden (the overlay draws the scope)
    this.current.visible = this.zoom < 0.6;

    this.animateReload(draw);

    // Aim down sights: the gun moves from the hip to the centre, square to the view
    const k = spec.scope ? 0 : ease(this.aim);
    if (k > 0) {
      const s = this.sight();
      pos.x += (s.x - pos.x) * k;
      pos.y += (s.y - pos.y) * k;
      pos.z += (s.z - pos.z) * k;
      rot.x = rot.x * (1 - k) + s.tilt * k;
      rot.y *= 1 - k;
      rot.z *= 1 - k;
    }

    // Recoil, sway and bob on top; much steadier while aiming
    const loose = 1 - 0.8 * k;
    pos.x += (bobX + this.sway.yaw * 0.12) * loose;
    pos.y += (bobY + this.sway.pitch * 0.08) * loose + this.kick.flip[0] * 0.04;
    pos.z += this.kick.back[0];
    rot.x += this.kick.flip[0] + this.sway.pitch * 0.5 * loose;
    rot.y += this.kick.side[0] + this.sway.yaw * 0.6 * loose;
    rot.z += this.kick.roll[0] + this.sway.yaw * 0.4 * loose;


    this.flashTimer -= dt;
    this.flash.visible = this.flashTimer > 0;
  }
}
