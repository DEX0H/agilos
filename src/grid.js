// Uniform grid over the map's collision boxes (x/z only), so collision, bullets and line
// of sight only test the boxes near them instead of every box on the map. Attached to
// the colliders array as `colliders.grid`; anything holding the array gets it for free.
// Call rebuild() after boxes are added or removed.

const CELL = 8;

export class ColliderGrid {
  constructor(colliders) {
    this.colliders = colliders;
    this.stamp = 1;
    this.out = [];
    this.rebuild();
  }

  rebuild() {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const b of this.colliders) {
      x0 = Math.min(x0, b.min.x); z0 = Math.min(z0, b.min.z);
      x1 = Math.max(x1, b.max.x); z1 = Math.max(z1, b.max.z);
    }
    if (!Number.isFinite(x0)) { x0 = z0 = -1; x1 = z1 = 1; }
    this.x0 = x0;
    this.z0 = z0;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / CELL));
    this.nz = Math.max(1, Math.ceil((z1 - z0) / CELL));
    this.cells = Array.from({ length: this.nx * this.nz }, () => []);
    for (const b of this.colliders) {
      const [i0, k0, i1, k1] = this.range(b.min.x, b.min.z, b.max.x, b.max.z);
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) this.cells[k * this.nx + i].push(b);
    }
    this.count = this.colliders.length;
  }

  cellX(x) { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / CELL))); }
  cellZ(z) { return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / CELL))); }
  range(x0, z0, x1, z1) { return [this.cellX(x0), this.cellZ(z0), this.cellX(x1), this.cellZ(z1)]; }

  // Boxes overlapping the x/z rectangle (and maybe a few neighbours). The returned array
  // is reused by the next call, so copy it if you need to keep it.
  query(x0, z0, x1, z1, out = this.out) {
    if (this.count !== this.colliders.length) this.rebuild();
    out.length = 0;
    const s = ++this.stamp;
    const [i0, k0, i1, k1] = this.range(x0, z0, x1, z1);
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        for (const b of this.cells[k * this.nx + i]) {
          if (b.__q === s) continue;
          b.__q = s;
          out.push(b);
        }
      }
    }
    return out;
  }

  // Does any box intersect `box`?
  hitsBox(box) {
    for (const b of this.query(box.min.x, box.min.z, box.max.x, box.max.z)) if (b.intersectsBox(box)) return true;
    return false;
  }

  // Distance along the ray to the nearest box, capped at maxDist. Walks the grid cells
  // the ray passes through (2D DDA) and stops once a hit is closer than the next cell.
  raycast(origin, dir, maxDist, hitBox) {
    if (this.count !== this.colliders.length) this.rebuild();
    const s = ++this.stamp;
    let best = maxDist;
    // Starting outside the grid (rare): test everything
    if (origin.x < this.x0 || origin.z < this.z0 || origin.x > this.x0 + this.nx * CELL || origin.z > this.z0 + this.nz * CELL) {
      for (const b of this.colliders) { const d = hitBox(b); if (d < best) best = d; }
      return best;
    }
    let i = this.cellX(origin.x);
    let k = this.cellZ(origin.z);
    const stepI = dir.x > 0 ? 1 : -1;
    const stepK = dir.z > 0 ? 1 : -1;
    const ax = Math.abs(dir.x);
    const az = Math.abs(dir.z);
    const nextX = this.x0 + (i + (stepI > 0 ? 1 : 0)) * CELL;
    const nextZ = this.z0 + (k + (stepK > 0 ? 1 : 0)) * CELL;
    let tMaxX = ax > 1e-9 ? (nextX - origin.x) / dir.x : Infinity;
    let tMaxZ = az > 1e-9 ? (nextZ - origin.z) / dir.z : Infinity;
    const tDX = ax > 1e-9 ? CELL / ax : Infinity;
    const tDZ = az > 1e-9 ? CELL / az : Infinity;
    // Origins outside the grid: just clamp (the edge cells hold the perimeter walls)
    for (;;) {
      for (const b of this.cells[k * this.nx + i]) {
        if (b.__q === s) continue;
        b.__q = s;
        const d = hitBox(b);
        if (d < best) best = d;
      }
      const tNext = Math.min(tMaxX, tMaxZ);
      if (tNext >= best) break;
      if (tMaxX < tMaxZ) {
        i += stepI;
        tMaxX += tDX;
      } else {
        k += stepK;
        tMaxZ += tDZ;
      }
      if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) break;
    }
    return best;
  }
}
