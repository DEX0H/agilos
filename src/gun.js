import * as THREE from 'three';

// Gun logic shared by the player and bots: ammo, reload, fire rate,
// CS-style accuracy and hitscan. No visuals here.

export const HANDGUN = {
  name: 'handgun',
  label: 'Handgun',
  model: 'pistol',
  auto: false,
  recoil: 0.03,         // camera kick per shot, radians
  range: 150,
  magSize: 12,
  reserve: 72,
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

// Mystery box weapons. `weight` is the chance of rolling it relative to the others.
// Damage falls off from `falloff[0]` to `falloff[1]` metres down to `falloff[2]` of full.
export const SMG = {
  name: 'smg',
  label: 'SMG',
  model: 'smg',
  rarity: 'common',
  weight: 55,
  auto: true,
  recoil: 0.009,
  range: 90,
  magSize: 30,
  reserve: 150,
  reloadTime: 1.7,
  fireInterval: 0.07,   // ~860 rounds per minute
  damage: 17,
  headshotMult: 1.6,
  falloff: [12, 35, 0.6],
  moveSpread: 0.022,    // stays usable on the move
  airSpread: 0.045,
  slideSpread: 0.012,
  crouchMult: 0.7,
  shotBloom: 0.005,
  bloomRecovery: 8,
  maxBloom: 0.04,
};

export const RIFLE = {
  name: 'rifle',
  label: 'Assault rifle',
  model: 'rifle',
  rarity: 'rare',
  weight: 35,
  auto: true,
  recoil: 0.013,
  range: 160,
  magSize: 30,
  reserve: 120,
  reloadTime: 2.1,
  fireInterval: 0.1,    // 600 rounds per minute
  damage: 25,
  headshotMult: 2,
  falloff: [35, 80, 0.8],
  moveSpread: 0.045,    // best standing still or crouched
  airSpread: 0.09,
  slideSpread: 0.025,
  crouchMult: 0.55,
  shotBloom: 0.007,
  bloomRecovery: 6,
  maxBloom: 0.055,
};

// The rarest roll: one body shot kills (a spawn shield still blocks it)
export const SNIPER = {
  name: 'sniper',
  label: 'Sniper',
  model: 'sniper',
  rarity: 'legendary',
  weight: 10,
  auto: false,
  scope: true,
  scopeFov: 22,
  recoil: 0.07,
  range: 300,
  magSize: 5,
  reserve: 15,
  reloadTime: 2.6,
  fireInterval: 1.2,    // bolt action
  damage: 250,          // more than full health
  headshotMult: 1,
  hipSpread: 0.07,      // unscoped shots are a gamble
  moveSpread: 0.06,
  airSpread: 0.12,
  slideSpread: 0.06,
  crouchMult: 0.5,
  shotBloom: 0,
  bloomRecovery: 6,
  maxBloom: 0,
};

export const BOX_WEAPONS = [SMG, RIFLE, SNIPER];

// Weighted random pick from the mystery box pool
export function rollBoxWeapon(rand = Math.random) {
  const total = BOX_WEAPONS.reduce((a, w) => a + w.weight, 0);
  let r = rand() * total;
  for (const w of BOX_WEAPONS) {
    r -= w.weight;
    if (r < 0) return w;
  }
  return BOX_WEAPONS[0];
}

export const RARITY_COLORS = { common: '#58a6ff', rare: '#b072ff', legendary: '#ffb02e' };

function falloff(spec, d) {
  if (!spec.falloff) return 1;
  const [near, far, min] = spec.falloff;
  const t = Math.min(1, Math.max(0, (d - near) / (far - near)));
  return 1 - t * (1 - min);
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

export class GunState {
  constructor(spec, owner, { infiniteReserve = false } = {}) {
    this.spec = spec;
    this.owner = owner;
    this.magSize = spec.magSize;
    this.infiniteReserve = infiniteReserve;
    this.refill();
  }

  // Full magazine and reserve, nothing in progress. Called on every spawn.
  refill() {
    this.ammo = this.spec.magSize;
    this.reserve = this.infiniteReserve ? Infinity : this.spec.reserve;
    this.reloadTimer = 0;
    this.cooldown = 0;
    this.bloom = 0;
  }

  update(dt) {
    // A little negative cooldown is kept so held-trigger fire rate doesn't depend on frame rate
    this.cooldown = Math.max(-0.02, this.cooldown - dt);
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
    if (s.hipSpread && !o.ads) r += s.hipSpread; // scoped weapons need the scope to be accurate
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
    this.cooldown = Math.min(0, this.cooldown) + this.spec.fireInterval;
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
      const dmg = this.spec.damage * (hit.headshot ? this.spec.headshotMult : 1) * falloff(this.spec, hit.distance);
      res.kill = hit.target.takeDamage(dmg, this.owner);
      if (res.kill) world.reportKill(this.owner, hit.target, hit.headshot ? 'headshot' : this.spec.name);
    }
    res.end = end;
    return res;
  }
}
