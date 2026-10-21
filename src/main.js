import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildArena } from './arena.js';
import { Player } from './player.js';
import { Handgun } from './weapon.js';
import { Enemies } from './enemies.js';
import { createSky } from './sky.js';
import { createPostFx } from './postfx.js';
import { createDust } from './dust.js';

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const HORIZON = 0xe7a878;
scene.fog = new THREE.Fog(HORIZON, 55, 170);

// Room reflections for PBR materials (RoomEnvironment ships with three.js, MIT)
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

const sky = createSky(scene);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 300);
scene.add(camera); // the gun viewmodel is a child of the camera

const { colliders } = buildArena(scene);
const player = new Player(camera, colliders, new THREE.Vector3(0, 0, 14));
const weapon = new Handgun(camera, scene, player);
const enemies = new Enemies(scene, colliders);
const dust = createDust(scene);
const postfx = createPostFx(renderer, scene, camera);

const hud = document.getElementById('hud');
const overlay = document.getElementById('overlay');
const crosshair = document.getElementById('crosshair');
const hitmarker = document.getElementById('hitmarker');
const damageVignette = document.getElementById('damage');
const deadMsg = document.getElementById('dead');

let kills = 0;
let hitmarkerTimer = 0;

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === document.body;
  overlay.style.display = locked ? 'none' : 'flex';
  crosshair.style.display = locked ? 'block' : 'none';
});

// Left click fires while the mouse is locked
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !player.locked) return;
  const r = weapon.fire(enemies, colliders);
  if (r.hit) hitmarkerTimer = 0.15;
  if (r.kill) kills++;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  postfx.resize(window.innerWidth, window.innerHeight);
});

// Debug handle for automated testing
window.agilos = { player, weapon, enemies, get kills() { return kills; } };

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  const t = now / 1000;
  last = now;

  player.update(dt);
  weapon.update(dt);
  enemies.update(dt, player);

  sky.position.copy(camera.position);
  dust.update(t);
  postfx.grade.uniforms.uTime.value = t;

  hitmarkerTimer = Math.max(0, hitmarkerTimer - dt);
  hitmarker.style.opacity = String(hitmarkerTimer / 0.15);
  damageVignette.style.opacity = String(player.damageFlash / 0.35);
  deadMsg.style.display = player.dead ? 'flex' : 'none';

  const v = player.velocity;
  const p = player.position;
  const reloading = weapon.reloadTimer > 0;
  hud.textContent =
    `HP      ${Math.ceil(player.health)}\n` +
    `AMMO    ${reloading ? 'RELOADING' : `${weapon.ammo}/${weapon.magSize}   reserve ${weapon.reserve}`}\n` +
    `KILLS   ${kills}   mobs alive ${enemies.aliveCount()}\n` +
    `speed   ${Math.hypot(v.x, v.z).toFixed(1)} m/s\n` +
    `vert    ${v.y.toFixed(1)} m/s\n` +
    `pos     ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}\n` +
    `ground  ${player.onGround ? 'yes' : 'no'}   double jump ${player.canDouble ? 'ready' : 'used'}`;

  postfx.composer.render(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
