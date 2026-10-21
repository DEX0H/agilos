import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GunState, HANDGUN } from './gun.js';
import { settings, capture } from './settings.js';
import { loadPistol, normalizeGun } from './models.js';
import { buildGunModel } from './gunmodels.js';

// The player's gun slot: first-person viewmodel and effects on top of the shared GunState.
// It starts with the handgun; a mystery box swaps in an SMG, assault rifle or sniper.
const RECOIL_YAW_JITTER = 0.4;  // sideways kick as a fraction of the upward kick
const VIEW_BASE_Z = -0.42;
const VIEW_BASE_Y = -0.2;
const DRAW_TIME = 0.22;         // the new gun swings up; it can fire straight away
const BASE_FOV = 75;
const SCOPE_SPEED = 12;         // how fast the scope zooms in and out

// Where each model sits inside the viewmodel group (longer guns sit farther back)
const VIEW_OFFSETS = {
  smg: { pos: new THREE.Vector3(-0.03, -0.01, 0.02), scale: 0.8 },
  rifle: { pos: new THREE.Vector3(-0.03, -0.01, 0.04), scale: 0.72 },
  sniper: { pos: new THREE.Vector3(-0.03, -0.02, 0.08), scale: 0.66 },
};

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

export class Firearm {
  constructor(camera, scene, player) {
    this.camera = camera;
    this.scene = scene;
    this.player = player;
    this.gun = new GunState(HANDGUN, player);
    this.viewKick = 0;
    this.flashTimer = 0;
    this.drawTimer = 0;
    this.triggerHeld = false;  // held left mouse, for automatic weapons
    this.scopeHeld = false;    // held right mouse, for scoped weapons
    this.zoom = 0;             // 0 = hip, 1 = fully scoped
    this.boxModels = {};       // built on first use

    // First-person viewmodel, parented to the camera
    this.model = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.35, metalness: 0.7 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.5, metalness: 0.6 });
    const grip = new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.75, metalness: 0 });

    const slide = new THREE.Mesh(new RoundedBoxGeometry(0.052, 0.07, 0.23, 3, 0.018), metal);
    slide.castShadow = true;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.06, 14), darkMetal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.005, -0.135);
    const frame = new THREE.Mesh(new RoundedBoxGeometry(0.046, 0.05, 0.17, 3, 0.012), darkMetal);
    frame.position.set(0, -0.045, 0.02);
    const frontSight = new THREE.Mesh(new RoundedBoxGeometry(0.012, 0.018, 0.012, 1, 0.003), darkMetal);
    frontSight.position.set(0, 0.044, -0.1);
    const handle = new THREE.Mesh(new RoundedBoxGeometry(0.047, 0.14, 0.058, 3, 0.02), grip);
    handle.position.set(0, -0.125, 0.075);
    handle.rotation.x = 0.25;
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.007, 8, 18, Math.PI), darkMetal);
    guard.rotation.set(0, Math.PI / 2, Math.PI);
    guard.position.set(0, -0.06, 0.02);

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.005, -0.15);
    slide.add(this.muzzle);

    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 10, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 4, 1.5) }), // HDR, blooms
    );
    this.flash.visible = false;
    this.muzzle.add(this.flash);

    this.model.position.set(0.24, VIEW_BASE_Y, VIEW_BASE_Z);
    this.model.rotation.y = -0.05;
    camera.add(this.model);

    // The handgun's own group: the simple pistol, replaced by the real model once it has loaded
    this.pistol = new THREE.Group();
    this.pistol.add(slide, barrel, frame, frontSight, handle, guard);
    this.model.add(this.pistol);
    this.current = this.pistol;
    // Pistol magazine, only shown during a reload (dropping out, then the new one going in)
    this.pistolMag = new THREE.Mesh(new RoundedBoxGeometry(0.032, 0.09, 0.042, 2, 0.006), darkMetal);
    this.pistolMag.position.set(0, -0.13, 0.065);
    this.pistolMag.rotation.x = 0.25;
    this.pistolMag.visible = false;
    this.pistol.add(this.pistolMag);
    this.pistolMagHome = this.pistolMag.position.clone();
    this.pistolMuzzle = this.muzzle.position.clone();
    this.pistolMuzzleParent = slide;
    const simple = [slide, barrel, frame, frontSight, handle, guard];
    loadPistol().then((src) => {
      const { object, muzzle } = normalizeGun(src, 0.24);
      object.position.set(0, -0.07, 0.05); // hand point a little low and back, like a held grip
      object.traverse((o) => { if (o.isMesh) o.castShadow = false; });
      this.pistol.add(object);
      for (const p of simple) p.visible = false;
      this.pistolMuzzle = muzzle.clone();
      this.pistolMuzzleParent = object;
      if (this.gun.spec.model === 'pistol') this.attachMuzzle(object, muzzle);
    }).catch((e) => console.warn('Pistol model failed to load; keeping the simple one', e));

    document.addEventListener('keydown', (e) => {
      if (!capture.action && e.code === settings.binds.reload && !e.repeat) this.gun.reload();
    });
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
    this.pistol.visible = spec.model === 'pistol';
    this.mag = null;
    for (const m of Object.values(this.boxModels)) m.object.visible = false;
    if (spec.model === 'pistol') {
      this.current = this.pistol;
      this.attachMuzzle(this.pistolMuzzleParent, this.pistolMuzzle);
      return;
    }
    let entry = this.boxModels[spec.model];
    if (!entry) {
      entry = buildGunModel(spec);
      const view = VIEW_OFFSETS[spec.model];
      entry.object.position.copy(view.pos);
      entry.object.scale.setScalar(view.scale);
      entry.object.traverse((o) => { if (o.isMesh) o.castShadow = false; });
      this.model.add(entry.object);
      this.boxModels[spec.model] = entry;
    }
    entry.object.visible = true;
    this.current = entry.object;
    this.mag = entry.mag;
    this.attachMuzzle(entry.object, entry.muzzle);
  }

  get spec() { return this.gun.spec; }
  get scoped() { return this.zoom > 0.85; }
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
    this.viewKick = spec.auto ? 0.025 : 0.05;
    this.flashTimer = 0.05;
    this.flash.visible = true;
    this.player.addRecoil(spec.recoil, (Math.random() - 0.5) * spec.recoil * RECOIL_YAW_JITTER);
    this.muzzle.getWorldPosition(_muzzle);
    world.addTracer(_muzzle, r.end);
    return r;
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

    this.model.rotation.x = 0.28 * pose + 0.6 * draw - 0.08 * slap;
    this.model.rotation.z = 0.55 * pose;
    this.model.rotation.y = -0.05 + 0.18 * pose;
    this.model.position.x = 0.24 - 0.05 * pose;
    this.model.position.y += 0.015 * slap - 0.03 * pose;

    // Magazine: out by 45%, back in by 75%
    const drop = reloading ? (p < 0.45 ? ss(p, 0.12, 0.45) : 1 - ss(p, 0.45, 0.75)) : 0;
    const pistol = g.spec.model === 'pistol';
    const mag = pistol ? this.pistolMag : this.mag;
    if (!mag) return;
    if (pistol) {
      // The pistol model has its own magazine; this one shows only while it is out of the grip
      mag.visible = reloading && drop > 0.08;
      mag.position.copy(this.pistolMagHome);
      mag.position.y -= 0.25 * drop;
    } else {
      mag.position.set(0, -0.32 * drop, 0.04 * drop);
      mag.rotation.x = -0.4 * drop;
      mag.visible = drop < 0.97;
    }
  }

  update(dt) {
    this.gun.update(dt);
    const spec = this.gun.spec;

    // Scope: zoom the camera, slow the mouse to match, hide the gun behind the scope overlay
    const wantZoom = spec.scope && this.scopeHeld && this.model.visible && !this.player.dead
      && this.gun.reloadTimer <= 0 ? 1 : 0;
    this.zoom += (wantZoom - this.zoom) * Math.min(1, dt * SCOPE_SPEED);
    if (Math.abs(wantZoom - this.zoom) < 0.01) this.zoom = wantZoom;
    const fov = BASE_FOV + ((spec.scopeFov || BASE_FOV) - BASE_FOV) * this.zoom;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    const half = (f) => Math.tan(THREE.MathUtils.degToRad(f / 2));
    this.player.sensScale = half(fov) / half(BASE_FOV);
    this.player.ads = this.scoped;

    // Recoil kick on the viewmodel settles back; a new gun swings up from below
    this.viewKick *= Math.exp(-14 * dt);
    this.drawTimer = Math.max(0, this.drawTimer - dt);
    const draw = this.drawTimer / DRAW_TIME;
    this.model.position.z = VIEW_BASE_Z + this.viewKick;
    this.model.position.y = VIEW_BASE_Y - 0.22 * draw * draw - 0.12 * this.zoom;
    // Behind the scope the gun itself is hidden (the overlay draws the scope)
    this.current.visible = this.zoom < 0.6;

    this.animateReload(draw);

    this.flashTimer -= dt;
    this.flash.visible = this.flashTimer > 0;
  }
}
