import * as THREE from 'three';

// Procedural grayscale textures (seamless). Tinted per material through `color`.
// Generated in code, so there are no image assets or licensing to track.

const cache = {};

function hash(x, y, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

// Value noise on a periodic lattice with period p, so tiles join seamlessly.
function pnoise(x, y, p, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const x0 = ((xi % p) + p) % p, x1 = (x0 + 1) % p;
  const y0 = ((yi % p) + p) % p, y1 = (y0 + 1) % p;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(x0, y0, s), b = hash(x1, y0, s), c = hash(x0, y1, s), d = hash(x1, y1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Fractal noise; u,v in [0,1), returns roughly 0..1.
function fbm(u, v, base, s, octaves) {
  let sum = 0, amp = 0.5, per = base, total = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * pnoise(u * per, v * per, per, s + i * 17);
    total += amp;
    amp *= 0.5;
    per *= 2;
  }
  return sum / total;
}

function makeTexture(size, fn) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.max(0, Math.min(1, fn(x / size, y / size, x, y)));
      const i = (y * size + x) * 4;
      const c = Math.round(v * 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const KINDS = {
  // Weathered concrete with pitting
  concrete: (u, v, x, y) => {
    const n = fbm(u, v, 4, 1, 5);
    const g = hash(x, y, 7);
    const pit = g > 0.985 ? 0.55 : 1;
    return (0.62 + (n - 0.5) * 0.7 + (g - 0.5) * 0.08) * pit;
  },
  // Packed dirt and grit for the ground
  ground: (u, v, x, y) => {
    const n = fbm(u, v, 8, 3, 4);
    const g = hash(x, y, 11);
    return 0.55 + (n - 0.5) * 0.6 + (g > 0.96 ? 0.25 : 0) + (g - 0.5) * 0.05;
  },
  // Paneled sheet metal with seams and scratches
  metal: (u, v, x, y) => {
    const pu = (u * 2) % 1, pv = (v * 2) % 1;
    const seam = pu < 0.012 || pv < 0.012 ? -0.25 : 0;
    const n = fbm(u, v, 4, 5, 4);
    const scratch = hash(x, y, 3) > 0.993 ? 0.2 : 0;
    return 0.7 + (n - 0.5) * 0.35 + seam + scratch + (hash(x, y, 9) - 0.5) * 0.05;
  },
  // Planks with grain
  wood: (u, v, x, y) => {
    const pl = (v * 4) % 1;
    const seam = pl < 0.025 ? -0.3 : 0;
    const n = fbm(u, v, 8, 6, 4);
    return 0.5 + (n - 0.5) * 0.6 + seam;
  },
};

export function getTexture(kind) {
  if (!cache[kind]) cache[kind] = makeTexture(256, KINDS[kind]);
  return cache[kind];
}
