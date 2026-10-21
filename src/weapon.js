import * as THREE from 'three';
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

    // First-person viewmodel, parented to the camera
    this.model = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.4, metalness: 0.6 });
    const grip = new THREE.MeshStandardMaterial({ color: 0x3b2a1a, roughness: 0.8 });
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.22), metal);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 0.16), metal);
    frame.position.set(0, -0.04, 0.02);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.13, 0.055), grip);
    handle.position.set(0, -0.12, 0.07);
    handle.rotation.x = 0.25;
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.01, -0.12);
    slide.add(this.muzzle);

    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffd27a }),
    );
    this.flash.visible = false;
    this.muzzle.add(this.flash);

    this.model.add(slide, frame, handle);
    this.model.position.set(0.24, -0.2, VIEW_BASE_Z);
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
    const mat = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 });
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
