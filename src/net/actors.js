import * as THREE from 'three';
import { Bot } from '../bots.js';
import { NO_INPUT, STAND_H, CROUCH_H } from '../character.js';
import { GunState, HANDGUN } from '../gun.js';
import { meleeHit, KNIFE_COOLDOWN } from '../knife.js';
import { emit } from '../events.js';

// The two kinds of network player.
//
// RemotePlayer lives in the host's game: a real player on another computer. It is a bot
// body whose brain is that player's inputs. The host simulates their movement with the
// same code their own game uses, and decides their shots, slashes and box spins. If they
// drop out mid-match, the bot brain takes over where they stood.
//
// Puppet lives in a joining player's game: everyone else (the host, other players and
// bots), drawn where the host's snapshots say they are.

const _origin = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const MAX_QUEUE = 90;
const TIME_BUDGET = 0.25;        // seconds of input a player may run ahead (lag bursts)
const FIRE_SLACK = 0.03;         // seconds of fire-rate tolerance for timing jitter

function aimVector(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

export class RemotePlayer extends Bot {
  constructor(scene, world, nav, spawn, index, spawnPoints, opts) {
    super(scene, world, nav, spawn, index, spawnPoints, opts);
    this.remote = true;
    this.queue = [];
    this.lastSeq = -1;
    this.budget = 0;
    this.knifeOut = false;
    this.knifeCooldown = 0;
    this.disconnected = false;
    this.ads = false;
    this.renderTime = 0;
    this.sinceFire = 9;
    this.equipGun(HANDGUN);
    this.net = null;  // the NetHost: lag compensation and messages
  }

  // A player's weapons have limited ammo, like your own (bots have unlimited reserves)
  equipGun(spec) {
    this.gun = new GunState(spec, this);
    this.showHeldGun();
  }

  get netCombat() { return this.sinceFire < 1.5 || this.aiming; }

  receive(inputs) {
    for (const inp of inputs) {
      if (inp.seq <= this.lastSeq || this.queue.some((q) => q.seq === inp.seq)) continue;
      this.queue.push(inp);
    }
    this.queue.sort((a, b) => a.seq - b.seq);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  update(dt) {
    if (this.disconnected) { super.update(dt); return; }
    this.speedMult = this.knifeOut ? 1.13 : 1;
    this.damageMult = 1;
    this.preUpdate(dt);
    this.sinceFire += dt;
    // Inputs carry their own frame time; the budget stops a modified game from running
    // its clock faster than real time (speed hacks)
    this.budget = Math.min(TIME_BUDGET, this.budget + dt);
    if (this.tickDead(dt)) {
      this.queue.length = 0;
      this.deathTime += dt;
      const show = this.mixer && this.deathTime < 1.6;
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
    while (this.queue.length && this.queue[0].dt <= this.budget + 0.002) {
      const inp = this.queue.shift();
      this.budget -= inp.dt;
      this.step(inp);
    }
    this.animate(dt);
  }

  step(inp) {
    this.lastSeq = inp.seq;
    this.yaw = inp.yaw;
    this.pitch = inp.pitch;
    this.aiming = inp.aiming;
    this.ads = inp.scoped;
    this.knifeOut = inp.knife;
    this.speedMult = inp.knife ? 1.13 : 1;
    this.renderTime = inp.rt;
    this.gun.update(inp.dt);
    this.knifeCooldown = Math.max(0, this.knifeCooldown - inp.dt);
    this.simulate(inp.dt, this.frozen ? NO_INPUT : inp);
    if (this.frozen || this.dead) return;

    if (inp.reload && !this.knifeOut) this.gun.reload();
    if (inp.use && this.boxes) this.useBox();
    if (inp.fires > 0 && !this.knifeOut) {
      for (let i = 0; i < inp.fires; i++) {
        if (this.gun.cooldown > 0 && this.gun.cooldown <= FIRE_SLACK) this.gun.cooldown = 0;
        this.fireOnce(inp);
      }
    }
    if (inp.slash && this.knifeOut && this.knifeCooldown <= 0) this.slash(inp);
  }

  shotOrigin() {
    return _origin.set(this.position.x, this.position.y + this.eyeOff, this.position.z);
  }

  fireOnce(inp) {
    const origin = this.shotOrigin().clone();
    const aim = aimVector(inp.aimYaw, inp.aimPitch, _aim).clone();
    // Lag compensation: everyone else goes back to where this player saw them
    const r = this.net.rewind(this, inp.rt, () => this.gun.fire(this.world, origin, aim));
    if (!r.fired) return;
    this.sinceFire = 0;
    this.shootAnim = 0.3;
    this.flashTimer = 0.05;
    this.muzzle.getWorldPosition(_muzzle);
    this.world.addTracer(_muzzle, r.end, this);
    if (r.hit) this.net.hitConfirm(this, r.headshot);
  }

  slash(inp) {
    this.knifeCooldown = KNIFE_COOLDOWN;
    this.sinceFire = 0;
    this.dropShield();
    emit('slash', this);
    const origin = this.shotOrigin().clone();
    const aim = aimVector(inp.aimYaw, inp.aimPitch, _aim).clone();
    const r = this.net.rewind(this, inp.rt, () => meleeHit(this.world, this, origin, aim));
    if (r.hit) this.net.hitConfirm(this, false);
  }

  useBox() {
    const box = this.boxes.inReach(this, aimVector(this.yaw, 0, _aim));
    if (!box || !box.ready) return;
    box.spin(this, (spec) => { if (!this.dead) this.equipGun(spec); });
  }

  // Dropped out: a bot plays on from here
  disconnect() {
    this.disconnected = true;
    this.remote = false;
    this.name = `${this.name} (bot)`;
    this.target = null;
    this.path = [];
    this.goal = null;
  }
}

// Everyone else, as seen by a joining player. No brain and no physics: position, aim and
// state come from the host. Footsteps and jumps are worked out from the movement so
// they still make sound.
export class Puppet extends Bot {
  constructor(scene, world, spawn, index, opts) {
    super(scene, world, null, spawn, index, [spawn], opts);
    this.puppet = true;
    this.canRespawn = false;
    this.netWeapon = HANDGUN;
    this.netCombat = false;
    this.knifeOut = false;
    this.reloading = false;
    this.prevGround = true;
    this.prevSliding = false;
    this.stepDist = 0;
  }

  // The host decides all damage; a shot here only shows a tracer
  takeDamage() { return false; }
  respawn() {}

  setWeapon(spec) {
    if (this.gun.spec === spec) return;
    this.equipGun(spec);
  }

  // `s` is the interpolated state for this frame
  apply(s, dt) {
    const wasDead = this.dead;
    this.position.set(s.x, s.y, s.z);
    this.velocity.set(s.vx, s.vy, s.vz);
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.health = s.health;
    this.dead = s.dead;
    this.onGround = s.onGround;
    this.sliding = s.sliding;
    this.height = s.crouch ? CROUCH_H : STAND_H;
    this.state = s.state;
    this.shieldTimer = s.shielded ? Math.max(0.1, s.shield) : 0;
    this.frozen = s.frozen;
    this.knifeOut = s.knife;
    this.target = s.combat ? this : null;
    this.targetVisible = s.combat;
    this.gun.reloadTimer = s.reloading ? 1 : 0;
    this.setWeapon(s.weapon);
    if (this.dead && !wasDead) this.deathTime = 0;

    // Sounds from movement
    if (!this.dead) {
      const hs = Math.hypot(s.vx, s.vz);
      if (this.onGround && !this.prevGround) emit('land', this, Math.max(0, -s.vy) + 6);
      if (!this.onGround && this.prevGround && s.vy > 3) emit('jump', this, 'jump');
      if (this.sliding && !this.prevSliding) emit('slide', this, hs);
      if (this.onGround && !this.sliding) {
        this.stepDist += hs * dt;
        const stride = this.height < STAND_H ? 1.15 : hs > 8.5 ? 2.4 : 1.8;
        if (hs > 0.8 && this.stepDist > stride) {
          this.stepDist = 0;
          emit('step', this, hs, this.height < STAND_H);
        }
      }
    }
    this.prevGround = this.onGround;
    this.prevSliding = this.sliding;
  }

  update(dt) {
    this.shootAnim = Math.max(0, this.shootAnim - dt);
    this.damageFlash = Math.max(0, this.damageFlash - dt);
    if (this.dead) {
      this.deathTime += dt;
      const show = this.mixer && this.deathTime < 1.6;
      this.group.visible = show;
      if (show) {
        this.tag.visible = false;
        this.bar.visible = false;
        this.bubble.visible = false;
        this.animateHuman(dt);
      }
      return;
    }
    this.group.visible = true;
    this.tag.visible = true;
    this.bar.visible = true;
    this.animate(dt);
  }
}
