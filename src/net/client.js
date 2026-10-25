import * as THREE from 'three';
import { Peer, STUN } from './peer.js';
import { Puppet } from './actors.js';
import { encodeInputs, decodeSnapshot, BTN, WEAPONS, NONE, MAX_REDUNDANT } from './proto.js';
import { emit, mute } from '../events.js';
import { NO_INPUT } from '../character.js';
import { KINDS } from '../pickups.js';

// A joining player's side: sends inputs, draws what the host says happened.
//
// Your own movement is predicted: your game moves you at once with the same code the host
// runs, remembers each input, and when a snapshot says where the host has you after input
// N, checks its own record for N. If they disagree it takes the host's position and
// replays the inputs since. Everyone else is drawn 100 ms in the past, between the two
// snapshots around that moment, so they move smoothly.

const INTERP = 0.1;
const CORRECT = 0.2;        // metres of disagreement before correcting
const SNAP_KEEP = 40;
const HISTORY_KEEP = 240;

const COLOUR_RE = /^#[0-9a-fA-F]{6}$/;
const lerpAngle = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

export class NetClient {
  constructor(game, signal, me, iceServers = STUN) {
    this.game = game;
    this.signal = signal;
    this.me = me;
    this.iceServers = iceServers;
    this.peer = null;
    this.lobby = null;          // latest lobby info from the host
    this.onChange = null;
    this.onLeave = null;        // (reason) => void
    this.ready = false;
    this.inMatch = false;
    this.you = NONE;
    this.ents = new Map();      // id -> combatant (puppets and you)
    this.snaps = [];
    this.offset = null;         // host clock - local clock, seconds
    this.seq = 0;
    this.history = [];
    this.lastAck = 0;
    this.pending = { fires: 0, aimYaw: 0, aimPitch: 0, reload: false, use: false, slash: false };
    this.closed = false;
    // Testing only: ?debug&lag=50 delays everything 50 ms each way (100 ms ping)
    const q = new URLSearchParams(location.search);
    this.lag = import.meta.env.DEV && q.has('debug') ? Math.max(0, Math.min(500, Number(q.get('lag')) || 0)) : 0;
  }

  later(fn) {
    if (this.lag) setTimeout(fn, this.lag);
    else fn();
  }

  async join(code) {
    const { peer, offer } = await Peer.offer(this.iceServers);
    this.peer = peer;
    peer.onEvent = (msg) => this.later(() => this.onEvent(msg));
    peer.onState = (buf) => this.later(() => this.onState(buf));
    const opened = new Promise((resolve, reject) => {
      peer.onOpen = resolve;
      setTimeout(() => reject(Object.assign(new Error('Could not reach the host.'), { code: 'unreachable' })), 15000);
    });
    opened.catch(() => {}); // awaited below; don't report it twice
    peer.onClose = () => this.leave(this.inMatch ? 'The host left the match.' : 'Disconnected from the lobby.');
    const answer = await this.signal.join(code, this.me, offer);
    await peer.accept(answer);
    await opened;
  }

  setReady(on) {
    this.ready = on;
    if (this.peer) this.peer.send({ t: 'ready', on });
  }

  hostNow() { return performance.now() / 1000 + (this.offset || 0); }
  renderTime() { return this.hostNow() - INTERP; }

  onEvent(msg) {
    const g = this.game;
    const ent = (id) => (Number.isInteger(id) ? this.ents.get(id) || null : null);
    const at = (list, i) => (Number.isInteger(i) && i >= 0 && i < list.length ? list[i] : null);
    switch (msg.t) {
      case 'lobby':
        this.lobby = sanitizeLobby(msg);
        if (this.onChange) this.onChange();
        break;
      case 'start': this.start(msg); break;
      case 'shot': {
        const c = ent(msg.id);
        const spec = at(WEAPONS, msg.w);
        if (c && c !== g.player && spec) {
          c.flashTimer = 0.05;
          c.shootAnim = 0.3;
          emit('shot', c, spec);
        }
        break;
      }
      case 'tr':
        if (Array.isArray(msg.a) && Array.isArray(msg.b) && msg.a.length === 3 && msg.b.length === 3 &&
            [...msg.a, ...msg.b].every((x) => Number.isFinite(x) && Math.abs(x) < 1e4)) {
          g.world.addTracer(new THREE.Vector3(...msg.a.slice(0, 3)), new THREE.Vector3(...msg.b.slice(0, 3)));
        }
        break;
      case 'slash': { const c = ent(msg.id); if (c && c !== g.player) emit('slash', c); break; }
      case 'box': {
        const box = at(g.boxes.boxes, msg.b);
        const spec = at(WEAPONS, msg.r);
        const user = ent(msg.u);
        if (!box || !spec) break;
        const mine = user === g.player;
        box.state = 'ready';
        box.spin(user, mine ? (s) => g.boxWin(s) : null, spec);
        break;
      }
      case 'kill': {
        const victim = ent(msg.v);
        if (!victim) break;
        const killer = ent(msg.k);
        victim.lastAttacker = killer;
        if (victim !== g.player) victim.dead = true;
        else g.localDied(killer);
        g.world.reportKill(killer, victim, String(msg.how || ''));
        break;
      }
      case 'ring': if (typeof msg.text === 'string') g.ringText(msg.text.slice(0, 40)); break;
      case 'pick': {
        const it = at(g.pickups.items, msg.i);
        if (!it) break;
        it.timer = KINDS[it.kind].respawn;
        if (ent(msg.id) === g.player) g.healed(it);
        break;
      }
      case 'hit': g.hitConfirm(msg.h === true); break;
      case 'over': {
        g.match.state = 'over';
        g.match.winner = ent(msg.w);
        if (g.match.winner === g.player) g.match.playerPlace = 1;
        break;
      }
      case 'kick': this.leave('You were removed from the lobby.'); break;
      case 'full': this.leave('That lobby is full.'); break;
      case 'closed': this.leave('The host closed the lobby.'); break;
      default: break;
    }
  }

  // A match begins: same map from the same seed, everyone where the host put them
  start(msg) {
    const g = this.game;
    if (!Number.isInteger(msg.lots) || msg.lots < 3 || msg.lots > 10 || !Number.isInteger(msg.seed) || !Array.isArray(msg.ents)) return;
    for (const c of this.ents.values()) if (c !== g.player) g.removeCombatant(c);
    this.ents.clear();
    this.snaps = [];
    this.history = [];
    this.lastAck = 0;
    this.you = msg.you;
    g.clientStart(msg.lots, msg.seed);
    msg.ents.slice(0, 32).forEach((e, i) => {
      if (!Number.isInteger(e.id) || ![e.x, e.y, e.z, e.yaw].every(Number.isFinite)) return;
      const pos = new THREE.Vector3(e.x, e.y, e.z);
      if (e.id === this.you) {
        g.placePlayer(pos, e.yaw);
        g.player.netId = e.id;
        this.ents.set(e.id, g.player);
        return;
      }
      const name = typeof e.name === 'string' ? e.name.slice(0, 24) : 'Player';
      const colour = COLOUR_RE.test(e.colour || '') ? e.colour : undefined;
      const p = new Puppet(g.scene, g.world, pos, i, { name, colour });
      p.netId = e.id;
      p.yaw = e.yaw;
      p.position.copy(pos);
      g.world.add(p);
      this.ents.set(e.id, p);
    });
    this.inMatch = true;
    g.clientStarted();
  }

  onState(buf) {
    const s = decodeSnapshot(buf);
    if (!s || !this.inMatch) return;
    const local = performance.now() / 1000;
    const sample = s.time - local;
    // The clock offset follows the fastest-arriving snapshots (least delayed)
    if (this.offset === null || sample > this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.02;
    if (this.snaps.length && s.time <= this.snaps[this.snaps.length - 1].time) return; // out of order
    this.snaps.push(s);
    if (this.snaps.length > SNAP_KEEP) this.snaps.shift();
    this.applyOwn(s);
  }

  // Your own state from the host: health, death, ammo, and the position check
  applyOwn(s) {
    const g = this.game;
    const p = g.player;
    const me = s.players.find((x) => x.id === this.you);
    const m = g.match;
    m.state = m.state === 'over' && s.state !== 'warmup' ? 'over' : s.state;
    m.timer = s.timer;
    Object.assign(m.zone, s.zone);
    m.total = s.total;
    if (!me) return;

    if (me.health < p.health - 0.5 && !p.dead) {
      p.damageFlash = 0.35;
      p.hitStrength = Math.min(1, (p.health - me.health) / 60);
      p.lastAttacker = this.ents.get(s.lastAttacker) || p.lastAttacker;
      emit('hurt', p, p.health - me.health, p.lastAttacker);
    }
    p.health = me.health;
    p.shieldTimer = me.shielded ? Math.max(0.1, me.shield) : 0;
    p.frozen = me.frozen;
    if (me.dead && !p.dead) g.localDied(this.ents.get(s.lastAttacker) || null);
    g.syncAmmo(me.weapon, s.ammo, s.reserve, s.reloadTimer);

    // Movement check against what we predicted for the input the host just processed
    if (p.dead || s.ack <= this.lastAck) return;
    this.lastAck = s.ack;
    const i = this.history.findIndex((h) => h.seq === s.ack);
    if (i < 0) return;
    const rec = this.history[i];
    this.history.splice(0, i + 1);
    const err = Math.hypot(rec.x - me.x, rec.y - me.y, rec.z - me.z);
    if (err < CORRECT) return;
    this.corrections = (this.corrections || 0) + 1;
    p.position.set(me.x, me.y, me.z);
    p.velocity.set(me.vx, me.vy, me.vz);
    if (err > 4) { this.history.length = 0; return; } // a teleport (spawn): no replay
    // Replay what the host hasn't seen yet, silently (the sounds already played)
    const yaw = p.yaw;
    const pitch = p.pitch;
    const aiming = p.aiming;
    const speedMult = p.speedMult;
    mute(true);
    try {
      for (const h of this.history) {
        p.yaw = h.yaw;
        p.aiming = h.aiming;
        p.speedMult = h.speedMult;
        p.simulate(h.dt, h.frozen ? NO_INPUT : h.input);
        h.x = p.position.x; h.y = p.position.y; h.z = p.position.z;
      }
    } finally {
      mute(false);
      p.yaw = yaw;
      p.pitch = pitch;
      p.aiming = aiming;
      p.speedMult = speedMult;
    }
  }

  // Shots, reloads, slashes and box use since the last input, sent with the next one
  noteFire(aimYaw, aimPitch) {
    if (this.pending.fires === 0) { this.pending.aimYaw = aimYaw; this.pending.aimPitch = aimPitch; }
    this.pending.fires++;
  }

  // Called every frame after the local player moved
  update(dt) {
    if (!this.inMatch || !this.peer || !this.peer.open) return;
    const g = this.game;
    const p = g.player;
    const rt = this.renderTime();

    // Others: interpolate between the two snapshots around render time
    const sn = this.snaps;
    if (sn.length) {
      let a = sn[0];
      let b = sn[sn.length - 1];
      for (let i = sn.length - 1; i > 0; i--) {
        if (sn[i - 1].time <= rt) { a = sn[i - 1]; b = sn[i]; break; }
      }
      const k = b.time > a.time ? Math.max(0, Math.min(1, (rt - a.time) / (b.time - a.time))) : 1;
      const prev = new Map(a.players.map((x) => [x.id, x]));
      for (const s1 of b.players) {
        const c = this.ents.get(s1.id);
        if (!c || c === p) continue;
        const s0 = prev.get(s1.id) || s1;
        c.apply({
          ...s1,
          x: s0.x + (s1.x - s0.x) * k,
          y: s0.y + (s1.y - s0.y) * k,
          z: s0.z + (s1.z - s0.z) * k,
          yaw: lerpAngle(s0.yaw, s1.yaw, k),
          pitch: s0.pitch + (s1.pitch - s0.pitch) * k,
        }, dt);
      }
    }
    for (const c of this.ents.values()) if (c !== p) c.update(dt);

    // You: send this frame's input (and the last few again, in case one was lost)
    if (p.dead || !p.lastInput) return;
    const inp = p.lastInput;
    const pend = this.pending;
    const knife = g.knifeOut();
    let buttons = 0;
    if (inp.sprint) buttons |= BTN.sprint;
    if (inp.crouch) buttons |= BTN.crouch;
    if (inp.jump) buttons |= BTN.jump;
    if (inp.jumpHeld) buttons |= BTN.jumpHeld;
    if (inp.crouchPressed) buttons |= BTN.crouchPressed;
    if (pend.reload) buttons |= BTN.reload;
    if (pend.use) buttons |= BTN.use;
    if (knife) buttons |= BTN.knife;
    if (pend.slash) buttons |= BTN.slash;
    if (p.aiming) buttons |= BTN.aiming;
    if (p.ads) buttons |= BTN.scoped;
    const aimYaw = pend.fires ? pend.aimYaw : p.yaw + p.recoilYaw;
    const aimPitch = pend.fires ? pend.aimPitch : p.pitch + p.recoilPitch;
    const rec = {
      seq: ++this.seq, dt: Math.min(0.1, Math.max(1e-4, dt)), forward: inp.forward, strafe: inp.strafe, buttons, fires: pend.fires,
      yaw: p.yaw, pitch: p.pitch, aimYaw, aimPitch, rt,
      input: inp, frozen: p.frozen, aiming: p.aiming, speedMult: p.speedMult,
      x: p.position.x, y: p.position.y, z: p.position.z,
    };
    pend.fires = 0;
    pend.reload = false;
    pend.use = false;
    pend.slash = false;
    p.lastInput = null;
    this.history.push(rec);
    if (this.history.length > HISTORY_KEEP) this.history.shift();
    const buf = encodeInputs(this.history.slice(-MAX_REDUNDANT));
    this.later(() => this.peer.sendState(buf));
  }

  leave(reason = '') {
    if (this.closed) return;
    this.closed = true;
    if (this.peer && this.peer.open) this.peer.send({ t: 'bye' });
    if (this.peer) setTimeout(() => this.peer.close(), 100);
    for (const c of this.ents.values()) if (c !== this.game.player) this.game.removeCombatant(c);
    this.ents.clear();
    this.inMatch = false;
    if (this.onLeave) this.onLeave(reason);
  }
}

function sanitizeLobby(msg) {
  const members = Array.isArray(msg.members) ? msg.members.slice(0, 16).map((m) => ({
    key: String(m.key || '').slice(0, 8),
    name: String(m.name || 'Player').slice(0, 16),
    colour: COLOUR_RE.test(m.colour || '') ? m.colour : '#5fa8ff',
    ready: m.ready === true,
    host: m.host === true,
    you: m.you === true,
    ping: Number.isFinite(m.ping) ? Math.max(0, Math.min(9999, Math.round(m.ping))) : 0,
  })) : [];
  return {
    code: String(msg.code || '').slice(0, 6),
    max: Number.isInteger(msg.max) ? msg.max : 8,
    fill: msg.fill === true,
    inMatch: msg.inMatch === true,
    members,
  };
}
