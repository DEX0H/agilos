import * as THREE from 'three';
import { buildArena } from './arena.js';
import { Player } from './player.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc6e8);
scene.fog = new THREE.Fog(0x9fc6e8, 60, 150);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 300);

const { colliders } = buildArena(scene);
const player = new Player(camera, colliders);
player.position.set(0, 0, 14);

const hud = document.getElementById('hud');
const overlay = document.getElementById('overlay');
const crosshair = document.getElementById('crosshair');

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === document.body;
  overlay.style.display = locked ? 'none' : 'flex';
  crosshair.style.display = locked ? 'block' : 'none';
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  player.update(dt);

  const v = player.velocity;
  const p = player.position;
  hud.textContent =
    `speed   ${Math.hypot(v.x, v.z).toFixed(1)} m/s\n` +
    `vert    ${v.y.toFixed(1)} m/s\n` +
    `pos     ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}\n` +
    `ground  ${player.onGround ? 'yes' : 'no'}   double jump ${player.canDouble ? 'ready' : 'used'}`;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
