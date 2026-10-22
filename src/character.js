import * as THREE from 'three';
import { nearbyBoxes } from './physics.js';

// Shared movement and health for anything that plays: the local player, bots,
// and later network players. Input comes in as a plain object each frame, so the
// same simulation runs no matter where the input comes from.
// Units are metres, time in seconds.

export const HALF_W = 0.35;     // half width of the collision box
export const STAND_H = 1.8;     // collision height standing
export const CROUCH_H = 1.0;    // collision height crouched / sliding
const EYE_BELOW_TOP = 0.2;      // eyes sit this far below the top of the box

const GRAVITY = 30;
const JUMP_VEL = 9.5;           // ~1.5 m jump
const DOUBLE_JUMP_VEL = 8.5;    // ~1.2 m extra
const WALK_SPEED = 7;
const SPRINT_SPEED = 10;
const CROUCH_SPEED = 3.3;       // Apex: crouch-walk is a bit under half of walking
const ADS_SPEED = 0.62;         // walking speed factor while aiming down sights (no sprint)
const GROUND_ACCEL = 60;
const OVERSPEED_FRICTION = 4;   // above run speed on the ground, extra speed bleeds off at this rate
const AIR_ACCEL = 4;            // Quake/Apex air control: steer and strafe, no air friction
const AIR_WISH_CAP = 1.2;       // how much speed air strafing can add per push
const LURCH_TIME = 0.2;         // just after takeoff a direction change redirects your momentum
const LURCH_ACCEL = 30;
const BHOP_GRACE = 0.1;         // landing grace: jump again within it and keep your speed
const MAX_HSPEED = 18;
const LAND_SHOCK_SPEED = 17;    // landing faster than this (a fall of ~5 m) briefly slows you
// Wall climb (hold jump facing a wall), mantle onto ledges, superglide
const CLIMB_SPEED = 5;
const CLIMB_TIME = 1.2;         // about 6 m
const MANTLE_REACH = 1.95;      // a ledge up to this far above your feet can be mantled
const MANTLE_TIME = 0.32;
const SUPERGLIDE_SPEED = 16;
const SUPERGLIDE_WINDOW = 0.12; // jump and crouch together near the top of a mantle
const STEP_HEIGHT = 0.55;       // auto step-up height
const PHYSICS_STEP = 1 / 120;
const MAX_HEALTH = 200;
export const SPAWN_SHIELD = 10;  // seconds of invulnerability after spawning
const REGEN_DELAY = 4;           // seconds without taking damage before health regenerates
const REGEN_RATE = 8;            // health per second

// Slide (sprint + crouch on the ground)
const SLIDE_MIN_SPEED = 6.5;
const SLIDE_START_SPEED = 11.5; // a sprinting slide starts with a boost (once every 2 s)
const SLIDE_BOOST_COOLDOWN = 2;
const SLIDE_GLIDE_TIME = 0.9;   // about a second of nearly free gliding before friction bites
const SLIDE_FRICTION_EARLY = 0.35;
const SLIDE_FRICTION = 2.2;
const SLIDE_END_SPEED = 2.5;
const SLIDE_MAX_TIME = 2.2;
const SLIDE_COOLDOWN = 0.2;
const SLIDE_JUMP_BOOST = 1.12;

// Wall jump and wall slide
const WALL_PROBE = 0.08;
const WALL_STICK = 0.18;
const WALL_JUMP_UP = 9.0;
const WALL_JUMP_OUT = 8.5;
const WALL_JUMP_COOLDOWN = 0.2;
const WALL_SLIDE_MAX = 3.0;

const WALL_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Empty input, for frames where nothing is pressed
// jumpHeld and crouchPressed are optional (the player sends them; bots don't climb)
export const NO_INPUT = Object.freeze({ forward: 0, strafe: 0, sprint: false, crouch: false, jump: false, jumpHeld: false, crouchPressed: false });

export class Character {
  constructor(colliders, spawn, name = 'player') {
    this.colliders = colliders;
    this.name = name;
    this.spawn = spawn.clone();

    this.position = spawn.clone(); // feet
    this.stepOffset = 0;           // eye lag after an auto step-up, eased back to 0
    this.velocity = new THREE.Vector3();
    this.yaw = 0;                  // look direction; yaw 0 faces -z
    this.pitch = 0;
    this.onGround = false;
    this.canDouble = true;

    this.height = STAND_H;
    this.eyeOff = STAND_H - EYE_BELOW_TOP;
    this.sliding = false;
    this.slideTime = 0;
    this.slideCooldown = 0;

    this.wallNormal = new THREE.Vector3();
    this.wallTimer = 0;
    this.wallCooldown = 0;
    this.wallBox = null;       // wall currently touched
    this.lastWallBox = null;   // wall last kicked off; can't reuse it until landing

    this.state = 'air';

    this.maxHealth = MAX_HEALTH;
    this.health = MAX_HEALTH;
    this.dead = false;
    this.respawnTime = 2.5;
    this.respawnTimer = 0;
    this.damageFlash = 0;
    this.kills = 0;
    this.deaths = 0;
    this.lastAttacker = null;

    this.frozen = false;      // no movement input (match countdown)
    this.canRespawn = true;   // off during a battle royale match
    this.shieldTimer = SPAWN_SHIELD;
    this.sinceDamage = 0;
    this.hitStrength = 0;
    this.ads = false;         // looking down a scope: scoped guns are accurate only then
    this.aiming = false;      // aiming down sights (player): tighter spread, slower walk
    this.speedMult = 1;       // knife out (weapon holstered): a little faster, like Apex

    this.simTime = 0;
    this.airTime = 0;         // seconds since leaving the ground
    this.landGrace = 0;       // bunny-hop window after landing
    this.landShock = 0;       // slowdown after a long fall
    this.slideBoostCooldown = 0;
    this.climb = null;        // { t } while climbing a wall
    this.climbUsed = false;   // one climb per jump; resets on the ground
    this.mantle = null;       // { t, from, to, ... } while pulling up onto a ledge
    this.lastJumpAt = -9;
    this.lastCrouchAt = -9;
  }

  get shielded() {
    return this.shieldTimer > 0;
  }

  // Firing your own weapon ends spawn protection early
  dropShield() {
    this.shieldTimer = 0;
  }

  eye() {
    return new THREE.Vector3(this.position.x, this.position.y + this.eyeOff, this.position.z);
  }

  // Unit vector of where this character is looking
  aimDir(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  hitBox() {
    const p = this.position;
    return new THREE.Box3(
      new THREE.Vector3(p.x - HALF_W, p.y, p.z - HALF_W),
      new THREE.Vector3(p.x + HALF_W, p.y + this.height, p.z + HALF_W),
    );
  }

  // Returns true if this damage killed the character.
  // The spawn shield blocks everything except `bypassShield` (falling out of the map).
  takeDamage(amount, attacker = null, bypassShield = false) {
    if (this.dead) return false;
    if (this.shielded && !bypassShield) return false;
    const dealt = Math.min(this.health, amount);
    this.health = Math.max(0, this.health - amount);
    // Stats hooks (see stats.js)
    if (this.onDamaged) this.onDamaged(dealt, attacker);
    if (attacker && attacker.onDealt) attacker.onDealt(dealt, this);
    this.damageFlash = 0.35;
    this.hitStrength = Math.min(1, amount / 60); // a headshot (62.5) is a full-strength hit
    this.lastAttacker = attacker;
    this.sinceDamage = 0;
    if (this.health <= 0) {
      this.dead = true;
      this.respawnTimer = this.respawnTime;
      this.deaths++;
      return true;
    }
    return false;
  }

  respawn() {
    this.position.copy(this.spawn);
    this.stepOffset = 0;
    this.velocity.set(0, 0, 0);
    this.health = this.maxHealth;
    this.dead = false;
    this.canDouble = true;
    this.sliding = false;
    this.slideCooldown = 0;
    this.wallTimer = 0;
    this.wallBox = null;
    this.lastWallBox = null;
    this.climb = null;
    this.mantle = null;
    this.landShock = 0;
    this.height = STAND_H;
    this.eyeOff = STAND_H - EYE_BELOW_TOP;
    this.shieldTimer = SPAWN_SHIELD;
    this.sinceDamage = 0;
    this.hitStrength = 0;
    if (this.onRespawn) this.onRespawn(); // e.g. refill weapons
  }

  // Timers that run every frame, alive or dead
  preUpdate(dt) {
    this.damageFlash = Math.max(0, this.damageFlash - dt);
    // The shield only counts down while you can actually move
    if (!this.frozen && !this.dead) this.shieldTimer = Math.max(0, this.shieldTimer - dt);
    // Out of combat for a few seconds: health comes back
    this.sinceDamage += dt;
    if (!this.dead && this.sinceDamage > REGEN_DELAY && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + REGEN_RATE * dt);
    }
  }

  // Counts down the respawn while dead. Returns true while still dead.
  tickDead(dt) {
    if (!this.dead) return false;
    this.velocity.set(0, 0, 0);
    this.respawnTimer -= dt;
    this.state = 'dead';
    if (this.respawnTimer <= 0 && this.canRespawn) this.respawn();
    return this.dead;
  }

  startSlide(hs) {
    this.sliding = true;
    this.slideTime = 0;
    // Sprint-slides get a boost; chaining slides (slide hopping) keeps speed but no more boost
    if (this.slideBoostCooldown <= 0 && hs < SLIDE_START_SPEED) {
      const boost = SLIDE_START_SPEED / Math.max(hs, 1e-3);
      this.velocity.x *= boost;
      this.velocity.z *= boost;
      this.slideBoostCooldown = SLIDE_BOOST_COOLDOWN;
    }
  }

  endSlide() {
    if (!this.sliding) return;
    this.sliding = false;
    this.slideCooldown = SLIDE_COOLDOWN;
  }

  // input: { forward -1..1, strafe -1..1, sprint, crouch, jump (true on the frame it is pressed) }
  // The boxes this character could touch this frame (from the colliders' grid), so
  // collision doesn't test every box on a big map
  gatherNear(dt) {
    const p = this.position;
    const r = HALF_W + WALL_PROBE + 1.5 + Math.hypot(this.velocity.x, this.velocity.z) * dt;
    this.near = nearbyBoxes(this.colliders, p.x - r, p.z - r, p.x + r, p.z + r, this.nearBuf || (this.nearBuf = []));
  }

  simulate(dt, input) {
    this.gatherNear(dt);
    this.simTime += dt;
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    this.slideBoostCooldown = Math.max(0, this.slideBoostCooldown - dt);
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);
    this.wallTimer = Math.max(0, this.wallTimer - dt);
    this.landGrace = Math.max(0, this.landGrace - dt);
    this.landShock = Math.max(0, this.landShock - dt);
    if (input.jump) this.lastJumpAt = this.simTime;
    if (input.crouchPressed) this.lastCrouchAt = this.simTime;

    // Facing on the ground plane, and the wish direction relative to it
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    let wx = fx * input.forward + -fz * input.strafe;
    let wz = fz * input.forward + fx * input.strafe;
    const len = Math.hypot(wx, wz);
    if (len > 0) { wx /= len; wz /= len; }

    // Pulling up onto a ledge: scripted, ends in a step forward, a jump or a superglide
    if (this.mantle) {
      this.updateMantle(dt, input, fx, fz);
      this.finishStep(dt);
      return;
    }

    // Target speed for the stance. Aiming stops sprinting; crouch-walking is slow; the
    // knife (weapon away) is a little faster; a hard landing slows you for a moment.
    let speed = input.sprint ? SPRINT_SPEED : WALK_SPEED;
    if (this.aiming) speed = WALK_SPEED * ADS_SPEED;
    if (input.crouch && this.onGround && !this.sliding) speed = Math.min(speed, CROUCH_SPEED);
    speed *= this.speedMult;
    if (this.landShock > 0) speed *= 0.45;

    const vel = this.velocity;
    let hs = Math.hypot(vel.x, vel.z);
    // Slide: crouch while moving fast on the ground (aiming doesn't prevent it)
    if (input.crouch && this.onGround && !this.sliding && this.slideCooldown <= 0 && hs >= SLIDE_MIN_SPEED) {
      this.startSlide(hs);
      hs = Math.hypot(vel.x, vel.z);
    }

    if (this.climb) {
      this.updateClimb(dt, input, fx, fz);
    } else if (this.sliding) {
      // About a second of near-free glide, then friction; steering is gentle
      const f = this.slideTime < SLIDE_GLIDE_TIME ? SLIDE_FRICTION_EARLY : SLIDE_FRICTION;
      const decay = Math.exp(-f * dt);
      vel.x *= decay;
      vel.z *= decay;
      if (len > 0) {
        const steer = 1 - Math.exp(-2.5 * dt);
        const sp = Math.hypot(vel.x, vel.z);
        vel.x += (wx * sp - vel.x) * steer;
        vel.z += (wz * sp - vel.z) * steer;
      }
      this.slideTime += dt;
      if (hs < SLIDE_END_SPEED || this.slideTime > SLIDE_MAX_TIME || !this.onGround || !input.crouch) this.endSlide();
    } else if (this.onGround && this.landGrace <= 0) {
      if (hs > speed + 0.3) {
        // Faster than you can run (after a slide or a hop): friction bleeds the extra off
        // over a moment instead of all at once, while you steer
        const target = len > 0 ? speed : 0;
        const keep = target + (hs - target) * Math.exp(-OVERSPEED_FRICTION * (len > 0 ? 1 : 2) * dt);
        const k = len > 0 ? 1 - Math.exp(-10 * dt) : 0;
        const nx = vel.x / hs + (wx - vel.x / hs) * k;
        const nz = vel.z / hs + (wz - vel.z / hs) * k;
        const nl = Math.hypot(nx, nz) || 1;
        vel.x = (nx / nl) * keep;
        vel.z = (nz / nl) * keep;
      } else {
        const k = 1 - Math.exp(-GROUND_ACCEL * dt);
        vel.x += (wx * speed - vel.x) * k;
        vel.z += (wz * speed - vel.z) * k;
      }
    } else if (len > 0) {
      this.airAccelerate(dt, wx, wz, speed, hs);
    }

    if (input.jump) this.jumpPressed(input, fx, fz);

    // Hold jump facing a wall in the air: climb it (Apex)
    if (!this.climb && !this.onGround && input.jumpHeld && input.forward > 0 && !this.climbUsed &&
        vel.y < CLIMB_SPEED + 1 && this.wallAhead(fx, fz)) {
      this.climb = { t: 0 };
      this.climbUsed = true;
    }
    // A ledge in front within reach while in the air: mantle up onto it
    if (!this.onGround && input.forward > 0 && vel.y < 4) {
      const ledge = this.findLedge(fx, fz);
      if (ledge) this.startMantle(ledge, fx, fz);
    }

    // Stance: low while sliding or crouching; stays low under a ceiling
    if (this.sliding || input.crouch) this.height = CROUCH_H;
    else if (this.canStand()) this.height = STAND_H;

    // Speed cap, so chained tricks stay sane
    const h2 = Math.hypot(vel.x, vel.z);
    if (h2 > MAX_HSPEED) { vel.x *= MAX_HSPEED / h2; vel.z *= MAX_HSPEED / h2; }

    if (!this.mantle) {
      const steps = Math.max(1, Math.ceil(dt / PHYSICS_STEP));
      const sub = dt / steps;
      for (let i = 0; i < steps; i++) this.physicsStep(sub);
    }
    this.finishStep(dt);
  }

  finishStep(dt) {
    this.airTime = this.onGround ? 0 : this.airTime + dt;
    this.updateState();
    const targetEye = this.height - EYE_BELOW_TOP;
    this.eyeOff += (targetEye - this.eyeOff) * Math.min(1, dt * 14);
  }

  // Air control the Quake/Apex way: you can steer and strafe-turn but not brake on air,
  // and nothing slows you down. Right after takeoff (the lurch window) a direction change
  // swings your momentum around without adding speed.
  airAccelerate(dt, wx, wz, speed, hs) {
    const vel = this.velocity;
    if (this.airTime < LURCH_TIME && hs > 1) {
      let nx = vel.x + wx * LURCH_ACCEL * dt;
      let nz = vel.z + wz * LURCH_ACCEL * dt;
      const nl = Math.hypot(nx, nz);
      if (nl > hs) { nx *= hs / nl; nz *= hs / nl; }
      vel.x = nx;
      vel.z = nz;
      return;
    }
    const along = vel.x * wx + vel.z * wz;
    const add = Math.min(speed, AIR_WISH_CAP) - along;
    if (add <= 0) return;
    const acc = Math.min(add, AIR_ACCEL * speed * dt);
    vel.x += wx * acc;
    vel.z += wz * acc;
  }

  jumpPressed(input, fx, fz) {
    const vel = this.velocity;
    if (this.onGround) {
      vel.y = JUMP_VEL;
      this.onGround = false;
      this.canDouble = true;
      if (this.sliding) {
        vel.x *= SLIDE_JUMP_BOOST;
        vel.z *= SLIDE_JUMP_BOOST;
        this.endSlide();
      }
    } else if (input.jumpHeld !== undefined && input.forward > 0 && !this.climbUsed && this.wallAhead(fx, fz)) {
      // Facing a wall in the air: start climbing (tap it for a wall bounce instead)
      this.climb = { t: 0 };
      this.climbUsed = true;
    } else if (this.wallTimer > 0 && this.wallCooldown <= 0 && this.wallBox !== this.lastWallBox) {
      // Wall jump. Same wall twice in a row is not allowed (no climbing a single wall),
      // alternating between two walls is.
      this.wallJump(this.wallNormal.x, this.wallNormal.z, 1);
    } else if (this.canDouble) {
      vel.y = DOUBLE_JUMP_VEL;
      this.canDouble = false;
    }
  }

  wallJump(nx, nz, strength) {
    const vel = this.velocity;
    vel.y = WALL_JUMP_UP * strength;
    vel.x = nx * WALL_JUMP_OUT * strength;
    vel.z = nz * WALL_JUMP_OUT * strength;
    this.wallTimer = 0;
    this.wallCooldown = WALL_JUMP_COOLDOWN;
    this.lastWallBox = this.wallBox;
    this.canDouble = true;
    this.climb = null;
  }

  // Climbing: up the wall at a steady speed for about 6 m while jump and forward are
  // held. Let go within a moment for a wall bounce: pushed off the wall and upward.
  updateClimb(dt, input, fx, fz) {
    const c = this.climb;
    c.t += dt;
    const vel = this.velocity;
    const wall = this.wallAhead(fx, fz);
    if (!input.jumpHeld || input.forward <= 0 || !wall || c.t > CLIMB_TIME) {
      this.climb = null;
      if (!input.jumpHeld && c.t < 0.18 && wall) this.wallJump(-fx, -fz, 1.05); // wall bounce
      else vel.y = Math.min(vel.y, 2);
      return;
    }
    vel.y = CLIMB_SPEED + 30 * dt * 0.5; // gravity is applied in the physics step
    // Pressed into the wall, with a little sideways shuffle
    const sx = -fz * input.strafe;
    const sz = fx * input.strafe;
    vel.x = fx * 1.5 + sx * 1.6;
    vel.z = fz * 1.5 + sz * 1.6;
    this.wallTimer = 0;
  }

  // Is there a wall right in front (facing direction), tall enough not to mantle?
  wallAhead(fx, fz) {
    const p = this.position;
    const px = p.x + fx * (HALF_W + 0.18);
    const pz = p.z + fz * (HALF_W + 0.18);
    const y0 = p.y + 0.5;
    const y1 = p.y + this.height - 0.1;
    for (const b of this.near || this.colliders) {
      if (px > b.min.x && px < b.max.x && pz > b.min.z && pz < b.max.z && b.min.y < y1 && b.max.y > y0) return b;
    }
    return null;
  }

  // The top of a ledge in front that can be pulled up onto: within reach above the feet,
  // with room to stand (or crouch) on it.
  findLedge(fx, fz) {
    const p = this.position;
    const near = this.near || this.colliders;
    const px = p.x + fx * (HALF_W + 0.25);
    const pz = p.z + fz * (HALF_W + 0.25);
    let top = -Infinity;
    for (const b of near) {
      if (px < b.min.x || px > b.max.x || pz < b.min.z || pz > b.max.z) continue;
      if (b.max.y <= p.y + 0.45 || b.min.y > p.y + MANTLE_REACH) continue;
      top = Math.max(top, b.max.y);
    }
    if (top === -Infinity || top > p.y + MANTLE_REACH) return null;
    // Room on top, a body's width in from the edge
    const tx = p.x + fx * (HALF_W * 2 + 0.3);
    const tz = p.z + fz * (HALF_W * 2 + 0.3);
    for (const b of near) {
      if (tx - HALF_W < b.max.x && tx + HALF_W > b.min.x && tz - HALF_W < b.max.z && tz + HALF_W > b.min.z &&
          top + 0.02 < b.max.y && top + CROUCH_H > b.min.y) return null;
      // Nothing over our head on the way up
      if (p.x - HALF_W < b.max.x && p.x + HALF_W > b.min.x && p.z - HALF_W < b.max.z && p.z + HALF_W > b.min.z &&
          b.min.y > p.y + this.height - 0.05 && b.min.y < top + CROUCH_H) return null;
    }
    return { top, x: tx, z: tz };
  }

  startMantle(ledge, fx, fz) {
    this.mantle = {
      t: 0,
      from: this.position.clone(),
      to: new THREE.Vector3(ledge.x, ledge.top + 0.001, ledge.z),
      fx, fz,
      carry: Math.hypot(this.velocity.x, this.velocity.z),
    };
    this.climb = null;
    this.sliding = false;
    this.velocity.set(0, 0, 0);
  }

  // Up first, then over the edge. Jump + crouch together near the top: superglide.
  // Jump alone during the mantle: a jump as you land on the ledge.
  updateMantle(dt, input, fx, fz) {
    const m = this.mantle;
    m.t += dt;
    const k = Math.min(1, m.t / MANTLE_TIME);
    const up = Math.min(1, k / 0.65);
    const over = Math.max(0, (k - 0.55) / 0.45);
    const p = this.position;
    p.y = m.from.y + (m.to.y - m.from.y) * (1 - (1 - up) * (1 - up));
    p.x = m.from.x + (m.to.x - m.from.x) * over;
    p.z = m.from.z + (m.to.z - m.from.z) * over;
    this.height = CROUCH_H + (STAND_H - CROUCH_H) * over;
    this.onGround = false;

    const near = k > 0.6;
    const t = this.simTime;
    const vel = this.velocity;
    if (near && Math.abs(this.lastJumpAt - this.lastCrouchAt) < SUPERGLIDE_WINDOW &&
        t - Math.max(this.lastJumpAt, this.lastCrouchAt) < SUPERGLIDE_WINDOW) {
      // Superglide: launched forward along where you're moving (or looking)
      p.copy(m.to);
      const dx = fx;
      const dz = fz;
      vel.set(dx * SUPERGLIDE_SPEED, 3.5, dz * SUPERGLIDE_SPEED);
      this.mantle = null;
      this.lastJumpAt = this.lastCrouchAt = -9;
      this.canDouble = true;
      return;
    }
    if (input.jump) m.jumpQueued = true;
    if (k >= 1) {
      p.copy(m.to);
      this.mantle = null;
      this.height = this.canStand() ? STAND_H : CROUCH_H;
      const carry = Math.min(m.carry, WALK_SPEED);
      vel.set(m.fx * carry * 0.6, 0, m.fz * carry * 0.6);
      if (m.jumpQueued) {
        vel.y = JUMP_VEL;
        vel.x = m.fx * WALK_SPEED;
        vel.z = m.fz * WALK_SPEED;
        this.canDouble = true;
      }
    }
  }

  updateState() {
    if (this.mantle) this.state = 'mantle';
    else if (this.climb) this.state = 'climb';
    else if (this.sliding) this.state = 'slide';
    else if (!this.onGround && this.wallTimer > 0) this.state = 'wall';
    else if (!this.onGround) this.state = 'air';
    else if (this.height < STAND_H) this.state = 'crouch';
    else this.state = 'ground';
  }

  physicsStep(dt) {
    this.velocity.y -= GRAVITY * dt;
    if (this.wallTimer > 0 && !this.climb && this.velocity.y < -WALL_SLIDE_MAX) this.velocity.y = -WALL_SLIDE_MAX;
    const wasGround = this.onGround;
    const fall = -this.velocity.y;
    this.moveAxis('x', this.velocity.x * dt);
    this.moveAxis('z', this.velocity.z * dt);
    this.moveVertical(this.velocity.y * dt);
    this.updateGround();
    if (this.onGround && !wasGround) {
      // Landing: a short bunny-hop window, and a hard landing slows you briefly
      this.landGrace = BHOP_GRACE;
      this.climbUsed = false;
      this.climb = null;
      if (fall > LAND_SHOCK_SPEED && !this.sliding) this.landShock = Math.min(0.5, 0.2 + (fall - LAND_SHOCK_SPEED) * 0.04);
    }
    this.updateWall();
  }

  overlapsWith(box, h) {
    const p = this.position;
    return p.x - HALF_W < box.max.x && p.x + HALF_W > box.min.x &&
           p.y < box.max.y && p.y + h > box.min.y &&
           p.z - HALF_W < box.max.z && p.z + HALF_W > box.min.z;
  }

  overlaps(box) {
    return this.overlapsWith(box, this.height);
  }

  canStand() {
    for (const box of this.near || this.colliders) {
      if (this.overlapsWith(box, STAND_H)) return false;
    }
    return true;
  }

  moveAxis(axis, d) {
    if (d === 0) return;
    this.position[axis] += d;
    for (const box of this.near || this.colliders) {
      if (!this.overlaps(box)) continue;
      const ledge = box.max.y - this.position.y;
      if (this.onGround && ledge > 0 && ledge <= STEP_HEIGHT) {
        this.position.y = box.max.y;
        // The camera eases up the step instead of popping (see Player.updateCamera)
        this.stepOffset = Math.max(-STEP_HEIGHT, this.stepOffset - ledge);
        continue;
      }
      if (d > 0) this.position[axis] = box.min[axis] - HALF_W;
      else this.position[axis] = box.max[axis] + HALF_W;
      this.velocity[axis] = 0;
    }
  }

  moveVertical(d) {
    this.position.y += d;
    for (const box of this.near || this.colliders) {
      if (!this.overlaps(box)) continue;
      if (d < 0) this.position.y = box.max.y;
      else this.position.y = box.min.y - this.height;
      this.velocity.y = 0;
    }
  }

  updateGround() {
    this.onGround = false;
    if (this.velocity.y > 0) return;
    const p = this.position;
    for (const box of this.near || this.colliders) {
      if (Math.abs(box.max.y - p.y) > 0.05) continue;
      const overlapsXZ = p.x + HALF_W > box.min.x && p.x - HALF_W < box.max.x &&
                         p.z + HALF_W > box.min.z && p.z - HALF_W < box.max.z;
      if (overlapsXZ) {
        this.onGround = true;
        this.canDouble = true;
        this.wallTimer = 0;
        this.lastWallBox = null;
        return;
      }
    }
  }

  updateWall() {
    if (this.onGround) return;
    const p = this.position;
    const ex = HALF_W + WALL_PROBE;
    const inner = HALF_W - 0.05;
    const y0 = p.y + 0.1;
    const y1 = p.y + this.height - 0.1;
    for (const [dx, dz] of WALL_DIRS) {
      let x0, x1, z0, z1;
      if (dx !== 0) {
        x0 = dx > 0 ? p.x + HALF_W : p.x - ex;
        x1 = dx > 0 ? p.x + ex : p.x - HALF_W;
        z0 = p.z - inner;
        z1 = p.z + inner;
      } else {
        z0 = dz > 0 ? p.z + HALF_W : p.z - ex;
        z1 = dz > 0 ? p.z + ex : p.z - HALF_W;
        x0 = p.x - inner;
        x1 = p.x + inner;
      }
      for (const b of this.near || this.colliders) {
        if (b.min.x < x1 && b.max.x > x0 && b.min.y < y1 && b.max.y > y0 &&
            b.min.z < z1 && b.max.z > z0) {
          this.wallNormal.set(-dx, 0, -dz);
          this.wallTimer = WALL_STICK;
          this.wallBox = b;
          return;
        }
      }
    }
  }
}
