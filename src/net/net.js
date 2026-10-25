import { createSignal, localMode } from './signal.js';
import { NetHost } from './host.js';
import { NetClient } from './client.js';
import { STUN } from './peer.js';

// Multiplayer front door: host a lobby or join one by code. At most one at a time.
// `game` is main.js's set of hooks (see netGame there).

export class Net {
  constructor(game) {
    this.game = game;
    this.host = null;
    this.client = null;
    this.onChange = null;   // anything about the lobby changed (UI)
    this.message = '';      // last notice for the lobby UI (kicked, host left...)
    this.ice = localMode() ? [] : STUN;
  }

  get mode() { return this.host ? 'host' : this.client ? 'client' : null; }
  get active() { return !!(this.host || this.client); }
  get inMatch() { return (this.host && this.host.inMatch) || (this.client && this.client.inMatch) || false; }

  changed() { if (this.onChange) this.onChange(); }

  async hostLobby(me) {
    if (this.active) return this.host ? this.host.code : null;
    const signal = await createSignal();
    const h = new NetHost(this.game, signal, me, this.ice);
    h.onChange = () => this.changed();
    this.host = h;
    try {
      await h.open();
    } catch (e) {
      this.host = null;
      throw e;
    }
    this.message = '';
    this.changed();
    return h.code;
  }

  async joinLobby(code, me) {
    if (this.active) return;
    const signal = await createSignal();
    const c = new NetClient(this.game, signal, me, this.ice);
    c.onChange = () => this.changed();
    c.onLeave = (reason) => {
      if (this.client !== c) return;
      this.client = null;
      this.message = reason;
      this.game.netEnded(reason);
      this.changed();
    };
    this.client = c;
    try {
      await c.join(code);
    } catch (e) {
      if (this.client === c) this.client = null;
      c.closed = true;
      if (c.peer) c.peer.close();
      throw e;
    }
    this.message = '';
    this.changed();
  }

  async leave() {
    if (this.host) {
      const h = this.host;
      this.host = null;
      await h.close();
      this.game.netEnded('');
    } else if (this.client) {
      this.client.leave('');
    }
    this.message = '';
    this.changed();
  }

  update(dt) {
    if (this.host) this.host.update(dt);
    if (this.client) this.client.update(dt);
  }
}
