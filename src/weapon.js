import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { raycastWorld } from './physics.js';

// Handgun: semi-auto, hitscan, recoil, reload.
const RANGE = 150;
const MAG_SIZE = 12;
const RESERVE_START = 48;
const RELOAD_TIME = 1.4;
const FIRE_INTERVAL = 0.22;
const DAMAGE = 25;
const HEADSHOT_MULT = 2.5;
const SPREAD = 0.006;          // radians of random spread per shot
const RECOIL_PITCH = 0.03;     // camera kick up, radians
const RECOIL_YAW_JITTER = 0.012;
const VIEW_BASE_Z = -0.42;

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _end = new THREE.Vector3();

export class Handgun {
  constructor(camera, scene, player) {
    this.camera = camera;
    this.scene = scene;
    this.player = player;
    this.magSize = MAG_SIZE;
    this.ammo = MAG_SIZE;
    this.reserve = RESERVE_START;
    this.reloadTimer = 0;
    this.cooldown = 0;
    this.viewKick = 0;
    this.flashTimer = 0;
    this.tracers = [];

    // First-person viewmodel, parented to the camera. Rounded parts, not boxes.
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

    this.onKeyDown = (e) => {
      if (e.code === 'KeyR' && !e.repeat) this.reload();
    };
    document.addEventListener('keydown', this.onKeyDown);
  }

  reload() {
    if (this.reloadTimer > 0 || this.ammo === this.magSize || this.reserve <= 0) return;
    this.reloadTimer = RELOAD_TIME;
  }

  finishReload() {
    const need = this.magSize - this.ammo;
    const take = Math.min(need, this.reserve);
    this.ammo += take;
    this.reserve -= take;
    this.reloadTimer = 0;
  }

  // Returns { hit, headshot, kill } for the HUD.
  fire(enemies, colliders) {
    const result = { hit: false, headshot: false, kill: false };
    if (this.reloadTimer > 0 || this.cooldown > 0 || this.player.dead) return result;
    if (this.ammo <= 0) {
      this.reload();
      return result;
    }

    this.ammo--;
    this.cooldown = FIRE_INTERVAL;
    this.viewKick = 0.05;
    this.flashTimer = 0.05;
    this.flash.visible = true;
    this.player.addRecoil(RECOIL_PITCH, (Math.random() - 0.5) * RECOIL_YAW_JITTER);

    this.camera.getWorldPosition(_origin);
    this.camera.getWorldDirection(_dir);
    _dir.x += (Math.random() - 0.5) * SPREAD;
    _dir.y += (Math.random() - 0.5) * SPREAD;
    _dir.normalize();
    this.muzzle.getWorldPosition(_muzzle);

    const worldDist = raycastWorld(_origin, _dir, RANGE, colliders);
    const maxDist = Math.min(RANGE, worldDist);
    _end.copy(_origin).addScaledVector(_dir, maxDist);

    const hit = enemies.raycastHit(_origin, _dir, maxDist);
    if (hit) {
      result.hit = true;
      result.headshot = hit.headshot;
      _end.copy(hit.point);
      const dmg = DAMAGE * (hit.headshot ? HEADSHOT_MULT : 1);
      result.kill = hit.mob.takeHit(dmg);
    }

    this.addTracer(_muzzle, _end);
    return result;
  }

  addTracer(a, b) {
    const geom = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(4, 3, 1.6), transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geom, mat);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.06 });
  }

  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);

    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.finishReload();
    }

    // Recoil kick on the viewmodel settles back
    this.viewKick *= Math.exp(-14 * dt);
    this.model.position.z = VIEW_BASE_Z + this.viewKick;

    // Tilt the gun down while reloading
    const targetTilt = this.reloadTimer > 0 ? 0.35 : 0;
    this.model.rotation.x += (targetTilt - this.model.rotation.x) * Math.min(1, dt * 10);

    this.flashTimer -= dt;
    this.flash.visible = this.flashTimer > 0;

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        t.line.material.dispose();
        this.tracers.splice(i, 1);
      }
    }
  }
}
