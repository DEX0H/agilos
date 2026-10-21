// Fonts, bundled with the game (SIL Open Font License): Teko for display, Rajdhani for UI
import '@fontsource/teko/latin-500.css';
import '@fontsource/teko/latin-600.css';
import '@fontsource/rajdhani/latin-500.css';
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/rajdhani/latin-700.css';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildArena } from './arena.js';
import { dressCity } from './city.js';
import { Player } from './player.js';
import { Firearm } from './weapon.js';
import { HANDGUN, RARITY_COLORS } from './gun.js';
import { MysteryBoxes } from './mysterybox.js';
import { Knife } from './knife.js';
import { World } from './world.js';
import { NavGraph } from './nav.js';
import { Bots } from './bots.js';
import { Match } from './match.js';
import { settings, bindLabel, setSens, capture, onBotsChange } from './settings.js';
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
const arena = buildArena(scene);
const { colliders, playerSpawn, mobSpawns, navPoints, navLinks, navJumps } = arena;
// City facades and details load in the background; the plain boxes show until then
dressCity(scene, arena).catch((e) => console.warn('City dressing failed to load; keeping plain walls', e));
const world = new World(scene, colliders);
const player = new Player(camera, colliders, playerSpawn);
world.add(player);
const nav = new NavGraph(colliders, navPoints, navLinks, navJumps);
const boxes = new MysteryBoxes(scene, world, navPoints);
const bots = new Bots(scene, world, nav, mobSpawns, settings.bots, boxes);
const spawnPoints = [playerSpawn, ...mobSpawns];
const match = new Match(scene, world, player, bots, spawnPoints);
match.extraSpawns = navPoints;
// The bot count from settings applies right away before the first match, otherwise at the next one
onBotsChange((n) => { if (match.state === 'warmup') bots.setCount(n); });

const weapon = new Firearm(camera, scene, player);
const knife = new Knife(camera, scene, player);
// Every spawn (including a new match) starts with a fresh handgun; box weapons are lost
player.onRespawn = () => weapon.equip(HANDGUN);
let active = weapon;

// A new match also moves the mystery boxes to new random spots
function startMatch() {
  bots.setCount(settings.bots);
  boxes.place();
  match.start();
}

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
const promptEl = document.getElementById('prompt');
const minimap = document.getElementById('minimap');
const mapCtx = minimap.getContext('2d');
const ringInfo = document.getElementById('ringinfo');
const ammoName = document.getElementById('ammoname');
const ammoRow = document.getElementById('ammorow');
const ammoMag = document.getElementById('ammomag');
const ammoRes = document.getElementById('ammores');
const pips = document.getElementById('pips');
const reloadBar = document.getElementById('reloadbar');
const reloadFill = reloadBar.firstElementChild;
const reloadHint = document.getElementById('reloadhint');
const scope = document.getElementById('scope');
buildControlsPanel(document.getElementById('settings'), document.getElementById('controlstext'));

let toastTimer = 0;
function showToast(text, color = '#fff', time = 1.5) {
  toast.textContent = text;
  toast.style.color = color;
  toastTimer = time;
}

// Mystery box: the spin lands and the weapon goes straight into your hands
const RARITY_NAMES = { common: 'COMMON', rare: 'RARE', legendary: 'LEGENDARY' };
function useBox() {
  if (!player.locked || player.dead || player.frozen) return;
  const box = boxes.inReach(player, camera.getWorldDirection(new THREE.Vector3()));
  if (!box || !box.ready) return;
  box.spin(player, (spec) => {
    if (player.dead) return;
    weapon.equip(spec);
    setWeapon(weapon);
    showToast(`${spec.label.toUpperCase()}  ·  ${RARITY_NAMES[spec.rarity]}`, RARITY_COLORS[spec.rarity], 2.2);
  });
}

let fps = 60;
let hitmarkerTimer = 0;

// 1 = handgun, 2 = knife. F flips the knife.
function setWeapon(w) {
  if (w !== active) weapon.release();
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
  if (e.code === b.interact && !e.repeat) useBox();
  if (e.code === b.quality && !e.repeat) setQuality(quality === 'high' ? 'low' : 'high');
  if (e.code === b.sensDown || e.code === b.sensUp) {
    setSens(settings.sens + (e.code === b.sensUp ? 0.1 : -0.1));
    showToast(`Sensitivity ${settings.sens.toFixed(2)}`);
  }
  // Enter starts a new match once you are out or the match is over
  if (e.code === 'Enter' && !e.repeat && (match.state === 'over' || (match.state === 'live' && player.dead))) {
    startMatch();
  }
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === document.body;
  overlay.style.display = locked ? 'none' : 'flex';
  crosshair.style.display = locked ? 'block' : 'none';
  if (locked) lockMsg.style.display = 'none';
  // First time you click in, the match begins
  if (locked && match.state === 'warmup') startMatch();
  if (!locked) weapon.release();
});

// The browser refused mouse lock (raised by pointerlockerror or by the player's click handler)
function showLockFailed() {
  lockMsg.style.display = 'block';
}
document.addEventListener('pointerlockerror', showLockFailed);
document.addEventListener('agilos:lockfailed', showLockFailed);

// Left click fires the instant the button goes down, against the latest aim.
// Holding it keeps automatic weapons firing (see the frame loop). Right click scopes.
document.addEventListener('mousedown', (e) => {
  if (!player.locked) return;
  if (e.button === 2) {
    if (active === weapon) weapon.scopeHeld = true;
    return;
  }
  if (e.button !== 0 || player.frozen) return;
  if (active === weapon) weapon.triggerHeld = true;
  player.syncAim();
  const r = active.fire(world);
  if (r.hit) hitmarkerTimer = 0.15;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) weapon.triggerHeld = false;
  if (e.button === 2) weapon.scopeHeld = false;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

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

// Debug handle for automated testing. Only exposed in local dev or with ?debug in the URL,
// so it isn't sitting on every player's window object. (Everything client-side can be
// changed by a determined player anyway; real anti-cheat needs an authoritative server.)
const DEBUG = import.meta.env.DEV || new URLSearchParams(location.search).has('debug');
if (DEBUG) window.agilos = {
  player, weapon, knife, setWeapon, world, nav, bots, match, boxes, renderer, scene, postfx, useBox,
  get kills() { return player.kills; },
};

const _fwd = new THREE.Vector3();
// Ammo panel. Pips are rebuilt only when the weapon changes; each frame just marks spent ones.
let pipsFor = null;
let pipsShown = -1;
function updateAmmo() {
  const knifeOut = active === knife;
  const spec = weapon.spec;
  ammoName.textContent = knifeOut ? 'Knife' : spec.label;
  ammoName.style.setProperty('--rarity', knifeOut || !spec.rarity ? '#d9d9d9' : RARITY_COLORS[spec.rarity]);
  ammoRow.style.display = knifeOut ? 'none' : 'flex';
  pips.style.display = knifeOut ? 'none' : 'flex';
  const reloading = !knifeOut && weapon.reloadTimer > 0;
  reloadBar.style.opacity = reloading ? '1' : '0';
  if (reloading) reloadFill.style.width = `${(1 - weapon.reloadTimer / spec.reloadTime) * 100}%`;

  let hint = '';
  if (!knifeOut && !player.dead) {
    if (weapon.ammo === 0 && weapon.reserve === 0) hint = 'NO AMMO';
    else if (!reloading && weapon.ammo <= Math.ceil(weapon.magSize / 4)) hint = `RELOAD  [${bindLabel('reload')}]`;
  }
  reloadHint.textContent = hint;
  reloadHint.className = hint === 'NO AMMO' ? 'empty' : '';
  reloadHint.style.opacity = hint ? '1' : '0';
  if (knifeOut) return;

  const low = weapon.ammo <= Math.ceil(weapon.magSize / 4);
  ammoMag.textContent = String(weapon.ammo);
  ammoMag.className = low ? 'low' : '';
  ammoRes.textContent = `/ ${weapon.reserve === Infinity ? '∞' : weapon.reserve}`;
  if (pipsFor !== weapon.gun) {
    pipsFor = weapon.gun;
    pipsShown = -1;
    pips.innerHTML = '';
    for (let i = 0; i < weapon.magSize; i++) pips.append(document.createElement('i'));
    pips.classList.toggle('big', weapon.magSize <= 12);
  }
  pips.classList.toggle('low', low);
  if (pipsShown !== weapon.ammo) {
    pipsShown = weapon.ammo;
    // Rounds leave from the left, like a magazine emptying toward the chamber
    const n = pips.children.length;
    for (let i = 0; i < n; i++) pips.children[i].classList.toggle('spent', i < n - weapon.ammo);
  }
}

// Ring announcements in the toast line
match.onRing = (text) => showToast(text, text.includes('CLOSING') ? '#ff8a5c' : '#dfe9ff', 2.5);

// Minimap, north (-z) up. Redrawn every few frames; it is cheap.
const MAP_SPAN = 62;
function drawMinimap() {
  const S = minimap.width;
  const k = S / MAP_SPAN;
  const mx = (x) => (x + MAP_SPAN / 2) * k;
  const ctx = mapCtx;
  ctx.clearRect(0, 0, S, S);
  // Buildings, lighter the taller they are
  for (const r of arena.roofs) {
    const l = 30 + r.y * 3;
    ctx.fillStyle = `rgb(${l},${l + 4},${l + 10})`;
    ctx.fillRect(mx(r.cx - r.w / 2), mx(r.cz - r.d / 2), r.w * k, r.d * k);
  }
  const z = match.zone;
  const live = match.state === 'live' || match.state === 'over' || match.state === 'countdown';
  if (live) {
    // Outside the ring: red wash
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, S, S);
    ctx.arc(mx(z.cx), mx(z.cz), Math.max(0, z.r) * k, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(200,40,30,0.32)';
    ctx.fill('evenodd');
    ctx.restore();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#5fa8ff';
    ctx.beginPath();
    ctx.arc(mx(z.cx), mx(z.cz), Math.max(0.1, z.r) * k, 0, Math.PI * 2);
    ctx.stroke();
    if (z.phase < match.rounds && z.toR < z.r - 0.5) {
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mx(z.toX), mx(z.toZ), Math.max(0.6, z.toR) * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // Mystery boxes: gold when ready, dim when recharging
  for (const b of boxes.active()) {
    ctx.fillStyle = b.ready ? '#ffb02e' : 'rgba(255,176,46,0.35)';
    ctx.fillRect(mx(b.position.x) - 5, mx(b.position.z) - 5, 10, 10);
  }
  // You: an arrow pointing where you look
  if (!player.dead) {
    const px = mx(player.position.x);
    const pz = mx(player.position.z);
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(-player.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(9, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(-9, 10);
    ctx.closePath();
    ctx.fillStyle = '#ffe14d';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  // Ring round and timer under the map
  if (live && match.state !== 'countdown') {
    if (z.phase >= match.rounds) {
      ringInfo.textContent = 'RING CLOSED';
      ringInfo.className = 'closing';
    } else {
      const s = Math.max(0, Math.ceil(z.phaseTime));
      const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      ringInfo.textContent = z.shrinking ? `RING ${z.phase + 1}/${match.rounds} CLOSING ${t}` : `RING ${z.phase + 1}/${match.rounds} IN ${t}`;
      ringInfo.className = z.shrinking ? 'closing' : '';
    }
  } else {
    ringInfo.textContent = '';
  }
}
let mapFrame = 0;

let last = performance.now();
function frame(now) {
  // Clamp both ways: the first rAF timestamp can be earlier than `last`
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.05));
  const t = now / 1000;
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;

  player.update(dt);
  // Held trigger on an automatic weapon: the gun's own fire rate paces the shots
  if (active === weapon && weapon.triggerHeld && weapon.spec.auto && player.locked && !player.frozen && !player.dead) {
    player.syncAim();
    const r = weapon.fire(world);
    if (r.hit) hitmarkerTimer = 0.15;
  }
  weapon.update(dt);
  knife.update(dt);
  bots.update(dt);
  boxes.update(dt, t, camera.position);
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

  // Scope overlay replaces the crosshair while zoomed in
  const scoped = active === weapon && weapon.scoped;
  scope.style.opacity = scoped ? '1' : '0';
  crosshair.style.visibility = scoped ? 'hidden' : 'visible';

  // Mystery box prompt
  let promptText = '';
  if (player.locked && !player.dead) {
    const box = boxes.inReach(player, camera.getWorldDirection(_fwd));
    if (box) {
      if (box.ready) promptText = `[${bindLabel('interact')}]  MYSTERY BOX`;
      else if (box.cooldownLeft > 0) promptText = `RECHARGING  ${Math.ceil(box.cooldownLeft)}s`;
    }
  }
  promptEl.textContent = promptText;
  promptEl.style.opacity = promptText ? '1' : '0';

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

  updateAmmo();
  if (++mapFrame % 3 === 0) drawMinimap();
  const v = player.velocity;
  const shield = player.shielded && !player.dead ? `   SHIELD ${Math.ceil(player.shieldTimer)}s (firing drops it)` : '';
  hud.textContent =
    `HP      ${Math.ceil(player.health)}${shield}\n` +
    `KILLS   ${player.kills}   alive ${match.aliveCount()}/${match.total}\n` +
    (match.zoneText() ? `${match.zoneText()}\n` : '') +
    `speed   ${Math.hypot(v.x, v.z).toFixed(1)} m/s   height ${player.position.y.toFixed(1)} m\n` +
    `state   ${player.state}   double jump ${player.canDouble ? 'ready' : 'used'}\n` +
    `fps     ${fps.toFixed(0)}   quality ${quality} (${bindLabel('quality')})   sens ${settings.sens.toFixed(2)} (${bindLabel('sensDown')} ${bindLabel('sensUp')})`;

  postfx.composer.render(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
