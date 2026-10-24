import * as THREE from 'three';
import { on } from './events.js';
import { settings, onSettingsChange } from './settings.js';
import { composeBeat } from './music.js';

// All game sound, synthesized in code (no sample files, nothing to license):
// gunshots per weapon (crack, body, low thump, street echo), reloads, dry fire, knife,
// hit / headshot / kill ticks, footsteps, jumps, landings, slides. Every sound is
// rendered once into a few slightly different variants when audio starts, then played
// from buffers. Other players' sounds are positional (HRTF): you hear where they are,
// muffled by distance and by walls in between. Footsteps of others are kept quiet.

const RATE = 44100;
const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();
const VARIANTS = 4;

// ---------- Synthesis helpers (run inside an OfflineAudioContext) ----------
function noiseBuffer(ctx, seconds) {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function env(param, t0, peak, attack, decay) {
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  param.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}
// Filtered noise burst. freq may be [from, to] for a sweep.
function noise(ctx, out, { type = 'bandpass', freq = 1000, q = 0.8, t = 0, peak = 1, attack = 0.001, decay = 0.05 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, attack + decay + 0.05);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  if (Array.isArray(freq)) {
    f.frequency.setValueAtTime(freq[0], t);
    f.frequency.exponentialRampToValueAtTime(freq[1], t + attack + decay);
  } else f.frequency.value = freq;
  const g = ctx.createGain();
  env(g.gain, t, peak, attack, decay);
  src.connect(f).connect(g).connect(out);
  src.start(t);
}
// Oscillator with an exponential pitch drop (thumps, ticks)
function tone(ctx, out, { type = 'sine', freq = 100, to = null, t = 0, peak = 1, attack = 0.001, decay = 0.1 }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  const g = ctx.createGain();
  env(g.gain, t, peak, attack, decay);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}
function saturator(ctx, amount) {
  const s = ctx.createWaveShaper();
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(amount * x) / Math.tanh(amount);
  }
  s.curve = c;
  return s;
}
const jit = (v, amt = 0.08) => v * (1 + (Math.random() * 2 - 1) * amt);

async function render(seconds, build, channels = 1) {
  const ctx = new OfflineAudioContext(channels, Math.ceil(seconds * RATE), RATE);
  build(ctx, ctx.destination);
  const buf = await ctx.startRendering();
  // Normalise to a consistent peak
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  if (peak > 0) {
    const k = 0.9 / peak;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }
  return buf;
}

// ---------- Gunshots ----------
// crack: supersonic snap; body: the bang; thump: chest punch; tail: rolling report;
// echo: slapbacks off the buildings; mech: the gun's own action
const GUNS = {
  handgun: { crack: [2200, 0.9, 0.022], body: [750, 0.9, 0.09], thump: [115, 48, 0.8, 0.1], tail: [1300, 0.32, 0.45], echo: [0.07, 0.15], mech: 0.35, drive: 3, len: 0.9 },
  smg: { crack: [2800, 0.75, 0.016], body: [950, 0.85, 0.06], thump: [95, 50, 0.55, 0.07], tail: [1500, 0.25, 0.3], echo: [0.06], mech: 0.45, drive: 2.5, len: 0.6 },
  rifle: { crack: [1900, 1, 0.03], body: [560, 1, 0.12], thump: [135, 42, 1, 0.14], tail: [950, 0.4, 0.75], echo: [0.08, 0.17, 0.3], mech: 0.3, drive: 3.5, len: 1.2 },
  sniper: { crack: [1600, 1, 0.042], body: [420, 1, 0.18], thump: [150, 34, 1, 0.26], tail: [720, 0.5, 1.7], echo: [0.11, 0.24, 0.42, 0.65], mech: 0.2, drive: 4, len: 2.4 },
};
function gunshot(name) {
  const p = GUNS[name];
  return render(p.len, (ctx, out) => {
    const bus = ctx.createGain();
    const sat = saturator(ctx, p.drive);
    bus.connect(sat).connect(out);
    noise(ctx, bus, { type: 'highpass', freq: jit(p.crack[0]), peak: p.crack[1], attack: 0.0004, decay: jit(p.crack[2]) });
    noise(ctx, bus, { type: 'bandpass', freq: jit(p.body[0]), q: 0.7, peak: p.body[1], attack: 0.001, decay: jit(p.body[2]) });
    tone(ctx, bus, { freq: jit(p.thump[0]), to: p.thump[1], peak: p.thump[2], attack: 0.002, decay: jit(p.thump[3]) });
    noise(ctx, bus, { type: 'lowpass', freq: jit(p.tail[0]), q: 0.5, t: 0.004, peak: p.tail[1], attack: 0.01, decay: jit(p.tail[2], 0.12) });
    p.echo.forEach((d, i) => noise(ctx, bus, {
      type: 'lowpass', freq: jit(p.tail[0] * 0.8), q: 0.4, t: jit(d, 0.15), peak: p.tail[1] * 0.45 / (i + 1), attack: 0.004, decay: jit(0.14 + i * 0.05),
    }));
    noise(ctx, out, { type: 'highpass', freq: 5000, peak: p.mech, attack: 0.0004, decay: 0.006 });
  });
}

// ---------- Gun mechanics ----------
const click = (ctx, out, t, peak = 0.6, freq = 3500) => noise(ctx, out, { type: 'highpass', freq: jit(freq), t, peak, attack: 0.0003, decay: jit(0.008) });
const scrape = (ctx, out, t, dur, peak = 0.25, freq = 1800) => noise(ctx, out, { type: 'bandpass', freq: [jit(freq), jit(freq * 1.6)], q: 1.2, t, peak, attack: 0.01, decay: dur });
const MECH = {
  magOut: (ctx, out) => { click(ctx, out, 0, 0.7); scrape(ctx, out, 0.01, 0.07, 0.3); },
  magIn: (ctx, out) => { scrape(ctx, out, 0, 0.05, 0.25); click(ctx, out, 0.05, 1, 2800); tone(ctx, out, { freq: 190, to: 120, t: 0.05, peak: 0.5, decay: 0.04 }); },
  rack: (ctx, out) => { click(ctx, out, 0, 0.5); scrape(ctx, out, 0.01, 0.06, 0.3, 1500); click(ctx, out, 0.11, 1, 2600); tone(ctx, out, { freq: 210, to: 140, t: 0.11, peak: 0.4, decay: 0.04 }); },
  bolt: (ctx, out) => {
    click(ctx, out, 0, 0.6); scrape(ctx, out, 0.03, 0.09, 0.3, 1400); click(ctx, out, 0.16, 0.7);
    scrape(ctx, out, 0.22, 0.08, 0.3, 1700); click(ctx, out, 0.33, 1, 2500); click(ctx, out, 0.42, 0.5);
  },
  dry: (ctx, out) => click(ctx, out, 0, 1, 4200),
};

// ---------- Body and feet ----------
const BODY = {
  step: (ctx, out) => {
    noise(ctx, out, { type: 'bandpass', freq: jit(1100, 0.2), q: 1, peak: 0.55, attack: 0.002, decay: jit(0.035) });
    tone(ctx, out, { freq: jit(85), to: 55, peak: 0.6, attack: 0.002, decay: 0.05 });
    noise(ctx, out, { type: 'bandpass', freq: jit(2300, 0.2), q: 1, t: jit(0.035, 0.3), peak: 0.35, attack: 0.001, decay: 0.025 });
    noise(ctx, out, { type: 'highpass', freq: 4500, t: 0.01, peak: 0.08, attack: 0.005, decay: 0.06 }); // grit
  },
  land: (ctx, out) => {
    tone(ctx, out, { freq: 75, to: 38, peak: 1, attack: 0.002, decay: 0.16 });
    noise(ctx, out, { type: 'lowpass', freq: 700, peak: 0.7, attack: 0.002, decay: 0.12 });
    noise(ctx, out, { type: 'highpass', freq: 3500, t: 0.01, peak: 0.12, attack: 0.004, decay: 0.08 });
  },
  jump: (ctx, out) => {
    noise(ctx, out, { type: 'bandpass', freq: [jit(450), jit(1400)], q: 0.9, peak: 0.35, attack: 0.03, decay: 0.18 });
    noise(ctx, out, { type: 'bandpass', freq: 1800, q: 1, peak: 0.3, attack: 0.001, decay: 0.03 }); // push-off scuff
  },
  double: (ctx, out) => noise(ctx, out, { type: 'bandpass', freq: [jit(700), jit(2200)], q: 0.9, peak: 0.4, attack: 0.02, decay: 0.2 }),
  wall: (ctx, out) => {
    noise(ctx, out, { type: 'bandpass', freq: jit(1500), q: 1, peak: 0.6, attack: 0.001, decay: 0.04 });
    tone(ctx, out, { freq: 130, to: 80, peak: 0.5, decay: 0.05 });
    noise(ctx, out, { type: 'bandpass', freq: [800, 2000], q: 0.9, t: 0.02, peak: 0.25, attack: 0.02, decay: 0.15 });
  },
  mantle: (ctx, out) => {
    noise(ctx, out, { type: 'bandpass', freq: jit(1300), q: 1, peak: 0.5, attack: 0.001, decay: 0.04 });
    noise(ctx, out, { type: 'bandpass', freq: [600, 1500], q: 0.9, t: 0.05, peak: 0.3, attack: 0.03, decay: 0.2 });
  },
  slideStart: (ctx, out) => noise(ctx, out, { type: 'bandpass', freq: [1800, 900], q: 0.8, peak: 0.6, attack: 0.005, decay: 0.25 }),
  whoosh: (ctx, out) => noise(ctx, out, { type: 'bandpass', freq: [jit(600), jit(2800)], q: 1.1, peak: 0.6, attack: 0.03, decay: 0.12 }),
  hurt: (ctx, out) => {
    tone(ctx, out, { freq: 95, to: 50, peak: 1, decay: 0.12 });
    noise(ctx, out, { type: 'lowpass', freq: 450, peak: 0.6, decay: 0.1 });
  },
};
const UI = {
  hit: (ctx, out) => { tone(ctx, out, { freq: 2100, peak: 0.6, decay: 0.035 }); tone(ctx, out, { freq: 3150, peak: 0.25, decay: 0.025 }); },
  headshot: (ctx, out) => { tone(ctx, out, { freq: 2600, peak: 0.7, decay: 0.22 }); tone(ctx, out, { freq: 3900, peak: 0.4, decay: 0.15 }); tone(ctx, out, { freq: 5300, peak: 0.15, decay: 0.08 }); },
  kill: (ctx, out) => { tone(ctx, out, { type: 'triangle', freq: 660, peak: 0.6, decay: 0.12 }); tone(ctx, out, { type: 'triangle', freq: 990, t: 0.07, peak: 0.6, decay: 0.18 }); },
  heal: (ctx, out) => { tone(ctx, out, { freq: 620, to: 880, peak: 0.5, attack: 0.01, decay: 0.25 }); tone(ctx, out, { freq: 1240, t: 0.08, peak: 0.25, decay: 0.25 }); },
};

// Looping slide scrape: gritty band-limited noise with a grainy wobble (seamless loop)
function slideLoop() {
  const n = RATE;
  const buf = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: RATE });
  const d = buf.getChannelData(0);
  let lp = 0;
  let slow = 0;
  let grain = 0.6;
  for (let i = 0; i < n; i++) {
    lp += (Math.random() * 2 - 1 - lp) * 0.25;   // soften the hiss
    slow += (lp - slow) * 0.01;                  // remove rumble
    if (i % 220 === 0) grain = 0.45 + Math.random() * 0.55; // gritty texture
    d[i] = (lp - slow) * grain;
  }
  // Crossfade the ends so the loop has no click
  const fade = 2000;
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[n - fade + i] = d[n - fade + i] * (1 - k) + d[i] * k;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  for (let i = 0; i < n; i++) d[i] *= 0.8 / peak;
  return buf;
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.buffers = {};
    this.listenerPos = { x: 0, y: 0, z: 0 };
    this.world = null;
    this.player = null;
    this.voices = 0;
  }

  // Must run inside a user gesture (click / key) for browsers to allow audio
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const c = this.ctx;
    this.master = c.createGain();
    // Gentle bus compression keeps gunfire punchy without clipping
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.002;
    comp.release.value = 0.15;
    this.master.connect(comp).connect(c.destination);
    this.sfx = c.createGain();
    this.music = c.createGain();
    this.music.gain.value = 0;
    this.sfx.connect(this.master);
    this.music.connect(this.master);
    this.applyVolumes();
    onSettingsChange(() => this.applyVolumes());
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend(); else this.ctx.resume();
    });
    this.build().catch((e) => console.warn('Sound failed to build', e));
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.sfx.gain.setTargetAtTime(settings.sfxVol, t, 0.05);
    this.musicLevel = 0.2 * settings.musicVol; // really soft
    if (this.musicOn) this.music.gain.setTargetAtTime(this.musicLevel, t, 0.3);
  }

  async build() {
    const b = this.buffers;
    const many = async (fn) => Promise.all(Array.from({ length: VARIANTS }, fn));
    for (const name of Object.keys(GUNS)) b[`shot_${name}`] = await many(() => gunshot(name));
    for (const [k, fn] of Object.entries(MECH)) b[k] = await many(() => render(k === 'bolt' ? 0.6 : 0.25, fn));
    for (const [k, fn] of Object.entries(BODY)) b[k] = await many(() => render(k === 'land' ? 0.3 : 0.4, fn));
    for (const [k, fn] of Object.entries(UI)) b[k] = [await render(0.4, fn)];
    b.slideLoop = slideLoop();
    this.ready = true;
    this.listen();
    // The beat takes a moment longer to render; it fades in when ready
    this.beat = await composeBeat(RATE);
    this.startMusic();
  }

  startMusic() {
    if (!this.beat || this.musicSrc) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.beat;
    src.loop = true;
    src.connect(this.music);
    src.start();
    this.musicSrc = src;
    this.setMusic(this.wantMusic ?? true);
  }

  // Music plays during matches; quieter still in the menu
  setMusic(playing) {
    this.wantMusic = playing;
    if (!this.ctx) return;
    this.musicOn = true;
    const level = playing ? this.musicLevel : this.musicLevel * 0.5;
    this.music.gain.setTargetAtTime(level, this.ctx.currentTime, 0.8);
  }

  pick(name) {
    const list = this.buffers[name];
    return list ? list[(Math.random() * list.length) | 0] : null;
  }

  // Play `name`. Without `pos` it's your own (in your head); with `pos` it comes from
  // there, quieter and duller with distance and through walls.
  play(name, { pos = null, gain = 1, rate = 1, delay = 0, maxDist = 120, ref = 4, cheap = false } = {}) {
    if (!this.ready || this.voices > 40) return null;
    const buf = this.pick(name);
    if (!buf) return null;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (1 + (Math.random() - 0.5) * 0.04);
    let node = src;
    if (pos) {
      const L = this.listenerPos;
      const dist = Math.hypot(pos.x - L.x, pos.y - L.y, pos.z - L.z);
      if (dist > maxDist) return null;
      let cutoff = Math.min(20000, 18000 * Math.pow(ref / Math.max(ref, dist), 0.9));
      // Something solid in between: muffled and a bit quieter
      if (this.world && dist > 1) {
        const from = _from.set(L.x, L.y, L.z);
        const dir = _dir.set(pos.x - L.x, pos.y + 1 - L.y, pos.z - L.z);
        const len = dir.length();
        dir.divideScalar(len);
        if (this.world.raycastWorld(from, dir, len) < len - 0.5) {
          cutoff = Math.min(cutoff, 900);
          gain *= 0.55;
        }
      }
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = Math.max(500, cutoff);
      node.connect(f);
      node = f;
      const g = c.createGain();
      g.gain.value = gain;
      node.connect(g);
      node = g;
      const p = c.createPanner();
      p.panningModel = cheap ? 'equalpower' : 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = ref;
      p.rolloffFactor = 1.1;
      p.maxDistance = maxDist;
      p.positionX.value = pos.x;
      p.positionY.value = pos.y + 1;
      p.positionZ.value = pos.z;
      node.connect(p);
      node = p;
    } else {
      const g = c.createGain();
      g.gain.value = gain;
      node.connect(g);
      node = g;
    }
    node.connect(this.sfx);
    this.voices++;
    src.onended = () => { this.voices--; };
    src.start(c.currentTime + delay);
    return src;
  }

  // Each frame: the listener is the camera
  update(camera, player) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    const p = camera.getWorldPosition(this._p || (this._p = camera.position.clone()));
    const f = camera.getWorldDirection(this._f || (this._f = camera.position.clone()));
    this.listenerPos.x = p.x; this.listenerPos.y = p.y; this.listenerPos.z = p.z;
    if (L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setTargetAtTime(p.x, t, 0.01);
      L.positionY.setTargetAtTime(p.y, t, 0.01);
      L.positionZ.setTargetAtTime(p.z, t, 0.01);
      L.forwardX.setTargetAtTime(f.x, t, 0.01);
      L.forwardY.setTargetAtTime(f.y, t, 0.01);
      L.forwardZ.setTargetAtTime(f.z, t, 0.01);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
    // Slide scrape follows your slide speed
    if (this.ready && player) {
      const sliding = player.sliding && player.onGround && !player.dead;
      if (sliding && !this.slideSrc) {
        const s = this.ctx.createBufferSource();
        s.buffer = this.buffers.slideLoop;
        s.loop = true;
        const f2 = this.ctx.createBiquadFilter();
        f2.type = 'bandpass';
        f2.frequency.value = 1100;
        f2.Q.value = 0.6;
        const g = this.ctx.createGain();
        g.gain.value = 0;
        s.connect(f2).connect(g).connect(this.sfx);
        s.start();
        this.slideSrc = { s, g, f: f2 };
      }
      if (this.slideSrc) {
        const hs = Math.hypot(player.velocity.x, player.velocity.z);
        const t = this.ctx.currentTime;
        this.slideSrc.g.gain.setTargetAtTime(sliding ? Math.min(0.5, hs / 22) : 0, t, sliding ? 0.03 : 0.08);
        this.slideSrc.f.frequency.setTargetAtTime(700 + hs * 70, t, 0.05);
        if (!sliding) {
          const old = this.slideSrc;
          this.slideSrc = null;
          old.s.stop(t + 0.4);
        }
      }
    }
  }

  // Game events -> sounds
  listen() {
    const me = (c) => c === this.player;
    on('shot', (owner, spec) => {
      const name = `shot_${spec.name}`;
      if (me(owner)) {
        this.play(name, { gain: spec.name === 'smg' ? 0.55 : 0.7 });
        if (spec.name === 'sniper') this.play('bolt', { gain: 0.5, delay: 0.55 });
      } else {
        this.play(name, { pos: owner.position, gain: 0.9, ref: 6, maxDist: 250 });
      }
    });
    on('reload', (owner, spec) => {
      const T = spec.reloadTime;
      const opts = me(owner) ? { gain: 0.5 } : { pos: owner.position, gain: 0.35, ref: 2, maxDist: 25, cheap: true };
      this.play('magOut', { ...opts, delay: T * 0.2 });
      this.play('magIn', { ...opts, delay: T * 0.68 });
      this.play(spec.name === 'sniper' ? 'bolt' : 'rack', { ...opts, delay: T * 0.84 });
    });
    on('dry', (owner) => { if (me(owner)) this.play('dry', { gain: 0.5 }); });
    on('slash', (owner) => { if (me(owner)) this.play('whoosh', { gain: 0.45 }); });
    on('step', (c, hs, crouch) => {
      const g = (crouch ? 0.35 : hs > 8.5 ? 1 : 0.7);
      if (me(c)) this.play('step', { gain: 0.32 * g, rate: crouch ? 0.9 : 1 });
      // Enemy footsteps: audible and placeable, but not loud; out of earshot past ~32 m
      else if (!c.dead) this.play('step', { pos: c.position, gain: 0.55 * g, ref: 2.5, maxDist: 32, cheap: true });
    });
    on('jump', (c, kind) => {
      const name = kind === 'wall' ? 'wall' : kind === 'mantle' ? 'mantle' : kind === 'double' ? 'double' : 'jump';
      if (me(c)) this.play(name, { gain: 0.45 });
      else this.play(name, { pos: c.position, gain: 0.4, ref: 2.5, maxDist: 28, cheap: true });
    });
    on('land', (c, fall) => {
      if (fall < 4) return;
      const g = Math.min(1, 0.3 + fall / 20);
      if (me(c)) this.play('land', { gain: 0.6 * g });
      else this.play('land', { pos: c.position, gain: 0.5 * g, ref: 2.5, maxDist: 30, cheap: true });
    });
    on('slide', (c) => {
      if (me(c)) this.play('slideStart', { gain: 0.4 });
      else this.play('slideStart', { pos: c.position, gain: 0.35, ref: 2.5, maxDist: 25, cheap: true });
    });
    on('hurt', (c, dealt) => { if (me(c) && dealt > 0) this.play('hurt', { gain: 0.5 }); });
  }

  // Feedback for your own hits (called from the game)
  hit(headshot) { this.play(headshot ? 'headshot' : 'hit', { gain: headshot ? 0.35 : 0.3 }); }
  kill() { this.play('kill', { gain: 0.35, delay: 0.05 }); }
  heal() { this.play('heal', { gain: 0.4 }); }
}
