import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GunState, HANDGUN } from './gun.js';
import { settings, capture } from './settings.js';

// The player's handgun: first-person viewmodel and effects on top of the shared GunState.
const RECOIL_PITCH = 0.03;     // camera kick up, radians
const RECOIL_YAW_JITTER = 0.012;
const VIEW_BASE_Z = -0.42;

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

export class Handgun {
  constructor(camera, scene, player) {
    this.camera = camera;
    this.scene = scene;
    this.player = player;
    this.gun = new GunState(HANDGUN, player);
    this.viewKick = 0;
    this.flashTimer = 0;

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

    this.model.add(slide, barrel, frame, frontSight, handle, guard);
    this.model.position.set(0.24, -0.2, VIEW_BASE_Z);
    this.model.rotation.y = -0.05;
    camera.add(this.model);

    document.addEventListener('keydown', (e) => {
      if (!capture.action && e.code === settings.binds.reload && !e.repeat) this.gun.reload();
    });
  }

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

    this.viewKick = 0.05;
    this.flashTimer = 0.05;
    this.flash.visible = true;
    this.player.addRecoil(RECOIL_PITCH, (Math.random() - 0.5) * RECOIL_YAW_JITTER);
    this.muzzle.getWorldPosition(_muzzle);
    world.addTracer(_muzzle, r.end);
    return r;
  }

  update(dt) {
    this.gun.update(dt);

    // Recoil kick on the viewmodel settles back
    this.viewKick *= Math.exp(-14 * dt);
    this.model.position.z = VIEW_BASE_Z + this.viewKick;

    // Tilt the gun down while reloading
    const targetTilt = this.gun.reloadTimer > 0 ? 0.35 : 0;
    this.model.rotation.x += (targetTilt - this.model.rotation.x) * Math.min(1, dt * 10);

    this.flashTimer -= dt;
    this.flash.visible = this.flashTimer > 0;
  }
}
