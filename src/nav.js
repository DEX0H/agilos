import * as THREE from 'three';
import { raycastWorld, nearbyBoxes } from './physics.js';

// Navigation graph for bots. Nodes come from the map (floor centres, stair ends,
// a ground grid). Stairs are linked explicitly; nodes on the same level are linked
// automatically when a body can walk straight between them on solid floor.

const SAME_LEVEL = 0.06;
const GROUND_LINK = 10;      // max link length on the ground
const UPPER_LINK = 18;       // floors, roofs and bridges
const SUPPORT_STEP = 0.8;

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

export class NavGraph {
  // jumps: [a, b, oneWay] gaps a bot must jump across (a to b, and back unless oneWay)
  constructor(colliders, points, links, jumps = []) {
    this.colliders = colliders;
    this.nodes = points.map((p) => ({ p: p.clone(), edges: [] }));
    for (const [a, b] of links) this.link(a, b);
    for (const [a, b, oneWay] of jumps) {
      this.edge(a, b, true);
      if (!oneWay) this.edge(b, a, true);
    }
    this.autoLink();
  }

  edge(a, b, jump = false) {
    const cost = this.nodes[a].p.distanceTo(this.nodes[b].p) * (jump ? 1.3 : 1);
    this.nodes[a].edges.push({ to: b, cost, jump });
  }

  link(a, b) {
    this.edge(a, b);
    this.edge(b, a);
  }

  // Solid floor at height y under (x, z)?
  supported(x, z, y) {
    for (const c of nearbyBoxes(this.colliders, x - 0.1, z - 0.1, x + 0.1, z + 0.1, this.buf || (this.buf = []))) {
      if (Math.abs(c.max.y - y) < SAME_LEVEL &&
          x > c.min.x - 0.05 && x < c.max.x + 0.05 &&
          z > c.min.z - 0.05 && z < c.max.z + 0.05) {
        return true;
      }
    }
    return false;
  }

  rayClear(from, dir, len) {
    return raycastWorld(from, dir, len, this.colliders) >= len - 0.05;
  }

  // Can a standing body walk straight from a to b (same level) without hitting
  // anything or stepping off an edge?
  walkable(a, b) {
    _d.copy(b).sub(a);
    _d.y = 0;
    const len = _d.length();
    if (len < 1e-3) return true;
    _d.divideScalar(len);
    for (const h of [0.6, 1.4]) {
      _o.set(a.x, a.y + h, a.z);
      if (!this.rayClear(_o, _d, len)) return false;
    }
    const px = -_d.z * 0.25;
    const pz = _d.x * 0.25;
    for (const s of [-1, 1]) {
      _o.set(a.x + px * s, a.y + 1.0, a.z + pz * s);
      if (!this.rayClear(_o, _d, len)) return false;
    }
    const steps = Math.ceil(len / SUPPORT_STEP);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      if (!this.supported(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, a.y)) return false;
    }
    return true;
  }

  autoLink() {
    // Bucket nodes by position so each one is only compared with its neighbours
    const B = UPPER_LINK;
    const buckets = new Map();
    const key = (x, z) => `${Math.floor(x / B)},${Math.floor(z / B)}`;
    this.nodes.forEach((nd, i) => {
      const k = key(nd.p.x, nd.p.z);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(i);
    });
    this.nodes.forEach((nd, i) => {
      const a = nd.p;
      const bx = Math.floor(a.x / B);
      const bz = Math.floor(a.z / B);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of buckets.get(`${bx + dx},${bz + dz}`) || []) {
            if (j <= i) continue;
            const b = this.nodes[j].p;
            if (Math.abs(a.y - b.y) > SAME_LEVEL) continue;
            const d = Math.hypot(a.x - b.x, a.z - b.z);
            if (d > (a.y < 0.1 ? GROUND_LINK : UPPER_LINK)) continue;
            if (this.walkable(a, b)) this.link(i, j);
          }
        }
      }
    });
  }

  // Closest node on roughly the same level that can be walked to directly
  nearest(pos) {
    const cands = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const p = this.nodes[i].p;
      if (Math.abs(p.y - pos.y) > 1.3) continue;
      cands.push({ i, d: Math.hypot(p.x - pos.x, p.z - pos.z) });
    }
    cands.sort((a, b) => a.d - b.d);
    for (let k = 0; k < Math.min(6, cands.length); k++) {
      const p = this.nodes[cands[k].i].p;
      _o.set(pos.x, pos.y + 0.9, pos.z);
      _d.set(p.x - pos.x, p.y + 0.9 - _o.y, p.z - pos.z);
      const len = _d.length();
      if (len < 0.3) return cands[k].i;
      _d.divideScalar(len);
      if (this.rayClear(_o, _d, len)) return cands[k].i;
    }
    if (cands.length) return cands[0].i;
    // Nothing on this level: plain nearest in 3D
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const d = this.nodes[i].p.distanceTo(pos);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // A* from the node nearest `from` to the node nearest `to`.
  // Returns a list of points, ending at `to`. Empty if unreachable.
  // A point with `.jump = true` must be reached by jumping from the previous one.
  findPath(from, to) {
    const s = this.nearest(from);
    const t = this.nearest(to);
    const n = this.nodes.length;
    const g = new Float64Array(n).fill(Infinity);
    const f = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const cameJump = new Uint8Array(n);
    const closed = new Uint8Array(n);
    const open = [s];
    const goal = this.nodes[t].p;
    g[s] = 0;
    f[s] = this.nodes[s].p.distanceTo(goal);

    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (f[open[k]] < f[open[bi]]) bi = k;
      const cur = open[bi];
      if (cur === t) break;
      open.splice(bi, 1);
      closed[cur] = 1;
      for (const e of this.nodes[cur].edges) {
        if (closed[e.to]) continue;
        const ng = g[cur] + e.cost;
        if (ng < g[e.to]) {
          if (g[e.to] === Infinity) open.push(e.to);
          g[e.to] = ng;
          f[e.to] = ng + this.nodes[e.to].p.distanceTo(goal);
          came[e.to] = cur;
          cameJump[e.to] = e.jump ? 1 : 0;
        }
      }
    }
    if (s !== t && came[t] === -1) return [];

    const out = [];
    for (let c = t; c !== -1; c = came[c]) {
      const p = this.nodes[c].p.clone();
      p.jump = cameJump[c] === 1;
      out.push(p);
    }
    out.reverse();
    out.push(to.clone());
    return out;
  }

  randomNode() {
    return this.nodes[Math.floor(Math.random() * this.nodes.length)].p;
  }
}
