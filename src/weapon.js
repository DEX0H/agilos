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
  smg: new THREE.Vector3(-0.02, -0.02, 0.1),
  rifle: new THREE.Vector3(-0.02, -0.02, 0.2),
  sniper: new THREE.Vector3(-0.02, -0.03, 0.3),
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
    for (const m of Object.values(this.boxModels)) m.object.visible = false;
    if (spec.model === 'pistol') {
      this.current = this.pistol;
      this.attachMuzzle(this.pistolMuzzleParent, this.pistolMuzzle);
      return;
    }
    let entry = this.boxModels[spec.model];
    if (!entry) {
      entry = buildGunModel(spec);
      entry.object.position.copy(VIEW_OFFSETS[spec.model]);
      entry.object.traverse((o) => { if (o.isMesh) o.castShadow = false; });
      this.model.add(entry.object);
      this.boxModels[spec.model] = entry;
    }
    entry.object.visible = true;
    this.current = entry.object;
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

    // Tilt the gun down while reloading
    const targetTilt = (this.gun.reloadTimer > 0 ? 0.35 : 0) + 0.6 * draw;
    this.model.rotation.x += (targetTilt - this.model.rotation.x) * Math.min(1, dt * 10);

    this.flashTimer -= dt;
    this.flash.visible = this.flashTimer > 0;
  }
}
