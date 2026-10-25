import { Peer, STUN } from './peer.js';
import { RemotePlayer } from './actors.js';
import { decodeInputs, encodePlayers, encodeSnapshot, weaponIndex, NONE } from './proto.js';
import { on } from '../events.js';
import { NAME_RE } from '../profile.js';

// The host's side of a lobby: accepts players, runs their characters (RemotePlayer), and
// streams snapshots and events back. The host's game is the authority for everything.

const SNAP_HZ = 30;
const HISTORY = 0.3;            // seconds of positions kept for lag compensation
const MAX_REWIND = 0.25;
const MAX_STATE_PER_SEC = 400;  // input packets per second per player before dropping
const MAX_EVENTS_PER_SEC = 20;
export const MAX_PLAYERS = 16;
const COLOUR_RE = /^#[0-9a-fA-F]{6}$/;

export class NetHost {
  constructor(game, signal, me, iceServers = STUN) {
    this.game = game;           // hooks into main.js (see main's netGame)
    this.signal = signal;
    this.me = me;               // { name, colour }
    this.iceServers = iceServers;
    this.members = [];          // { key, uid, name, colour, peer, ready, remote }
    this.settings = { max: 8, fill: true };
    this.code = null;
    this.lobby = null;
    this.onChange = null;       // lobby changed (UI)
    this.time0 = performance.now() / 1000;
    this.snapTimer = 0;
    this.history = new Map();   // combatant -> [{ t, x, y, z, h }]
    this.inMatch = false;
    this.lastState = null;
    this.nextKey = 1;
    this.unsubs = [];
    this.closed = false;
  }

  now() { return performance.now() / 1000 - this.time0; }

  async open() {
    this.lobby = await this.signal.host({ name: this.me.name, max: this.settings.max });
    this.code = this.lobby.code;
    this.lobby.onOffer = (uid, sdp, info) => this.accept(uid, sdp, info).catch((e) => console.warn('Join failed', e));
    this.listen();
    this.changed();
    this.lobbyTimer = setInterval(() => { if (!this.inMatch) this.broadcastLobby(); }, 2000);
    return this.code;
  }

  changed() {
    this.broadcastLobby();
    if (this.onChange) this.onChange();
  }

  async accept(uid, sdp, info) {
    if (this.closed || typeof sdp !== 'string' || sdp.length > 20000) return;
    const name = NAME_RE.test(info.name || '') ? info.name : 'Player';
    const colour = COLOUR_RE.test(info.colour || '') ? info.colour : '#5fa8ff';
    // The same account joining again replaces its old connection
    const old = this.members.find((m) => m.uid === uid);
    if (old) this.drop(old, false);
    const { peer, answer } = await Peer.answer(sdp, this.iceServers);
    const m = { key: `p${this.nextKey++}`, uid, name, colour, peer, ready: false, remote: null, budget: { s: 0, e: 0, t: 0 } };
    peer.onOpen = () => {
      this.lobby.done(uid);
      if (this.members.length + 1 > this.settings.max) {
        peer.send({ t: 'full' });
        setTimeout(() => peer.close(), 300);
        return;
      }
      this.members.push(m);
      this.changed();
    };
    peer.onClose = () => this.drop(m, true);
    peer.onEvent = (msg) => this.onEvent(m, msg);
    peer.onState = (buf) => this.onState(m, buf);
    await this.lobby.answer(uid, answer);
  }

  // Rate limits: a flooding connection just has its extra messages ignored
  allow(m, kind) {
    const b = m.budget;
    const t = performance.now();
    if (t - b.t > 1000) { b.t = t; b.s = 0; b.e = 0; }
    if (kind === 's') return ++b.s <= MAX_STATE_PER_SEC;
    return ++b.e <= MAX_EVENTS_PER_SEC;
  }

  onEvent(m, msg) {
    if (!this.allow(m, 'e')) return;
    if (msg.t === 'ready') {
      m.ready = msg.on === true;
      this.changed();
    } else if (msg.t === 'bye') {
      m.peer.close();
    }
  }

  onState(m, buf) {
    if (!this.allow(m, 's') || !m.remote) return;
    const inputs = decodeInputs(buf);
    if (inputs) m.remote.receive(inputs);
  }

  drop(m, notify) {
    if (m.dropped) return;
    m.dropped = true;
    const i = this.members.indexOf(m);
    if (i >= 0) this.members.splice(i, 1);
    // Mid-match, a bot takes over their character so the match stays fair
    if (m.remote) {
      if (this.inMatch && !m.remote.dead) m.remote.disconnect();
      else this.game.removeCombatant(m.remote);
      if (notify) this.game.toast(`${m.name} left`);
    }
    if (!m.peer.closed) m.peer.close();
    this.changed();
  }

  kick(key) {
    const m = this.members.find((x) => x.key === key);
    if (!m) return;
    m.peer.send({ t: 'kick' });
    setTimeout(() => this.drop(m, false), 200);
  }

  setSettings(s) {
    if (Number.isInteger(s.max)) this.settings.max = Math.max(2, Math.min(MAX_PLAYERS, s.max));
    if (typeof s.fill === 'boolean') this.settings.fill = s.fill;
    this.changed();
  }

  lobbyFor(m) {
    return {
      t: 'lobby',
      code: this.code,
      max: this.settings.max,
      fill: this.settings.fill,
      inMatch: this.inMatch,
      members: [
        { key: 'host', name: this.me.name, colour: this.me.colour, ready: true, host: true, ping: 0, you: !m },
        ...this.members.map((x) => ({ key: x.key, name: x.name, colour: x.colour, ready: x.ready, ping: Math.round(x.peer.rtt), you: x === m })),
      ],
    };
  }

  broadcastLobby() {
    for (const m of this.members) m.peer.send(this.lobbyFor(m));
  }

  send(msg, except = null) {
    for (const m of this.members) if (!except || m.remote !== except) m.peer.send(msg);
  }

  // Game events that every player needs to see or hear
  listen() {
    const g = this.game;
    const id = (c) => (c && c.netId !== undefined ? c.netId : NONE);
    const live = () => this.inMatch;
    this.unsubs.push(
      on('shot', (owner, spec) => { if (live()) this.send({ t: 'shot', id: id(owner), w: weaponIndex(spec) }, owner); }),
      on('slash', (owner) => { if (live()) this.send({ t: 'slash', id: id(owner) }, owner); }),
      on('boxSpin', (box, user) => {
        if (!live()) return;
        this.send({ t: 'box', b: g.boxes.boxes.indexOf(box), u: id(user), r: weaponIndex(box.result) });
      }),
    );
    g.world.onTracer = (a, b, owner) => {
      if (!live()) return;
      const r = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
      this.send({ t: 'tr', a: r(a), b: r(b) }, owner);
    };
    g.world.onKill((killer, victim, how) => {
      if (live() && !this.closed) this.send({ t: 'kill', k: id(killer), v: id(victim), how: String(how).slice(0, 12) });
    });
    g.onPickupNet = (c, index) => { if (live()) this.send({ t: 'pick', i: index, id: id(c) }); };
  }

  ring(text) { if (this.inMatch) this.send({ t: 'ring', text }); }

  hitConfirm(remote, headshot) {
    const m = this.members.find((x) => x.remote === remote);
    if (m) m.peer.send({ t: 'hit', h: !!headshot });
  }

  // Lag compensation: put everyone except `shooter` back where they were at host time `t`
  // (as the shooter saw them), run `fn`, then put them back
  rewind(shooter, t, fn) {
    const now = this.now();
    const at = Math.max(now - MAX_REWIND, Math.min(now, Number.isFinite(t) ? t : now));
    if (now - at < 0.01) return fn();
    const saved = [];
    for (const c of this.game.world.combatants) {
      if (c === shooter || c.dead) continue;
      const h = this.history.get(c);
      if (!h || !h.length) continue;
      let a = h[0];
      let b = h[h.length - 1];
      for (let i = h.length - 1; i > 0; i--) {
        if (h[i - 1].t <= at) { a = h[i - 1]; b = h[i]; break; }
      }
      const k = b.t > a.t ? Math.max(0, Math.min(1, (at - a.t) / (b.t - a.t))) : 1;
      saved.push([c, c.position.x, c.position.y, c.position.z, c.height]);
      c.position.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
      c.height = k < 0.5 ? a.h : b.h;
    }
    try {
      return fn();
    } finally {
      for (const [c, x, y, z, h] of saved) { c.position.set(x, y, z); c.height = h; }
    }
  }

  // A match is starting (main.js has built the map from `seed` and set up everyone):
  // make a character for every connected player
  createRemotes(spawn, spawnPoints) {
    const list = [];
    this.members.forEach((m, i) => {
      if (m.remote) this.game.removeCombatant(m.remote);
      const r = new RemotePlayer(this.game.scene, this.game.world, this.game.nav(), spawn, i + 1, spawnPoints, { name: m.name, colour: m.colour });
      r.net = this;
      m.remote = r;
      list.push(r);
    });
    return list;
  }

  // Everyone has been placed; tell each player what this match looks like
  started({ lots, seed }) {
    this.inMatch = true;
    this.history.clear();
    const ents = this.game.world.combatants.map((c) => ({
      id: c.netId, name: c === this.game.player ? this.me.name : c.name, colour: c.netColour,
      x: +c.position.x.toFixed(3), y: +c.position.y.toFixed(3), z: +c.position.z.toFixed(3), yaw: +c.yaw.toFixed(4),
    }));
    for (const m of this.members) {
      if (!m.remote) continue;
      m.peer.send({ t: 'start', lots, seed, you: m.remote.netId, ents });
    }
    this.changed();
  }

  update(dt) {
    if (!this.inMatch) return;
    const t = this.now();
    for (const c of this.game.world.combatants) {
      let h = this.history.get(c);
      if (!h) this.history.set(c, (h = []));
      h.push({ t, x: c.position.x, y: c.position.y, z: c.position.z, h: c.height });
      while (h.length > 2 && h[0].t < t - HISTORY) h.shift();
    }
    const match = this.game.match;
    if (match.state === 'over' && this.lastState !== 'over') {
      const w = match.winner;
      this.send({ t: 'over', w: w && w.netId !== undefined ? w.netId : NONE });
    }
    this.lastState = match.state;

    this.snapTimer -= dt;
    if (this.snapTimer > 0) return;
    this.snapTimer += 1 / SNAP_HZ;
    if (this.snapTimer < 0) this.snapTimer = 0;
    const everyone = this.game.world.combatants.filter((c) => c.netId !== undefined);
    const players = encodePlayers(everyone);
    for (const m of this.members) {
      const r = m.remote;
      if (!r || !m.peer.open) continue;
      const g = r.gun;
      m.peer.sendState(encodeSnapshot({
        time: t, ack: Math.max(0, r.lastSeq), you: r.netId, state: match.state, timer: match.timer,
        zone: match.zone, total: match.total,
        ammo: g.ammo, reserve: g.reserve, reloadTimer: g.reloadTimer,
        lastAttacker: r.lastAttacker && r.lastAttacker.netId !== undefined ? r.lastAttacker.netId : NONE,
      }, players));
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.inMatch = false;
    clearInterval(this.lobbyTimer);
    this.send({ t: 'closed' });
    for (const m of [...this.members]) this.drop(m, false);
    for (const u of this.unsubs) u && u();
    this.game.world.onTracer = null;
    this.game.onPickupNet = null;
    if (this.lobby) await this.lobby.close();
  }
}
