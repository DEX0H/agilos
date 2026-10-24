// Background beat: an original, slow, dusty mid-90s East Coast style loop, made in code.
// Boom-bap drums with lazy swing, a deep bass, a dark detuned piano on a minor
// progression with an uneasy half-step on top, and vinyl crackle, all rolled off like an
// old sampler. 8 bars at 86 BPM, rendered once and looped.

const BPM = 86;
const BARS = 8;
const STEP = 60 / BPM / 4;          // a 16th note
const SWING = 0.2;                  // late off-beat 16ths
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Chords (MIDI notes), two bars each: F#m, Dmaj7, Bm(add9), C#m. The top line leans on a
// minor second for that uneasy feel.
const CHORDS = [
  [54, 57, 61],        // F#3 A3 C#4
  [50, 54, 57, 61],    // D3 F#3 A3 C#4
  [47, 50, 54, 61],    // B2 D3 F#3 C#4
  [49, 52, 56],        // C#3 E3 G#3
];
const BASS = [30, 26, 23, 25];      // F#1 D1 B0 C#1 (played an octave up below)
const TOP = [[73, 74], [73, 74], [71, 73], [68, 69]]; // C#5 D5 / B4 C#5 / G#4 A4

// 16-step drum patterns, two alternating bars
const KICK = [[0, 7, 10], [0, 2, 10, 13]];
const SNARE = [[4, 12], [4, 12, 15]];
const HATS = [0, 2, 4, 6, 8, 10, 12, 14];

function swingTime(bar, step) {
  return (bar * 16 + step) * STEP + (step % 2 ? SWING * STEP : 0);
}

function noiseBuf(ctx, seconds) {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

export async function composeBeat(rate) {
  const len = BARS * 16 * STEP;
  const ctx = new OfflineAudioContext(2, Math.ceil(len * rate), rate);
  const out = ctx.destination;

  // Mix bus: sampler-style roll-off and a little saturation
  const bus = ctx.createGain();
  bus.gain.value = 0.8;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 4200;
  lp.Q.value = 0.5;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 32;
  const sat = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6); }
  sat.curve = curve;
  bus.connect(sat).connect(lp).connect(hp).connect(out);

  // Room: a short generated reverb for snare and keys
  const ir = ctx.createBuffer(2, Math.ceil(1.6 * rate), rate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
  }
  const verb = ctx.createConvolver();
  verb.buffer = ir;
  const verbGain = ctx.createGain();
  verbGain.gain.value = 0.22;
  verb.connect(verbGain).connect(bus);

  const env = (g, t, peak, a, d) => {
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + a);
    g.exponentialRampToValueAtTime(0.0001, t + a + d);
  };
  const pan = (v) => { const p = ctx.createStereoPanner(); p.pan.value = v; return p; };

  const kick = (t, v) => {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(115, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
    const g = ctx.createGain();
    env(g.gain, t, 0.95 * v, 0.003, 0.38);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + 0.5);
    const n = ctx.createBufferSource();
    n.buffer = noiseBuf(ctx, 0.05);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1800;
    const g2 = ctx.createGain();
    env(g2.gain, t, 0.25 * v, 0.001, 0.02);
    n.connect(f).connect(g2).connect(bus);
    n.start(t);
  };
  const snare = (t, v) => {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuf(ctx, 0.35);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1700;
    f.Q.value = 0.6;
    const g = ctx.createGain();
    env(g.gain, t, 0.55 * v, 0.002, 0.2);
    n.connect(f).connect(g);
    g.connect(bus);
    g.connect(verb);
    n.start(t);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    const g2 = ctx.createGain();
    env(g2.gain, t, 0.35 * v, 0.001, 0.09);
    o.connect(g2).connect(bus);
    o.start(t);
    o.stop(t + 0.2);
  };
  const hat = (t, v, open = false) => {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuf(ctx, open ? 0.3 : 0.06);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 6500;
    const g = ctx.createGain();
    env(g.gain, t, (open ? 0.16 : 0.13) * v, 0.001, open ? 0.22 : 0.035);
    n.connect(f).connect(g).connect(pan(0.25)).connect(bus);
    n.start(t);
  };
  const bass = (t, note, dur) => {
    const o = ctx.createOscillator();
    o.frequency.value = midi(note + 12);
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = midi(note + 24);
    const g = ctx.createGain();
    env(g.gain, t, 0.5, 0.01, dur);
    const g2 = ctx.createGain();
    g2.gain.value = 0.15;
    o.connect(g).connect(bus);
    o2.connect(g2).connect(g);
    o.start(t);
    o2.start(t);
    o.stop(t + dur + 0.1);
    o2.stop(t + dur + 0.1);
  };
  // Piano-ish: a few decaying harmonics, two slightly detuned voices, soft attack
  const piano = (t, note, v, dur = 1.8, side = 0) => {
    const f0 = midi(note);
    const g = ctx.createGain();
    env(g.gain, t, 0.09 * v, 0.006, dur);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2200;
    g.connect(tone);
    const p = pan(side);
    tone.connect(p);
    p.connect(bus);
    p.connect(verb);
    for (const [h, a] of [[1, 1], [2, 0.45], [3, 0.22], [4, 0.12], [5, 0.06]]) {
      for (const det of [-4, 4]) {
        const o = ctx.createOscillator();
        o.frequency.value = f0 * h;
        o.detune.value = det;
        const hg = ctx.createGain();
        env(hg.gain, t, a, 0.004, dur / (0.7 + h * 0.4));
        o.connect(hg).connect(g);
        o.start(t);
        o.stop(t + dur + 0.1);
      }
    }
  };

  for (let bar = 0; bar < BARS; bar++) {
    const v = bar % 2;
    const chordIdx = Math.floor(bar / 2) % 4;
    for (const s of KICK[v]) kick(swingTime(bar, s), s === 0 ? 1 : 0.8);
    for (const s of SNARE[v]) snare(swingTime(bar, s), s === 15 ? 0.35 : 1);
    for (const s of HATS) hat(swingTime(bar, s), s % 4 === 0 ? 1 : 0.65, bar === 7 && s === 14);
    if (bar % 4 === 3) hat(swingTime(bar, 15), 0.4);
    // Bass on the kicks
    for (const s of KICK[v]) bass(swingTime(bar, s), BASS[chordIdx], s === 0 ? 0.6 : 0.3);
    // Chords: on the one of the first bar of each pair, a softer restrike in the second
    const chord = CHORDS[chordIdx];
    const strike = bar % 2 === 0 ? 0 : 8;
    chord.forEach((n, i) => piano(swingTime(bar, strike), n, bar % 2 ? 0.6 : 1, 2.2, (i - 1) * 0.2));
    // Uneasy top line in the second bar of each pair
    if (bar % 2 === 1) {
      const [a, b] = TOP[chordIdx];
      piano(swingTime(bar, 2), a, 0.7, 1.2, 0.3);
      piano(swingTime(bar, 6), b, 0.6, 1.5, 0.3);
    }
  }

  // Vinyl: crackle and hiss
  const vinyl = ctx.createBufferSource();
  const vb = ctx.createBuffer(2, Math.ceil(len * rate), rate);
  for (let c = 0; c < 2; c++) {
    const d = vb.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      let s = (Math.random() * 2 - 1) * 0.004;
      if (Math.random() < 0.00035) s += (Math.random() * 2 - 1) * 0.35;
      d[i] = s;
    }
  }
  vinyl.buffer = vb;
  const vf = ctx.createBiquadFilter();
  vf.type = 'bandpass';
  vf.frequency.value = 2500;
  vf.Q.value = 0.4;
  vinyl.connect(vf).connect(out);
  vinyl.start(0);

  const buf = await ctx.startRendering();
  // Normalise, and fade the loop seam a touch so it repeats cleanly
  let peak = 0;
  for (let c = 0; c < 2; c++) for (const s of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(s));
  const k = peak > 0 ? 0.85 / peak : 1;
  const fade = Math.floor(0.01 * rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
    for (let i = 0; i < fade; i++) { d[i] *= i / fade; d[d.length - 1 - i] *= i / fade; }
  }
  return buf;
}
