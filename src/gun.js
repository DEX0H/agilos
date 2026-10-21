import * as THREE from 'three';

// Gun logic shared by the player and bots: ammo, reload, fire rate,
// CS-style accuracy and hitscan. No visuals here.

export const HANDGUN = {
  name: 'handgun',
  range: 150,
  magSize: 12,
  reserve: 48,
  reloadTime: 1.4,
  fireInterval: 0.22,
  damage: 25,
  headshotMult: 2.5,
  // Accuracy: perfect first shot standing still, worse moving or in the air,
  // fast follow-ups add bloom that recovers. Sliding stays fairly accurate.
  moveSpread: 0.03,     // radians at full sprint speed
  airSpread: 0.06,
  slideSpread: 0.012,
  crouchMult: 0.6,
  shotBloom: 0.012,
  bloomRecovery: 6,
  maxBloom: 0.05,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

export class GunState {
  constructor(spec, owner, { infiniteReserve = false } = {}) {
    this.spec = spec;
    this.owner = owner;
    this.magSize = spec.magSize;
    this.ammo = spec.magSize;
    this.reserve = infiniteReserve ? Infinity : spec.reserve;
    this.reloadTimer = 0;
    this.cooldown = 0;
    this.bloom = 0;
  }

  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.bloom *= Math.exp(-this.spec.bloomRecovery * dt);
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.finishReload();
    }
  }

  reload() {
    if (this.reloadTimer > 0 || this.ammo === this.magSize || this.reserve <= 0) return;
    this.reloadTimer = this.spec.reloadTime;
  }

  finishReload() {
    const take = Math.min(this.magSize - this.ammo, this.reserve);
    this.ammo += take;
    this.reserve -= take;
    this.reloadTimer = 0;
  }

  canFire() {
    return !this.owner.dead && this.reloadTimer <= 0 && this.cooldown <= 0 && this.ammo > 0;
  }

  // Current cone half-angle in radians, from the owner's movement plus bloom
  spread() {
    const s = this.spec;
    const o = this.owner;
    const hs = Math.hypot(o.velocity.x, o.velocity.z);
    let r;
    if (o.sliding) r = s.slideSpread;
    else if (!o.onGround) r = s.airSpread;
    else r = s.moveSpread * Math.min(1, hs / 10);
    if (o.state === 'crouch') r *= s.crouchMult;
    return r + this.bloom;
  }

  // Fire from `origin` along `aim`. Returns { fired, hit, headshot, kill, target, end }.
  fire(world, origin, aim) {
    const res = { fired: false, hit: false, headshot: false, kill: false, target: null, end: null };
    if (this.owner.dead || this.reloadTimer > 0 || this.cooldown > 0) return res;
    if (this.ammo <= 0) {
      this.reload();
      return res;
    }

    this.ammo--;
    this.cooldown = this.spec.fireInterval;
    res.fired = true;
    this.owner.dropShield();

    const spread = this.spread();
    this.bloom = Math.min(this.spec.maxBloom, this.bloom + this.spec.shotBloom);

    // Random point in the spread cone around the exact aim
    _dir.copy(aim).normalize();
    if (spread > 0) {
      _right.crossVectors(_dir, WORLD_UP);
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
      _right.normalize();
      _up.crossVectors(_right, _dir).normalize();
      const r = spread * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      _dir.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r).normalize();
    }

    const worldDist = world.raycastWorld(origin, _dir, this.spec.range);
    const end = origin.clone().addScaledVector(_dir, worldDist);
    const hit = world.raycastCombatants(origin, _dir, worldDist, this.owner);
    if (hit) {
      res.hit = true;
      res.headshot = hit.headshot;
      res.target = hit.target;
      end.copy(hit.point);
      const dmg = this.spec.damage * (hit.headshot ? this.spec.headshotMult : 1);
      res.kill = hit.target.takeDamage(dmg, this.owner);
      if (res.kill) world.reportKill(this.owner, hit.target, hit.headshot ? 'headshot' : this.spec.name);
    }
    res.end = end;
    return res;
  }
}
