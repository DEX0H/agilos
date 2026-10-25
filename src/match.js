import * as THREE from 'three';

// Battle royale match: random spawns, no respawns, a safe zone that shrinks in
// phases and hurts anyone outside it, last one alive wins.

const COUNTDOWN = 3;
const START_RADIUS = 44;        // covers the whole 60 x 60 map at the start
const MAP_HALF = 26;            // zone centres stay inside this square
// Apex-style ring rounds, scaled to this small map (Apex Arenas: 45/35/30/15 s waits,
// damage per tick rising each round, the last ring closing completely).
// Each round: `wait` with the next ring shown, then the ring closes to `radius` over
// `shrink` seconds. Outside it you take `tick` damage every TICK seconds; the damage of
// a round applies from the moment that round's ring starts closing.
export const TICK = 1.5;
const START_TICK = 2;
export const PHASES = [
  { wait: 20, shrink: 20, radius: 30, tick: 3 },
  { wait: 20, shrink: 15, radius: 20, tick: 5 },
  { wait: 15, shrink: 12, radius: 12, tick: 8 },
  { wait: 12, shrink: 10, radius: 6, tick: 12 },
  { wait: 10, shrink: 10, radius: 2.5, tick: 18 },
  { wait: 8, shrink: 15, radius: 0, tick: 25 },
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
    this.startRadius = 44;

    this.zone = {
      cx: 0, cz: 0, r: this.startRadius,
      fromX: 0, fromZ: 0, fromR: this.startRadius,
      toX: 0, toZ: 0, toR: this.startRadius,
      phase: 0, phaseTime: 0, shrinking: false, tick: START_TICK, tickTimer: TICK,
    };
    this.onRing = null; // (text) => void, for announcements
    this.setMapSize(30);

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

    // Where the ring goes next: a thin white wall
    this.nextWall = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 40, 128, 1, true),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(1.4, 1.4, 1.4), transparent: true, opacity: 0.07,
        side: THREE.DoubleSide, depthWrite: false, fog: false,
      }),
    );
    this.nextWall.position.y = 20;
    this.nextWall.renderOrder = 2;
    this.nextWall.visible = false;
    scene.add(this.nextWall);

    bots.match = this;
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
    const everyone = [...this.world.combatants];
    this.total = everyone.length;
    // Everyone gets a different random spawn. With more players than fixed spawn points,
    // extra ones come from the bots' navigation points, kept apart from each other.
    const spawns = [...this.spawnPoints].sort(() => Math.random() - 0.5);
    if (this.extraSpawns && spawns.length < everyone.length) {
      const pool = [...this.extraSpawns].sort(() => Math.random() - 0.5);
      for (const minGap of [8, 5, 2]) {
        for (const p of pool) {
          if (spawns.length >= everyone.length) break;
          if (spawns.every((s) => s.distanceTo(p) >= minGap)) spawns.push(p);
        }
      }
    }
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
      cx: 0, cz: 0, r: this.startRadius, phase: 0, shrinking: false, tick: START_TICK, tickTimer: TICK,
      phaseTime: this.phases[0].wait,
    });
    this.planNext();

    this.state = 'countdown';
    this.timer = COUNTDOWN;
    this.winner = null;
    this.playerPlace = 0;
    this.wall.visible = true;
  }

  // Ring sizes follow the map (the numbers above are for the 60 x 60 m map); bigger maps
  // also get longer rounds so there is time to cross them
  setMapSize(half) {
    const f = half / 30;
    const slow = 1 + (f - 1) * 0.5;
    this.startRadius = 44 * f;
    this.mapHalf = 26 * f;
    this.phases = PHASES.map((p) => ({ ...p, wait: p.wait * slow, shrink: p.shrink * slow, radius: p.radius * f }));
    this.zone.r = this.zone.fromR = this.zone.toR = this.startRadius;
  }

  // Next circle sits inside the current one
  planNext() {
    const z = this.zone;
    const ph = this.phases[z.phase];
    z.fromX = z.cx;
    z.fromZ = z.cz;
    z.fromR = z.r;
    const room = Math.max(0, z.r - ph.radius);
    const a = Math.random() * Math.PI * 2;
    const d = room * Math.sqrt(Math.random()) * 0.8;
    const lim = Math.max(0, this.mapHalf - ph.radius * 0.5);
    z.toX = THREE.MathUtils.clamp(z.cx + Math.cos(a) * d, -lim, lim);
    z.toZ = THREE.MathUtils.clamp(z.cz + Math.sin(a) * d, -lim, lim);
    z.toR = ph.radius;
  }

  updateZone(dt) {
    const z = this.zone;
    if (z.phase >= this.phases.length) return;
    const ph = this.phases[z.phase];
    z.phaseTime -= dt;
    if (!z.shrinking) {
      if (z.phaseTime <= 0) {
        z.shrinking = true;
        z.phaseTime = ph.shrink;
        z.tick = ph.tick;
        this.announce(z.phase === this.phases.length - 1 ? 'FINAL RING CLOSING' : `RING ${z.phase + 1} CLOSING`);
      }
      return;
    }
    const t = 1 - Math.max(0, z.phaseTime) / ph.shrink;
    z.cx = THREE.MathUtils.lerp(z.fromX, z.toX, t);
    z.cz = THREE.MathUtils.lerp(z.fromZ, z.toZ, t);
    z.r = THREE.MathUtils.lerp(z.fromR, z.toR, t);
    if (z.phaseTime <= 0) {
      z.phase++;
      z.shrinking = false;
      if (z.phase < this.phases.length) {
        z.phaseTime = this.phases[z.phase].wait;
        this.planNext();
        this.announce('NEXT RING MARKED');
      }
    }
  }

  announce(text) {
    if (this.onRing) this.onRing(text);
  }

  get rounds() { return this.phases.length; }

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
    // A network client only draws the match; the host's game runs it
    if (!this.follower) this.updateRules(dt);
    this.updateWalls();
  }

  updateRules(dt) {

    if (this.state === 'countdown') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.state = 'live';
        for (const c of this.world.combatants) c.frozen = false; // shields start counting now
      }
    }

    if (this.state === 'live' || this.state === 'over') {
      this.updateZone(dt);
      // Ring damage comes in ticks, like Apex
      const z = this.zone;
      z.tickTimer -= dt;
      if (z.tickTimer <= 0) {
        z.tickTimer += TICK;
        for (const c of this.world.combatants) {
          if (c.dead || this.inside(c.position)) continue;
          if (c.takeDamage(z.tick, null)) this.world.reportKill(null, c, 'ring');
        }
      }
    }

    if (this.state === 'live' && this.aliveCount() <= 1) {
      this.state = 'over';
      this.winner = this.world.combatants.find((c) => !c.dead) || null;
      if (this.winner === this.player) this.playerPlace = 1;
    }
  }

  updateWalls() {
    const z = this.zone;
    this.wall.visible = z.r > 0.3;
    this.wall.position.x = z.cx;
    this.wall.position.z = z.cz;
    this.wall.scale.set(Math.max(0.01, z.r), 1, Math.max(0.01, z.r));
    const showNext = z.phase < this.phases.length && (this.state === 'live' || this.state === 'countdown') && z.toR < z.r - 0.5;
    this.nextWall.visible = showNext && z.toR > 0.3;
    this.nextWall.position.x = z.toX;
    this.nextWall.position.z = z.toZ;
    this.nextWall.scale.set(Math.max(0.01, z.toR), 1, Math.max(0.01, z.toR));
  }

  // One line for the HUD about the zone, from the player's point of view
  zoneText() {
    if (this.state !== 'live' && this.state !== 'over') return '';
    const z = this.zone;
    let line;
    const round = `RING ${Math.min(z.phase + 1, this.phases.length)}/${this.phases.length}`;
    if (z.phase >= this.phases.length) line = 'RING    closed';
    else if (z.shrinking) line = `${round}  closing ${Math.ceil(z.phaseTime)}s`;
    else line = `${round}  closes in ${Math.ceil(z.phaseTime)}s`;
    const p = this.player;
    if (!p.dead && !this.inside(p.position)) {
      const dx = z.cx - p.position.x;
      const dz = z.cz - p.position.z;
      const dist = Math.max(0, Math.hypot(dx, dz) - z.r);
      const ang = Math.atan2(dx, -dz); // 0 = north (-z)
      const dir = DIRS[(Math.round(ang / (Math.PI / 4)) + 8) % 8];
      line += `\nOUTSIDE RING  -${z.tick} every ${TICK}s   safe ${dist.toFixed(0)} m ${dir}`;
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
