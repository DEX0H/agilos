import * as THREE from 'three';

// Battle royale match: random spawns, no respawns, a safe zone that shrinks in
// phases and hurts anyone outside it, last one alive wins.

const COUNTDOWN = 3;
const START_RADIUS = 44;        // covers the whole 60 x 60 map at the start
const START_DPS = 2;            // zone damage per second before the first close
const MAP_HALF = 26;            // zone centres stay inside this square
// Each phase: wait, then shrink to `radius` over `shrink` seconds; after that, `dps` outside
const PHASES = [
  { wait: 25, shrink: 20, radius: 26, dps: 4 },
  { wait: 15, shrink: 15, radius: 15, dps: 7 },
  { wait: 12, shrink: 12, radius: 7, dps: 12 },
  { wait: 8, shrink: 15, radius: 0, dps: 20 },
];

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class Match {
  constructor(scene, world, player, bots, spawnPoints) {
    this.world = world;
    this.player = player;
    this.bots = bots;
    this.spawnPoints = spawnPoints;
    this.state = 'warmup';      // warmup -> countdown -> live -> over
    this.timer = 0;
    this.winner = null;
    this.playerPlace = 0;
    this.total = 1 + bots.list.length;

    this.zone = {
      cx: 0, cz: 0, r: START_RADIUS,
      fromX: 0, fromZ: 0, fromR: START_RADIUS,
      toX: 0, toZ: 0, toR: START_RADIUS,
      phase: 0, phaseTime: 0, shrinking: false, dps: START_DPS,
    };

    // Zone wall: a tall translucent cylinder that glows a little
    this.wall = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 80, 128, 1, true),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.5, 0.9, 2.2),
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
        fog: false,
      }),
    );
    this.wall.position.y = 30;
    this.wall.renderOrder = 2;
    this.wall.visible = false;
    scene.add(this.wall);

    for (const b of bots.list) b.match = this;
    for (const b of bots.list) b.frozen = true; // bots wait until the match starts

    world.onKill((killer, victim) => {
      if (this.state !== 'live') return;
      if (victim === this.player) this.playerPlace = this.aliveCount() + 1;
    });
  }

  aliveCount() {
    return this.world.combatants.filter((c) => !c.dead).length;
  }

  start() {
    // Everyone gets a different random spawn
    const spawns = [...this.spawnPoints].sort(() => Math.random() - 0.5);
    const everyone = [this.player, ...this.bots.list];
    everyone.forEach((c, i) => {
      c.spawn.copy(spawns[i % spawns.length]);
      c.canRespawn = false;
      c.kills = 0;
      c.deaths = 0;
      c.lastAttacker = null;
      c.respawn(true); // `true` keeps the assigned spawn (bots otherwise pick a random one)
      c.frozen = true;
    });

    const z = this.zone;
    Object.assign(z, {
      cx: 0, cz: 0, r: START_RADIUS, phase: 0, shrinking: false, dps: START_DPS,
      phaseTime: PHASES[0].wait,
    });
    this.planNext();

    this.state = 'countdown';
    this.timer = COUNTDOWN;
    this.winner = null;
    this.playerPlace = 0;
    this.wall.visible = true;
  }

  // Next circle sits inside the current one
  planNext() {
    const z = this.zone;
    const ph = PHASES[z.phase];
    z.fromX = z.cx;
    z.fromZ = z.cz;
    z.fromR = z.r;
    const room = Math.max(0, z.r - ph.radius);
    const a = Math.random() * Math.PI * 2;
    const d = room * Math.sqrt(Math.random()) * 0.8;
    const lim = Math.max(0, MAP_HALF - ph.radius * 0.5);
    z.toX = THREE.MathUtils.clamp(z.cx + Math.cos(a) * d, -lim, lim);
    z.toZ = THREE.MathUtils.clamp(z.cz + Math.sin(a) * d, -lim, lim);
    z.toR = ph.radius;
  }

  updateZone(dt) {
    const z = this.zone;
    if (z.phase >= PHASES.length) return;
    const ph = PHASES[z.phase];
    z.phaseTime -= dt;
    if (!z.shrinking) {
      if (z.phaseTime <= 0) {
        z.shrinking = true;
        z.phaseTime = ph.shrink;
      }
      return;
    }
    const t = 1 - Math.max(0, z.phaseTime) / ph.shrink;
    z.cx = THREE.MathUtils.lerp(z.fromX, z.toX, t);
    z.cz = THREE.MathUtils.lerp(z.fromZ, z.toZ, t);
    z.r = THREE.MathUtils.lerp(z.fromR, z.toR, t);
    if (z.phaseTime <= 0) {
      z.dps = ph.dps;
      z.phase++;
      z.shrinking = false;
      if (z.phase < PHASES.length) {
        z.phaseTime = PHASES[z.phase].wait;
        this.planNext();
      }
    }
  }

  // Inside the current safe circle, with an optional safety margin
  inside(pos, margin = 0) {
    return Math.hypot(pos.x - this.zone.cx, pos.z - this.zone.cz) <= Math.max(0, this.zone.r - margin);
  }

  // Inside the circle the zone is heading to
  insideNext(pos) {
    const z = this.zone;
    return Math.hypot(pos.x - z.toX, pos.z - z.toZ) <= Math.max(1, z.toR - 1);
  }

  centre() {
    return new THREE.Vector3(this.zone.toX, 0, this.zone.toZ);
  }

  update(dt) {
    if (this.state === 'warmup') return;

    if (this.state === 'countdown') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.state = 'live';
        for (const c of this.world.combatants) c.frozen = false; // shields start counting now
      }
    }

    if (this.state === 'live' || this.state === 'over') {
      this.updateZone(dt);
      for (const c of this.world.combatants) {
        if (c.dead || this.inside(c.position)) continue;
        if (c.takeDamage(this.zone.dps * dt, null)) this.world.reportKill(null, c, 'zone');
      }
    }

    if (this.state === 'live' && this.aliveCount() <= 1) {
      this.state = 'over';
      this.winner = this.world.combatants.find((c) => !c.dead) || null;
      if (this.winner === this.player) this.playerPlace = 1;
    }

    const z = this.zone;
    this.wall.visible = z.r > 0.3;
    this.wall.position.x = z.cx;
    this.wall.position.z = z.cz;
    this.wall.scale.set(Math.max(0.01, z.r), 1, Math.max(0.01, z.r));
  }

  // One line for the HUD about the zone, from the player's point of view
  zoneText() {
    if (this.state !== 'live' && this.state !== 'over') return '';
    const z = this.zone;
    let line;
    if (z.phase >= PHASES.length) line = 'ZONE    closed';
    else if (z.shrinking) line = `ZONE    shrinking ${Math.ceil(z.phaseTime)}s`;
    else line = `ZONE    closing in ${Math.ceil(z.phaseTime)}s`;
    const p = this.player;
    if (!p.dead && !this.inside(p.position)) {
      const dx = z.cx - p.position.x;
      const dz = z.cz - p.position.z;
      const dist = Math.max(0, Math.hypot(dx, dz) - z.r);
      const ang = Math.atan2(dx, -dz); // 0 = north (-z)
      const dir = DIRS[(Math.round(ang / (Math.PI / 4)) + 8) % 8];
      line += `\nOUTSIDE ZONE  -${z.dps}/s   safe ${dist.toFixed(0)} m ${dir}`;
    }
    return line;
  }

  // Big centre message, or '' for none
  bannerText() {
    if (this.state === 'warmup') return '';
    if (this.state === 'countdown') return `MATCH STARTS IN ${Math.ceil(this.timer)}`;
    if (this.state === 'over') {
      if (this.winner === this.player) return `VICTORY  ·  #1 of ${this.total}\nEnter for a new match`;
      const w = this.winner ? `${this.winner.name} wins` : 'Nobody survived';
      const place = this.playerPlace ? `You placed #${this.playerPlace} of ${this.total}  ·  ` : '';
      return `${w}\n${place}Enter for a new match`;
    }
    if (this.player.dead) return `ELIMINATED  ·  #${this.playerPlace} of ${this.total}\nEnter for a new match`;
    return '';
  }
}
