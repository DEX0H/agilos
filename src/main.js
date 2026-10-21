import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildArena } from './arena.js';
import { Player } from './player.js';
import { Handgun } from './weapon.js';
import { Knife } from './knife.js';
import { World } from './world.js';
import { NavGraph } from './nav.js';
import { Bots } from './bots.js';
import { Match } from './match.js';
import { settings, bindLabel, setSens, capture } from './settings.js';
import { buildControlsPanel } from './controls-panel.js';
import { createSky } from './sky.js';
import { createPostFx } from './postfx.js';
import { createDust } from './dust.js';

// Low-latency canvas: `desynchronized` lets the browser present frames without
// waiting on the page compositor where supported (Chrome, Edge).
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl2', {
  antialias: false,
  alpha: false,
  desynchronized: true,
  powerPreference: 'high-performance',
});
const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
const HIGH_PR = Math.min(window.devicePixelRatio, 1.5);
renderer.setPixelRatio(HIGH_PR);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.75;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const HORIZON = 0xe7a878;
scene.fog = new THREE.Fog(HORIZON, 55, 170);

// Room reflections for PBR materials (RoomEnvironment ships with three.js, MIT)
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;

const sky = createSky(scene);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 300);
scene.add(camera); // the gun viewmodel is a child of the camera

// ---- Game world ----
const { colliders, playerSpawn, mobSpawns, navPoints, navLinks, navJumps } = buildArena(scene);
const world = new World(scene, colliders);
const player = new Player(camera, colliders, playerSpawn);
world.add(player);
const nav = new NavGraph(colliders, navPoints, navLinks, navJumps);
const BOT_COUNT = 4;
const bots = new Bots(scene, world, nav, mobSpawns, BOT_COUNT);
const spawnPoints = [playerSpawn, ...mobSpawns];
const match = new Match(scene, world, player, bots, spawnPoints);

const weapon = new Handgun(camera, scene, player);
const knife = new Knife(camera, scene, player);
let active = weapon;

const dust = createDust(scene);
const postfx = createPostFx(renderer, scene, camera);

// ---- UI ----
const hud = document.getElementById('hud');
const overlay = document.getElementById('overlay');
const crosshair = document.getElementById('crosshair');
const hitmarker = document.getElementById('hitmarker');
const damageVignette = document.getElementById('damage');
const deadMsg = document.getElementById('dead');
const lockMsg = document.getElementById('lockmsg');
const feed = document.getElementById('feed');
const banner = document.getElementById('banner');
const shieldTint = document.getElementById('shieldtint');
const toast = document.getElementById('toast');
const hpFill = document.getElementById('hpfill');
const hpShield = document.getElementById('hpshield');
const hpNum = document.getElementById('hpnum');
buildControlsPanel(document.getElementById('settings'), document.getElementById('controlstext'));

let toastTimer = 0;
function showToast(text) {
  toast.textContent = text;
  toastTimer = 1.5;
}

let fps = 60;
let hitmarkerTimer = 0;

// 1 = handgun, 2 = knife. F flips the knife.
function setWeapon(w) {
  active = w;
  weapon.model.visible = w === weapon;
  knife.model.visible = w === knife;
}

// P toggles quality: high = ambient occlusion and sharper pixels, low = fastest frames
let quality = 'high';
function setQuality(q) {
  quality = q;
  renderer.setPixelRatio(q === 'high' ? HIGH_PR : 1);
  postfx.gtao.enabled = q === 'high';
  postfx.resize(window.innerWidth, window.innerHeight);
}

document.addEventListener('keydown', (e) => {
  if (capture.action) return; // a key is being rebound
  const b = settings.binds;
  if (e.code === b.weapon1) setWeapon(weapon);
  if (e.code === b.weapon2) setWeapon(knife);
  if (e.code === b.flip && !e.repeat) knife.flip();
  if (e.code === b.quality && !e.repeat) setQuality(quality === 'high' ? 'low' : 'high');
  if (e.code === b.sensDown || e.code === b.sensUp) {
    setSens(settings.sens + (e.code === b.sensUp ? 0.1 : -0.1));
    showToast(`Sensitivity ${settings.sens.toFixed(2)}`);
  }
  // Enter starts a new match once you are out or the match is over
  if (e.code === 'Enter' && !e.repeat && (match.state === 'over' || (match.state === 'live' && player.dead))) {
    match.start();
  }
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === document.body;
  overlay.style.display = locked ? 'none' : 'flex';
  crosshair.style.display = locked ? 'block' : 'none';
  if (locked) lockMsg.style.display = 'none';
  // First time you click in, the match begins
  if (locked && match.state === 'warmup') match.start();
});

// The browser refused mouse lock (raised by pointerlockerror or by the player's click handler)
function showLockFailed() {
  lockMsg.style.display = 'block';
}
document.addEventListener('pointerlockerror', showLockFailed);
document.addEventListener('agilos:lockfailed', showLockFailed);

// Left click fires the instant the button goes down, against the latest aim
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !player.locked || player.frozen) return;
  player.syncAim();
  const r = active.fire(world);
  if (r.hit) hitmarkerTimer = 0.15;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  postfx.resize(window.innerWidth, window.innerHeight);
});

// Kill feed, newest on top, each line fades after a few seconds
world.onKill((killer, victim, how) => {
  const line = document.createElement('div');
  line.className = 'feed-line';
  const k = killer ? killer.name : 'World';
  const icon = how === 'headshot' ? '⌖ headshot' : how;
  line.textContent = killer ? `${k}  [${icon}]  ${victim.name}` : `${victim.name}  [${how}]`;
  if (killer === player || victim === player) line.classList.add('mine');
  feed.prepend(line);
  while (feed.children.length > 6) feed.lastChild.remove();
  setTimeout(() => line.classList.add('fade'), 4000);
  setTimeout(() => line.remove(), 5000);
});

// Debug handle for automated testing
window.agilos = {
  player, weapon, knife, setWeapon, world, nav, bots, match, renderer, scene, postfx,
  get kills() { return player.kills; },
};

let last = performance.now();
function frame(now) {
  // Clamp both ways: the first rAF timestamp can be earlier than `last`
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.05));
  const t = now / 1000;
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;

  player.update(dt);
  weapon.update(dt);
  knife.update(dt);
  bots.update(dt);
  match.update(dt);
  world.update(dt);

  sky.position.copy(camera.position);
  dust.update(t);
  postfx.grade.uniforms.uTime.value = t;

  // Crosshair gap shows the real cone: pixels = tan(spread) / tan(fov/2) * half screen height
  let gap = 4;
  if (active === weapon && !player.dead) {
    const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    gap = 3 + Math.tan(weapon.currentSpread()) / half * (window.innerHeight / 2);
  }
  crosshair.style.setProperty('--gap', `${Math.min(80, gap).toFixed(1)}px`);

  toastTimer = Math.max(0, toastTimer - dt);
  toast.style.opacity = String(Math.min(1, toastTimer * 2));
  shieldTint.style.opacity = player.shielded && !player.dead ? '1' : '0';

  // Health bar: green > 60%, yellow > 30%, red below; blue overlay while the spawn shield is up
  const hpFrac = Math.max(0, player.health / player.maxHealth);
  hpFill.style.width = `${hpFrac * 100}%`;
  hpFill.style.background = hpFrac > 0.6 ? '#5fd35a' : hpFrac > 0.3 ? '#e6c33a' : '#e2452f';
  hpShield.style.opacity = player.shielded && !player.dead ? '1' : '0';
  hpNum.textContent = String(Math.ceil(player.health));

  hitmarkerTimer = Math.max(0, hitmarkerTimer - dt);
  hitmarker.style.opacity = String(hitmarkerTimer / 0.15);
  damageVignette.style.opacity = String(player.damageFlash / 0.35);
  const bannerText = match.bannerText();
  banner.style.display = bannerText ? 'flex' : 'none';
  banner.textContent = bannerText;
  // "Killed by" only when the match banner isn't already saying what happened
  deadMsg.style.display = player.dead && !bannerText ? 'flex' : 'none';
  if (player.dead) {
    deadMsg.textContent = player.lastAttacker ? `KILLED BY ${player.lastAttacker.name.toUpperCase()}` : 'YOU DIED';
  }

  const v = player.velocity;
  const reloading = weapon.reloadTimer > 0;
  const shield = player.shielded && !player.dead ? `   SHIELD ${Math.ceil(player.shieldTimer)}s (firing drops it)` : '';
  hud.textContent =
    `HP      ${Math.ceil(player.health)}${shield}\n` +
    `WEAPON  ${active === knife ? `knife (${bindLabel('flip')} flip)` : `handgun  ${reloading ? 'RELOADING' : `${weapon.ammo}/${weapon.magSize}   reserve ${weapon.reserve}`}`}\n` +
    `KILLS   ${player.kills}   alive ${match.aliveCount()}/${match.total}\n` +
    (match.zoneText() ? `${match.zoneText()}\n` : '') +
    `speed   ${Math.hypot(v.x, v.z).toFixed(1)} m/s   height ${player.position.y.toFixed(1)} m\n` +
    `state   ${player.state}   double jump ${player.canDouble ? 'ready' : 'used'}\n` +
    `fps     ${fps.toFixed(0)}   quality ${quality} (${bindLabel('quality')})   sens ${settings.sens.toFixed(2)} (${bindLabel('sensDown')} ${bindLabel('sensUp')})`;

  postfx.composer.render(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
