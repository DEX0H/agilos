import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { Character, STAND_H, NO_INPUT } from './character.js';
import { GunState, HANDGUN } from './gun.js';
import { loadCharacter, loadAnimations, loadPistol, normalizeGun } from './models.js';
import { buildGunModel } from './gunmodels.js';

// Animations that play once and hold their last frame
const ONE_SHOT_ANIMS = ['Jump_Start', 'Jump_Land', 'Death01', 'Pistol_Shoot', 'Pistol_Reload', 'Hit_Chest', 'Hit_Head', 'Roll'];
const DEATH_SHOW = 1.6; // seconds the death animation stays visible

// Bots play like players: same Character movement (sprint, slide, double jump,
// wall jump), same handgun with the same accuracy rules, and they fight everyone.
// Only the input comes from AI instead of a keyboard. Network players will slot in
// the same way later.

const NAMES = ['Viper', 'Rook', 'Ghost', 'Nova', 'Hex', 'Blitz', 'Kestrel', 'Mako'];
const COLORS = [0x6a2420, 0x24486a, 0x2f5a2a, 0x5a4a1e, 0x4a2a5a, 0x1f5a55, 0x5a2a3f, 0x3a3f46];

// Perception and aim
const SIGHT_RANGE = 38;
const PERCEPTION_INTERVAL = 0.15;
const FORGET_TIME = 3.5;          // seconds a target is chased after losing sight
const ENGAGE_RANGE = 30;          // only start fights inside this distance
const REACTION_MIN = 0.45;        // seconds from first sight to first shot
const REACTION_RAND = 0.4;
const TURN_RATE = 6;              // radians per second the aim can swing
const AIM_NOISE = 0.09;           // radians of aim wobble when a target is first seen
const AIM_SETTLE = 2.5;           // seconds of tracking to reach best aim
const MIN_NOISE = 0.35;           // fraction of the wobble that never goes away
const HEAD_AIM_CHANCE = 0.15;     // chance per engagement to go for the head
const FIRE_CONE = 0.09;           // fire when aim is within this of the target
const SHOT_GAP_MIN = 0.15;        // extra human-ish delay between shots
const SHOT_GAP_RAND = 0.3;
const STOP_TO_SHOOT = 0.14;       // CS-style: stop moving briefly to shoot accurately

// Movement
const PREF_MIN = 6;               // preferred fighting distance
const PREF_MAX = 15;
const REPATH_INTERVAL = 0.8;
const WAYPOINT_REACH = 0.7;
const GOAL_TIME_MIN = 8;
const GOAL_TIME_RAND = 6;
const HUNT_CHANCE = 0.45;         // when wandering, chance to head for a known combatant
const RESPAWN_TIME = 5;
const BOX_SEEK_RANGE = 32;        // a bot with only a handgun detours to a ready box this close
const BOX_SEEK_CHANCE = 0.7;
const BURST_PAUSE_CHANCE = 0.12;  // automatic weapons: chance per shot to pause between bursts

const _aim = new THREE.Vector3();
const _to = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function approach(cur, target, maxStep) {
  const d = angleDiff(cur, target);
  return cur + Math.max(-maxStep, Math.min(maxStep, d));
}

const TAG_FONT = '700 38px Rajdhani, system-ui, sans-serif';

function drawNameTag(canvas, text) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = TAG_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(text.toUpperCase(), 128, 34);
  ctx.fillStyle = '#ffe6c2';
  ctx.fillText(text.toUpperCase(), 128, 34);
}

function makeNameTag(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  drawNameTag(canvas, text);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(1.2, 0.3, 1);
  // The web font may still be loading: redraw once it is ready
  if (document.fonts && document.fonts.load) {
    document.fonts.load(TAG_FONT).then(() => {
      drawNameTag(canvas, text);
      tex.needsUpdate = true;
    }).catch(() => {});
  }
  return sprite;
}

export class Bot extends Character {
  constructor(scene, world, nav, spawn, index, spawnPoints) {
    super(world.colliders, spawn, NAMES[index % NAMES.length]);
    this.index = index;
    this.world = world;
    this.nav = nav;
    this.spawnPoints = spawnPoints;
    this.respawnTime = RESPAWN_TIME;
    this.gun = new GunState(HANDGUN, this, { infiniteReserve: true });
    this.ads = true;            // bots count as scoped when holding a sniper
    this.boxes = null;          // set by Bots
    this.boxTarget = null;      // mystery box the bot is heading to
    this.heldModels = {};       // third-person gun models, built when first needed
    this.yaw = Math.random() * Math.PI * 2;

    // Combat memory
    this.target = null;
    this.targetVisible = false;
    this.timeSinceSeen = 0;
    this.lastKnown = new THREE.Vector3();
    this.reaction = 0;
    this.trackTime = 0;
    this.aimHead = false;
    this.noiseYaw = 0;
    this.noisePitch = 0;
    this.noiseTimer = 0;
    this.shotGap = 0;
    this.stopTimer = 0;
    this.perceptionTimer = Math.random() * PERCEPTION_INTERVAL;

    // Navigation
    this.path = [];
    this.pathIndex = 0;
    this.pathDest = new THREE.Vector3(1e9, 0, 0);
    this.repathTimer = 0;
    this.goal = null;
    this.goalTimer = 0;

    this.match = null;          // set by the Match, for zone awareness
    this.jumpPending = null;    // next waypoint is across a gap: jump at the takeoff
    this.airTarget = null;      // landing point while in the air on a planned jump

    // Movement style
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 0;
    this.hopTimer = 1 + Math.random() * 2;
    this.slideHold = 0;
    this.crouchHold = 0;
    this.stuckTimer = 0;

    this.buildModel(scene, COLORS[index % COLORS.length]);
  }

  buildModel(scene, bodyColor) {
    this.bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.6, metalness: 0.05 });
    this.armorMat = new THREE.MeshStandardMaterial({ color: 0x2a2c31, roughness: 0.45, metalness: 0.4 });
    this.skinMat = new THREE.MeshStandardMaterial({ color: 0x8c5e48, roughness: 0.7 });
    this.flashMats = [this.bodyMat, this.armorMat, this.skinMat];
    // Healthy colours, and the colours they shift toward as health drops
    this.healthyColors = this.flashMats.map((m) => m.color.clone());
    this.hurtColors = [new THREE.Color(0xb3120c), new THREE.Color(0x5a0c0a), new THREE.Color(0x9c2a1c)];
    this.shownHurt = -1;
    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3, 0.8) });
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.4, metalness: 0.7 });

    this.group = new THREE.Group();
    this.body = new THREE.Group(); // squashes for crouch; name tag stays upright
    this.group.add(this.body);
    const add = (geom, mat, x, y, z, parent = this.body) => {
      const m = new THREE.Mesh(geom, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    const pivot = (x, y, z) => {
      const p = new THREE.Group();
      p.position.set(x, y, z);
      this.body.add(p);
      return p;
    };

    add(new RoundedBoxGeometry(0.5, 0.62, 0.3, 4, 0.12), this.bodyMat, 0, 1.18, 0);
    add(new RoundedBoxGeometry(0.42, 0.38, 0.1, 3, 0.05), this.armorMat, 0, 1.24, 0.17);
    add(new RoundedBoxGeometry(0.4, 0.22, 0.26, 3, 0.08), this.armorMat, 0, 0.82, 0);
    const head = add(new THREE.SphereGeometry(0.17, 24, 16), this.skinMat, 0, 1.62, 0);
    head.scale.set(1, 1.1, 1);
    add(new RoundedBoxGeometry(0.4, 0.2, 0.38, 3, 0.07), this.armorMat, 0, 1.73, -0.01);
    const eyeGeom = new THREE.SphereGeometry(0.028, 8, 6);
    add(eyeGeom, eyeMat, -0.07, 1.62, 0.15).castShadow = false;
    add(eyeGeom, eyeMat, 0.07, 1.62, 0.15).castShadow = false;

    this.armL = pivot(-0.33, 1.42, 0);
    this.armR = pivot(0.33, 1.42, 0);
    add(new THREE.CapsuleGeometry(0.075, 0.42, 4, 10), this.bodyMat, 0, -0.285, 0, this.armL);
    add(new THREE.CapsuleGeometry(0.075, 0.42, 4, 10), this.bodyMat, 0, -0.285, 0, this.armR);

    // Handgun in the right hand, barrel along the arm
    add(new RoundedBoxGeometry(0.05, 0.22, 0.08, 2, 0.015), gunMat, 0, -0.64, 0.04, this.armR);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, -0.77, 0.04);
    this.armR.add(this.muzzle);
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 4, 1.5) }),
    );
    this.flash.visible = false;
    this.muzzle.add(this.flash);
    this.flashTimer = 0;

    this.legL = pivot(-0.13, 0.82, 0);
    this.legR = pivot(0.13, 0.82, 0);
    add(new THREE.CapsuleGeometry(0.09, 0.6, 4, 10), this.armorMat, 0, -0.39, 0, this.legL);
    add(new THREE.CapsuleGeometry(0.09, 0.6, 4, 10), this.armorMat, 0, -0.39, 0, this.legR);

    this.tag = makeNameTag(this.name);
    this.tag.position.y = 2.15;
    this.group.add(this.tag);

    // Health bar under the name tag, redrawn only when the value changes
    this.barCanvas = document.createElement('canvas');
    this.barCanvas.width = 128;
    this.barCanvas.height = 16;
    this.barTex = new THREE.CanvasTexture(this.barCanvas);
    this.barTex.colorSpace = THREE.SRGBColorSpace;
    this.bar = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.barTex, transparent: true, depthWrite: false }));
    this.bar.scale.set(0.9, 0.11, 1);
    this.group.add(this.bar);
    this.shownHealth = -1;

    // Spawn shield bubble
    this.bubble = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 24, 16),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.6, 1.2, 2.4),
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      }),
    );
    this.bubble.position.y = 0.95;
    this.bubble.scale.y = 1.05;
    this.group.add(this.bubble);

    this.walkPhase = Math.random() * Math.PI * 2;
    scene.add(this.group);

    // Swap in the animated human once it has loaded; the simple model stays as a fallback
    this.bodyColor = bodyColor;
    this.human = null;
    this.mixer = null;
    this.deathTime = 0;
    this.shootAnim = 0;
    const kind = 'male';
    Promise.all([loadCharacter(kind), loadAnimations(), loadPistol()])
      .then(([g, clips, pistol]) => this.useHuman(g, clips, pistol))
      .catch((e) => console.warn('Bot model failed to load; keeping the simple model', e));
  }

  useHuman(g, clips, pistol) {
    const model = SkeletonUtils.clone(g.scene);

    // Stand it on the ground at 1.8 m. `precise` measures the skinned vertices.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true);
    const s = STAND_H / Math.max(0.01, box.max.y - box.min.y);
    model.scale.setScalar(s);
    model.position.y = -box.min.y * s;

    // Own materials per bot, lightly tinted with the bot's colour so they're easy to tell apart.
    // As health drops they shift toward red (see animate()).
    const tint = new THREE.Color(this.bodyColor).lerp(new THREE.Color(0xffffff), 0.45);
    const mats = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false; // skinned bounds don't follow the animation
      o.material = o.material.clone();
      if (!/eye/i.test(o.material.name)) o.material.color.lerp(tint, 0.55);
      mats.push(o.material);
    });
    this.flashMats = mats;
    this.healthyColors = mats.map((m) => m.color.clone());
    this.hurtColors = mats.map((m) => (/eye/i.test(m.name) ? m.color.clone() : new THREE.Color(0xff2a1c)));
    this.shownHurt = -1;

    for (const c of this.body.children) c.visible = false;
    this.body.add(model);
    this.human = model;

    // Animations
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    for (const clip of clips) this.actions[clip.name] = this.mixer.clipAction(clip);
    for (const name of ONE_SHOT_ANIMS) {
      const a = this.actions[name];
      if (a) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
    }

    // Pistol in the right hand. Pose the aim animation once and fit the gun so it
    // points where the character faces in that pose; it then follows the hand.
    const hand = model.getObjectByName('hand_r');
    const fingers = model.getObjectByName('middle_01_r');
    if (hand) {
      const aim = this.actions.Pistol_Aim_Neutral;
      if (aim) {
        aim.play();
        this.mixer.update(0);
      }
      model.updateMatrixWorld(true);

      const ws = new THREE.Vector3();
      hand.getWorldScale(ws);
      const holder = new THREE.Group();          // undoes the bone's scale: inside it, units are metres
      holder.scale.setScalar(1 / Math.max(1e-6, ws.x));
      if (fingers) holder.position.copy(fingers.position).multiplyScalar(0.55); // palm centre

      const handQ = hand.getWorldQuaternion(new THREE.Quaternion());
      const facing = model.getWorldQuaternion(new THREE.Quaternion())
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)); // gun -Z -> model +Z
      holder.quaternion.copy(handQ.invert().multiply(facing));

      const { object, muzzle } = normalizeGun(pistol, 0.2);
      holder.add(object);
      hand.add(holder);
      this.gunHolder = holder;
      this.heldModels.pistol = { object, muzzle };
      const m = new THREE.Object3D();
      this.flash.removeFromParent();
      m.add(this.flash);
      this.muzzle = m;
      this.showHeldGun();

      if (aim) aim.stop();
    }

    this.currentAnim = null;
    this.playAnim('Pistol_Idle_Loop');
  }

  // Swap the gun this bot holds (fresh magazine, usable at once)
  equipGun(spec) {
    this.gun = new GunState(spec, this, { infiniteReserve: true });
    this.showHeldGun();
  }

  showHeldGun() {
    if (!this.gunHolder) return;
    const kind = this.gun.spec.model;
    let entry = this.heldModels[kind];
    if (!entry) {
      entry = buildGunModel(this.gun.spec);
      entry.object.scale.setScalar(0.85);
      this.gunHolder.add(entry.object);
      this.heldModels[kind] = entry;
    }
    for (const [k, e] of Object.entries(this.heldModels)) e.object.visible = k === kind;
    this.muzzle.removeFromParent();
    this.muzzle.position.copy(entry.muzzle); // in the gun's own (unscaled) space
    entry.object.add(this.muzzle);
  }

  playAnim(name, fade = 0.15) {
    if (!this.mixer || this.currentAnim === name) return;
    const next = this.actions[name];
    if (!next) return;
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade).play();
    if (this.currentAction) this.currentAction.fadeOut(fade);
    this.currentAction = next;
    this.currentAnim = name;
  }

  // Pick the animation from what the character is doing
  animateHuman(dt) {
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    let name;
    if (this.dead) name = 'Death01';
    else if (this.sliding) name = 'Crouch_Idle_Loop';
    else if (this.state === 'crouch') name = hs > 0.6 ? 'Crouch_Fwd_Loop' : 'Crouch_Idle_Loop';
    else if (!this.onGround) name = 'Jump_Loop';
    else if (hs > 8) name = 'Sprint_Loop';
    else if (hs > 4.5) name = 'Jog_Fwd_Loop';
    else if (hs > 0.6) name = 'Walk_Loop';
    else if (this.gun.reloadTimer > 0) name = 'Pistol_Reload';
    else if (this.shootAnim > 0) name = 'Pistol_Shoot';
    else if (this.target && this.targetVisible) name = 'Pistol_Aim_Neutral';
    else name = 'Pistol_Idle_Loop';
    this.playAnim(name, name === 'Death01' ? 0.08 : 0.15);

    const a = this.currentAction;
    if (a) {
      if (name === 'Sprint_Loop') a.setEffectiveTimeScale(hs / 10);
      else if (name === 'Jog_Fwd_Loop') a.setEffectiveTimeScale(hs / 6);
      else if (name === 'Walk_Loop') a.setEffectiveTimeScale(Math.max(0.6, hs / 2.5));
      else if (name === 'Crouch_Fwd_Loop') a.setEffectiveTimeScale(Math.max(0.6, hs / 2.5));
    }
    this.mixer.update(dt);
  }

  // Getting shot reveals the shooter
  takeDamage(amount, attacker = null) {
    const killed = super.takeDamage(amount, attacker);
    if (!killed && attacker && attacker !== this) {
      if (!this.target || !this.targetVisible) {
        this.target = attacker;
        this.lastKnown.copy(attacker.position);
        this.timeSinceSeen = 0;
      }
    }
    return killed;
  }

  // `fixed` keeps the spawn the match assigned; otherwise pick a random one
  respawn(fixed = false) {
    if (!fixed) this.spawn.copy(this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)]);
    super.respawn();
    this.equipGun(HANDGUN);
    this.boxTarget = null;
    this.target = null;
    this.targetVisible = false;
    this.path = [];
    this.goal = null;
    this.jumpPending = null;
    this.airTarget = null;
  }

  // ---------- Perception ----------
  perceive() {
    const eye = this.eye();
    let best = null;
    // Keep tracking a current target out to full sight range; new fights start closer
    let bestD = this.target ? SIGHT_RANGE : ENGAGE_RANGE;
    for (const c of this.world.combatants) {
      if (c === this || c.dead || c.shielded) continue; // no point shooting a spawn shield
      const ce = c.eye();
      const d = eye.distanceTo(ce);
      if (d > bestD) continue;
      const chest = c.position.clone();
      chest.y += c.height * 0.6;
      if (!this.world.lineOfSight(eye, ce) && !this.world.lineOfSight(eye, chest)) continue;
      // Stay on the current target if it is still visible and not much farther
      if (c === this.target) { best = c; bestD = d + 4; continue; }
      best = c;
      bestD = d;
    }

    if (best) {
      if (best !== this.target || !this.targetVisible) {
        this.reaction = REACTION_MIN + Math.random() * REACTION_RAND;
        this.trackTime = 0;
        this.aimHead = Math.random() < HEAD_AIM_CHANCE;
      }
      this.target = best;
      this.targetVisible = true;
      this.timeSinceSeen = 0;
      this.lastKnown.copy(best.position);
    } else {
      this.targetVisible = false;
    }
  }

  // ---------- Navigation ----------
  // Direction (x, z) to walk toward `dest`, following the nav graph across levels
  followPath(dest, dt) {
    this.repathTimer -= dt;
    if (this.repathTimer <= 0 || this.pathDest.distanceTo(dest) > 3) {
      this.path = this.nav.findPath(this.position, dest);
      this.pathIndex = 0;
      this.repathTimer = REPATH_INTERVAL;
      this.pathDest.copy(dest);
    }

    const p = this.position;
    while (this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      const h = Math.hypot(wp.x - p.x, wp.z - p.z);
      if (h < WAYPOINT_REACH && Math.abs(wp.y - p.y) < 1.2) {
        this.pathIndex++;
        // Standing at a takeoff point: the next stretch is a jump across a gap
        const next = this.path[this.pathIndex];
        if (next && next.jump) this.jumpPending = next;
      } else {
        break;
      }
    }

    let wp = this.path[this.pathIndex];
    if (!wp) wp = dest;
    // Fell off the route (but not while doing a planned drop)
    if (p.y < wp.y - 1.5 && this.onGround && !this.airTarget) this.repathTimer = 0;
    if (wp.jump) return this.dirTo(wp); // keep heading straight for the landing

    const dx = wp.x - p.x;
    const dz = wp.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.3) return null;

    // Long straight stretch ahead on the ground: sometimes slide, like a player would
    if (len > 7 && this.onGround && this.slideHold <= 0 && Math.random() < 0.6 * dt) {
      this.slideHold = 0.7;
    }
    return [dx / len, dz / len];
  }

  dirTo(wp) {
    const dx = wp.x - this.position.x;
    const dz = wp.z - this.position.z;
    const len = Math.hypot(dx, dz);
    return len < 0.05 ? null : [dx / len, dz / len];
  }

  zoneLive() {
    return this.match && this.match.state === 'live';
  }

  // Only a handgun: go roll a mystery box if a ready one is close and inside the zone
  pickBox(m) {
    if (!this.boxes || this.gun.spec !== HANDGUN || Math.random() > BOX_SEEK_CHANCE) return false;
    let best = null;
    let bestD = BOX_SEEK_RANGE;
    for (const b of this.boxes.active()) {
      if (!b.ready || (m && !m.insideNext(b.position))) continue;
      const d = b.position.distanceTo(this.position);
      if (d < bestD) { best = b; bestD = d; }
    }
    if (!best) return false;
    // Stand in front of the box (its local +Z side)
    const front = new THREE.Vector3(0, 0, 1.1).applyQuaternion(best.group.quaternion);
    this.goal = best.position.clone().add(front);
    this.boxTarget = best;
    this.goalTimer = 12;
    return true;
  }

  pickGoal() {
    const m = this.zoneLive() ? this.match : null;
    this.boxTarget = null;
    if (this.pickBox(m)) return;
    const others = this.world.combatants.filter((c) => c !== this && !c.dead && (!m || m.insideNext(c.position)));
    if (others.length && Math.random() < HUNT_CHANCE) {
      let near = others[0];
      for (const c of others) {
        if (c.position.distanceTo(this.position) < near.position.distanceTo(this.position)) near = c;
      }
      this.goal = near.position.clone();
    } else {
      // Roam somewhere inside the zone the circle is heading to
      this.goal = null;
      for (let i = 0; i < 25 && !this.goal; i++) {
        const n = this.nav.randomNode();
        if (!m || m.insideNext(n)) this.goal = n.clone();
      }
      if (!this.goal) this.goal = m ? m.centre() : this.nav.randomNode().clone();
    }
    this.goalTimer = GOAL_TIME_MIN + Math.random() * GOAL_TIME_RAND;
  }

  // ---------- Main AI ----------
  think(dt) {
    this.perceptionTimer -= dt;
    if (this.perceptionTimer <= 0) {
      this.perceptionTimer = PERCEPTION_INTERVAL;
      this.perceive();
    }
    if (this.target && (this.target.dead || this.target.shielded)) {
      this.target = null;
      this.targetVisible = false;
    }
    if (this.target && !this.targetVisible) {
      this.timeSinceSeen += dt;
      if (this.timeSinceSeen > FORGET_TIME) this.target = null;
    }

    const input = { forward: 0, strafe: 0, sprint: true, crouch: false, jump: false };
    let move = null;
    const t = this.target;

    // --- Aim ---
    let wantYaw = this.yaw;
    let wantPitch = 0;
    if (t && this.targetVisible) {
      this.trackTime += dt;
      this.reaction -= dt;
      this.noiseTimer -= dt;
      if (this.noiseTimer <= 0) {
        this.noiseTimer = 0.25;
        this.noiseYaw = Math.random() * 2 - 1;
        this.noisePitch = Math.random() * 2 - 1;
      }
      const aimY = this.aimHead ? t.height - 0.2 : t.height * 0.6;
      const e = this.eye();
      _to.set(t.position.x - e.x, t.position.y + aimY - e.y, t.position.z - e.z);
      const flat = Math.hypot(_to.x, _to.z);
      const noise = AIM_NOISE * Math.max(MIN_NOISE, 1 - this.trackTime / AIM_SETTLE);
      wantYaw = Math.atan2(-_to.x, -_to.z) + this.noiseYaw * noise;
      wantPitch = Math.atan2(_to.y, flat) + this.noisePitch * noise;
    } else if (t) {
      const e = this.eye();
      wantYaw = Math.atan2(-(this.lastKnown.x - e.x), -(this.lastKnown.z - e.z));
    } else if (Math.hypot(this.velocity.x, this.velocity.z) > 1) {
      wantYaw = Math.atan2(-this.velocity.x, -this.velocity.z);
    }
    this.yaw = approach(this.yaw, wantYaw, TURN_RATE * dt);
    this.pitch += Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, wantPitch - this.pitch));

    // --- Shoot ---
    this.shotGap -= dt;
    this.stopTimer -= dt;
    if (t && this.targetVisible && this.reaction <= 0) {
      this.aimDir(_aim);
      const e = this.eye();
      _to.set(t.position.x - e.x, t.position.y + t.height * 0.6 - e.y, t.position.z - e.z).normalize();
      const err = Math.acos(Math.min(1, _aim.dot(_to)));
      const spec = this.gun.spec;
      // A sniper waits for a steadier aim before taking its one big shot
      const cone = spec.scope ? FIRE_CONE * 0.35 : FIRE_CONE;
      const settled = !spec.scope || this.trackTime > 0.8;
      if (err < cone && settled && this.shotGap <= 0 && this.gun.canFire()) {
        const r = this.gun.fire(this.world, e, _aim);
        if (r.fired) {
          this.muzzle.getWorldPosition(_muzzle);
          this.world.addTracer(_muzzle, r.end);
          this.flashTimer = 0.05;
          // Automatic weapons fire in bursts; others keep a human-ish gap between shots
          if (spec.auto) this.shotGap = Math.random() < BURST_PAUSE_CHANCE ? 0.25 + Math.random() * 0.3 : 0;
          else this.shotGap = SHOT_GAP_MIN + Math.random() * SHOT_GAP_RAND;
          this.stopTimer = STOP_TO_SHOOT;
          this.shootAnim = 0.3;
        }
      }
      if (this.gun.ammo === 0) this.gun.reload();
    } else if (!this.targetVisible && this.gun.ammo < this.gun.magSize / 2) {
      this.gun.reload(); // reload while nobody is in sight
    }

    // --- Move ---
    // Outside (or at the edge of) the safe zone: getting back in comes first
    const outside = this.zoneLive() && !this.match.inside(this.position, 2);
    if (outside) {
      move = this.followPath(this.match.centre(), dt);
      input.sprint = true;
    } else if (t && this.targetVisible) {
      const dx = t.position.x - this.position.x;
      const dz = t.position.z - this.position.z;
      const d = Math.hypot(dx, dz) || 1;
      const tx = dx / d;
      const tz = dz / d;
      const sameLevel = Math.abs(t.position.y - this.position.y) < 1.5;

      if (d > PREF_MAX) {
        move = sameLevel ? [tx, tz] : this.followPath(t.position, dt);
      } else if (d < PREF_MIN) {
        move = [-tx, -tz];
      }

      // Strafe side to side, flipping direction every so often
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        this.strafeTimer = 0.35 + Math.random() * 0.8;
      }
      const sx = -tz * this.strafeDir;
      const sz = tx * this.strafeDir;
      if (move) {
        const mx = move[0] + sx * 0.7;
        const mz = move[1] + sz * 0.7;
        const ml = Math.hypot(mx, mz) || 1;
        move = [mx / ml, mz / ml];
      } else {
        move = [sx, sz];
      }
      input.sprint = d > PREF_MAX;

      // Stop briefly when shooting, then keep moving
      if (this.stopTimer > 0) move = null;

      // Jump around in fights, sometimes crouch
      this.hopTimer -= dt;
      if (this.hopTimer <= 0 && this.onGround) {
        input.jump = true;
        this.hopTimer = 1.2 + Math.random() * 2.5;
      }
      if (this.crouchHold <= 0 && Math.random() < 0.15 * dt) this.crouchHold = 0.5 + Math.random() * 0.6;
    } else {
      // Not fighting: chase the last known position, or roam toward a goal
      let dest;
      if (t) {
        dest = this.lastKnown;
      } else {
        // At the box: use it
        const bt = this.boxTarget;
        if (bt) {
          if (!bt.ready || !bt.group.visible) {
            this.boxTarget = null;
            this.goal = null;
          } else if (this.boxes.inReach(this) === bt) {
            bt.spin(this, (spec) => { if (!this.dead) this.equipGun(spec); });
            this.boxTarget = null;
            this.goal = null;
          }
        }
        this.goalTimer -= dt;
        if (!this.goal || this.goalTimer <= 0 ||
            Math.hypot(this.goal.x - this.position.x, this.goal.z - this.position.z) < 1.5 ||
            (this.zoneLive() && !this.match.insideNext(this.goal))) {
          this.pickGoal();
        }
        dest = this.goal;
      }
      move = this.followPath(dest, dt);

      // Hop now and then while running around
      this.hopTimer -= dt;
      if (this.hopTimer <= 0 && this.onGround && this.slideHold <= 0 && !this.jumpPending) {
        input.jump = true;
        this.hopTimer = 2.5 + Math.random() * 3;
      }
    }

    // Planned jump across a gap: jump at the takeoff, double jump if coming up short
    if (this.jumpPending && this.onGround) {
      input.jump = true;
      input.sprint = true;
      this.airTarget = this.jumpPending;
      this.jumpPending = null;
      this.slideHold = 0;
      const d = this.dirTo(this.airTarget);
      if (d) move = d;
    } else if (this.airTarget) {
      if (this.onGround) {
        this.airTarget = null;
      } else {
        input.sprint = true;
        const h = Math.hypot(this.airTarget.x - this.position.x, this.airTarget.z - this.position.z);
        if (this.velocity.y < 0 && this.position.y < this.airTarget.y + 0.8 && h > 1.0 && this.canDouble) {
          input.jump = true;
        }
        const d = this.dirTo(this.airTarget);
        if (d) move = d;
      }
    }

    // Slide: hold crouch while sprinting, and often finish with a slide-jump
    if (this.slideHold > 0) {
      this.slideHold -= dt;
      input.crouch = true;
      input.sprint = true;
      if (this.slideHold <= 0.08 && this.sliding && Math.random() < 0.5) input.jump = true;
    }
    if (this.crouchHold > 0) {
      this.crouchHold -= dt;
      input.crouch = true;
      input.sprint = false;
    }

    // Kick off walls when one is touched mid-air (not during a planned gap jump)
    if (this.state === 'wall' && !this.airTarget && Math.random() < 3 * dt) input.jump = true;

    // Stuck against something: hop over it, then give up on the route
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    if (move && hs < 0.8 && this.onGround) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.5) input.jump = true;
      if (this.stuckTimer > 1.6) {
        this.stuckTimer = 0;
        this.repathTimer = 0;
        if (!t) this.goal = null;
      }
    } else {
      this.stuckTimer = 0;
    }

    // World direction -> forward/strafe relative to where the bot is looking
    if (move) {
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      input.forward = -sin * move[0] - cos * move[1];
      input.strafe = cos * move[0] - sin * move[1];
    }
    return input;
  }

  drawHealthBar() {
    const hp = Math.ceil(this.health);
    if (hp === this.shownHealth) return;
    this.shownHealth = hp;
    const ctx = this.barCanvas.getContext('2d');
    const w = this.barCanvas.width;
    const h = this.barCanvas.height;
    const f = Math.max(0, Math.min(1, this.health / this.maxHealth));
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = f > 0.6 ? '#5fd35a' : f > 0.3 ? '#e6c33a' : '#e2452f';
    ctx.fillRect(2, 2, (w - 4) * f, h - 4);
    this.barTex.needsUpdate = true;
  }

  update(dt) {
    this.preUpdate(dt);
    this.gun.update(dt);
    this.shootAnim = Math.max(0, this.shootAnim - dt);
    if (this.tickDead(dt)) {
      // With the robot, play the death animation briefly before the body disappears
      this.deathTime += dt;
      const show = this.mixer && this.deathTime < DEATH_SHOW;
      this.group.visible = show;
      if (show) {
        this.tag.visible = false;
        this.bar.visible = false;
        this.bubble.visible = false;
        this.animateHuman(dt);
      }
      return;
    }
    this.deathTime = 0;
    this.group.visible = true;
    this.tag.visible = true;
    this.bar.visible = true;
    if (this.frozen) {
      this.simulate(dt, NO_INPUT);
    } else {
      this.simulate(dt, this.think(dt));
    }
    this.animate(dt);
  }

  animate(dt) {
    this.group.position.copy(this.position);
    this.group.rotation.y = this.yaw + Math.PI; // model faces +z, yaw 0 looks along -z
    this.body.scale.y = this.height / STAND_H;
    this.tag.position.y = this.height + 0.38;
    this.bar.position.y = this.height + 0.2;

    // Skin colour follows damage taken: healthy colours -> deep red as health drops
    const hurt = 1 - this.health / this.maxHealth;
    if (Math.abs(hurt - this.shownHurt) > 0.005) {
      this.shownHurt = hurt;
      const k = Math.pow(hurt, 0.8);
      this.flashMats.forEach((m, i) => m.color.copy(this.healthyColors[i]).lerp(this.hurtColors[i], k));
    }
    // Each hit flashes in proportion to its damage (a headshot flashes hardest)
    const flash = Math.min(1, this.damageFlash / 0.35) * (0.25 + this.hitStrength * 1.1);
    for (const m of this.flashMats) m.emissive.setRGB(flash, flash * 0.15, 0);

    this.drawHealthBar();

    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    const moving = this.onGround && !this.sliding ? Math.min(1, hs / 7) : 0;
    this.walkPhase += dt * (3 + hs * 0.9);
    const s = Math.sin(this.walkPhase) * moving * 0.55;
    this.legL.rotation.x = s;
    this.legR.rotation.x = -s;
    this.armL.rotation.x = -s * 0.7;
    // Gun arm points where the bot aims while it has a target
    this.armR.rotation.x = this.target ? -Math.PI / 2 - this.pitch : s * 0.7;

    this.flashTimer -= dt;
    this.flash.visible = this.flashTimer > 0;
    if (this.mixer) this.animateHuman(dt);

    // Shield bubble pulses, and blinks in the last two seconds
    this.bubble.visible = this.shielded && (this.shieldTimer > 2 || Math.floor(this.shieldTimer * 6) % 2 === 0);
    this.bubble.material.opacity = 0.14 + Math.sin(performance.now() / 180) * 0.04;
  }
}

export class Bots {
  constructor(scene, world, nav, spawnPoints, count = 4, boxes = null) {
    this.list = [];
    for (let i = 0; i < count; i++) {
      const b = new Bot(scene, world, nav, spawnPoints[i % spawnPoints.length], i, spawnPoints);
      b.boxes = boxes;
      this.list.push(b);
    }
    for (const b of this.list) world.add(b);
  }

  update(dt) {
    for (const b of this.list) b.update(dt);
  }

  aliveCount() {
    return this.list.filter((b) => !b.dead).length;
  }
}
