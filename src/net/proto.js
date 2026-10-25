import { HANDGUN, SMG, RIFLE, SNIPER } from '../gun.js';

// Binary messages on the fast (unreliable) channel. Little-endian DataView throughout.
//
// Input (player -> host), sent every frame with the last few inputs repeated so a lost
// packet costs nothing:
//   u8 type=1, u8 count, then per input (36 bytes):
//   u32 seq, f32 dt, i8 forward, i8 strafe, u16 buttons, u8 fires, u8 pad,
//   f32 yaw, f32 pitch, f32 aimYaw, f32 aimPitch, f32 renderTime
//
// Snapshot (host -> player), 30 a second:
//   header: u8 type=2, f32 hostTime, u32 ackSeq, u8 you, u8 matchState, f32 matchTimer,
//   f32 cx, cz, r, toX, toZ, toR, phaseTime, u8 phase, u8 shrinking, u8 tick, u8 total,
//   u16 ammo, u16 reserve (65535 = unlimited), f32 reloadTimer, u8 lastAttacker, u8 count
//   per player (30 bytes): u8 id, u16 flags, f32 x, y, z, i16 vx, vy, vz (cm/s),
//   i16 yaw, i16 pitch (1/10000 rad), u8 health, u8 weapon, u8 shield (0.1 s), u8 state

export const MSG_INPUT = 1;
export const MSG_SNAP = 2;
export const WEAPONS = [HANDGUN, SMG, RIFLE, SNIPER];
export const weaponIndex = (spec) => Math.max(0, WEAPONS.indexOf(spec));
export const STATES = ['ground', 'air', 'crouch', 'slide', 'wall', 'climb', 'mantle', 'dead'];
export const MATCH_STATES = ['warmup', 'countdown', 'live', 'over'];
export const NONE = 255;

export const BTN = {
  sprint: 1, crouch: 2, jump: 4, jumpHeld: 8, crouchPressed: 16, reload: 32, use: 64,
  knife: 128, slash: 256, aiming: 512, scoped: 1024,
};
export const FLAG = {
  dead: 1, onGround: 2, sliding: 4, crouch: 8, frozen: 16, combat: 32, reloading: 64, knife: 128, shielded: 256,
};

const INPUT_BYTES = 36;
export const MAX_REDUNDANT = 4;

export function encodeInputs(list) {
  const n = Math.min(list.length, MAX_REDUNDANT);
  const buf = new ArrayBuffer(2 + n * INPUT_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG_INPUT);
  v.setUint8(1, n);
  let o = 2;
  for (let i = list.length - n; i < list.length; i++) {
    const p = list[i];
    v.setUint32(o, p.seq, true);
    v.setFloat32(o + 4, p.dt, true);
    v.setInt8(o + 8, Math.round(p.forward));
    v.setInt8(o + 9, Math.round(p.strafe));
    v.setUint16(o + 10, p.buttons, true);
    v.setUint8(o + 12, Math.min(255, p.fires));
    v.setFloat32(o + 16, p.yaw, true);
    v.setFloat32(o + 20, p.pitch, true);
    v.setFloat32(o + 24, p.aimYaw, true);
    v.setFloat32(o + 28, p.aimPitch, true);
    v.setFloat32(o + 32, p.rt, true);
    o += INPUT_BYTES;
  }
  return buf;
}

const clamp = (x, a, b) => (Number.isFinite(x) ? Math.max(a, Math.min(b, x)) : a);
const MAX_PITCH = Math.PI / 2;

// Everything from the network is checked: sizes, ranges, finite numbers. Bad input is dropped.
export function decodeInputs(buf) {
  if (buf.byteLength < 2) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG_INPUT) return null;
  const n = v.getUint8(1);
  if (n < 1 || n > MAX_REDUNDANT || buf.byteLength !== 2 + n * INPUT_BYTES) return null;
  const out = [];
  let o = 2;
  for (let i = 0; i < n; i++) {
    const dt = v.getFloat32(o + 4, true);
    if (!(dt > 0 && dt <= 0.1)) return null;
    const b = v.getUint16(o + 10, true);
    const yaw = v.getFloat32(o + 16, true);
    const aimYaw = v.getFloat32(o + 24, true);
    if (!Number.isFinite(yaw) || !Number.isFinite(aimYaw) || Math.abs(yaw) > 1e5 || Math.abs(aimYaw) > 1e5) return null;
    out.push({
      seq: v.getUint32(o, true),
      dt,
      forward: clamp(v.getInt8(o + 8), -1, 1),
      strafe: clamp(v.getInt8(o + 9), -1, 1),
      sprint: !!(b & BTN.sprint),
      crouch: !!(b & BTN.crouch),
      jump: !!(b & BTN.jump),
      jumpHeld: !!(b & BTN.jumpHeld),
      crouchPressed: !!(b & BTN.crouchPressed),
      reload: !!(b & BTN.reload),
      use: !!(b & BTN.use),
      knife: !!(b & BTN.knife),
      slash: !!(b & BTN.slash),
      aiming: !!(b & BTN.aiming),
      scoped: !!(b & BTN.scoped),
      fires: Math.min(4, v.getUint8(o + 12)),
      yaw,
      pitch: clamp(v.getFloat32(o + 20, true), -MAX_PITCH, MAX_PITCH),
      aimYaw,
      aimPitch: clamp(v.getFloat32(o + 28, true), -MAX_PITCH, MAX_PITCH),
      rt: v.getFloat32(o + 32, true),
    });
    o += INPUT_BYTES;
  }
  return out;
}

const HEADER = 64;
const PER = 30;

// The players part is the same for everyone; only the header is per receiver
export function encodePlayers(list) {
  const buf = new ArrayBuffer(list.length * PER);
  const v = new DataView(buf);
  let o = 0;
  for (const c of list) {
    let f = 0;
    if (c.dead) f |= FLAG.dead;
    if (c.onGround) f |= FLAG.onGround;
    if (c.sliding) f |= FLAG.sliding;
    if (c.height < 1.5) f |= FLAG.crouch;
    if (c.frozen) f |= FLAG.frozen;
    if (c.netCombat ?? (c.target && c.targetVisible)) f |= FLAG.combat;
    if (c.gun && c.gun.reloadTimer > 0) f |= FLAG.reloading;
    if (c.knifeOut) f |= FLAG.knife;
    if (c.shielded) f |= FLAG.shielded;
    v.setUint8(o, c.netId);
    v.setUint16(o + 1, f, true);
    v.setFloat32(o + 3, c.position.x, true);
    v.setFloat32(o + 7, c.position.y, true);
    v.setFloat32(o + 11, c.position.z, true);
    v.setInt16(o + 15, clamp(Math.round(c.velocity.x * 100), -32767, 32767), true);
    v.setInt16(o + 17, clamp(Math.round(c.velocity.y * 100), -32767, 32767), true);
    v.setInt16(o + 19, clamp(Math.round(c.velocity.z * 100), -32767, 32767), true);
    const yaw = Math.atan2(Math.sin(c.yaw), Math.cos(c.yaw));
    v.setInt16(o + 21, Math.round(yaw * 10000), true);
    v.setInt16(o + 23, Math.round(clamp(c.pitch, -1.6, 1.6) * 10000), true);
    v.setUint8(o + 25, clamp(Math.ceil(c.health), 0, 255));
    v.setUint8(o + 26, weaponIndex(c.gun ? c.gun.spec : c.netWeapon));
    v.setUint8(o + 27, clamp(Math.ceil(c.shieldTimer * 10), 0, 255));
    v.setUint8(o + 28, Math.max(0, STATES.indexOf(c.dead ? 'dead' : c.state)));
    o += PER;
  }
  return buf;
}

export function encodeSnapshot(h, players) {
  const buf = new ArrayBuffer(HEADER + players.byteLength);
  const v = new DataView(buf);
  const z = h.zone;
  v.setUint8(0, MSG_SNAP);
  v.setFloat32(1, h.time, true);
  v.setUint32(5, h.ack >>> 0, true);
  v.setUint8(9, h.you);
  v.setUint8(10, Math.max(0, MATCH_STATES.indexOf(h.state)));
  v.setFloat32(11, h.timer, true);
  [z.cx, z.cz, z.r, z.toX, z.toZ, z.toR, z.phaseTime].forEach((x, i) => v.setFloat32(15 + i * 4, x, true));
  v.setUint8(43, z.phase);
  v.setUint8(44, z.shrinking ? 1 : 0);
  v.setUint8(45, clamp(z.tick, 0, 255));
  v.setUint8(46, h.total);
  v.setUint16(47, clamp(h.ammo, 0, 65534), true);
  v.setUint16(49, h.reserve === Infinity ? 65535 : clamp(h.reserve, 0, 65534), true);
  v.setFloat32(51, h.reloadTimer, true);
  v.setUint8(55, h.lastAttacker);
  v.setUint8(56, players.byteLength / PER);
  new Uint8Array(buf, HEADER).set(new Uint8Array(players));
  return buf;
}

export function decodeSnapshot(buf) {
  if (buf.byteLength < HEADER) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG_SNAP) return null;
  const n = v.getUint8(56);
  if (buf.byteLength !== HEADER + n * PER) return null;
  const f = (o) => v.getFloat32(o, true);
  const s = {
    time: f(1),
    ack: v.getUint32(5, true),
    you: v.getUint8(9),
    state: MATCH_STATES[v.getUint8(10)] || 'warmup',
    timer: f(11),
    zone: {
      cx: f(15), cz: f(19), r: f(23), toX: f(27), toZ: f(31), toR: f(35), phaseTime: f(39),
      phase: v.getUint8(43), shrinking: v.getUint8(44) === 1, tick: v.getUint8(45),
    },
    total: v.getUint8(46),
    ammo: v.getUint16(47, true),
    reserve: v.getUint16(49, true) === 65535 ? Infinity : v.getUint16(49, true),
    reloadTimer: f(51),
    lastAttacker: v.getUint8(55),
    players: [],
  };
  let o = HEADER;
  for (let i = 0; i < n; i++) {
    const fl = v.getUint16(o + 1, true);
    s.players.push({
      id: v.getUint8(o),
      dead: !!(fl & FLAG.dead),
      onGround: !!(fl & FLAG.onGround),
      sliding: !!(fl & FLAG.sliding),
      crouch: !!(fl & FLAG.crouch),
      frozen: !!(fl & FLAG.frozen),
      combat: !!(fl & FLAG.combat),
      reloading: !!(fl & FLAG.reloading),
      knife: !!(fl & FLAG.knife),
      shielded: !!(fl & FLAG.shielded),
      x: f(o + 3), y: f(o + 7), z: f(o + 11),
      vx: v.getInt16(o + 15, true) / 100, vy: v.getInt16(o + 17, true) / 100, vz: v.getInt16(o + 19, true) / 100,
      yaw: v.getInt16(o + 21, true) / 10000,
      pitch: v.getInt16(o + 23, true) / 10000,
      health: v.getUint8(o + 25),
      weapon: WEAPONS[v.getUint8(o + 26)] || HANDGUN,
      shield: v.getUint8(o + 27) / 10,
      state: STATES[v.getUint8(o + 28)] || 'ground',
    });
    o += PER;
  }
  for (const p of s.players) {
    if (![p.x, p.y, p.z].every(Number.isFinite)) return null;
  }
  return s;
}
