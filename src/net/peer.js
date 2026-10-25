// One direct connection between two games (WebRTC data channels).
// Two channels, created the same way on both ends (negotiated ids, so no extra round trip):
//   state:  unordered, no retransmits: inputs and snapshots, where only the newest matters
//   events: reliable and ordered: lobby, kills, box spins, match flow (JSON)
// The connection is set up in one exchange (offer, then answer) with all ICE candidates
// included, so signaling is just two documents.

// Public STUN servers (free, no key) find each player's public address for most home
// networks. There is no TURN relay: players on very strict networks may not connect.
export const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 8 * 1024;
const GATHER_TIMEOUT = 3000;

function waitForCandidates(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, GATHER_TIMEOUT);
  });
}

export class Peer {
  constructor(iceServers) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.state = this.pc.createDataChannel('state', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    this.events = this.pc.createDataChannel('events', { negotiated: true, id: 1, ordered: true });
    this.state.binaryType = 'arraybuffer';
    this.onState = null;   // (ArrayBuffer) => void
    this.onEvent = null;   // (object) => void
    this.onOpen = null;
    this.onClose = null;
    this.open = false;
    this.closed = false;
    this.rtt = 0;          // round-trip time in ms
    this.pingTimer = null;

    let opened = 0;
    const opening = () => {
      if (++opened < 2) return;
      this.open = true;
      this.pingTimer = setInterval(() => this.send({ t: 'ping', s: performance.now() }), 1000);
      if (this.onOpen) this.onOpen();
    };
    this.state.onopen = opening;
    this.events.onopen = opening;
    this.state.onclose = () => this.close();
    this.events.onclose = () => this.close();
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(this.pc.connectionState)) this.close();
    };

    this.state.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer) || e.data.byteLength > MAX_STATE_BYTES) return;
      if (this.onState) this.onState(e.data);
    };
    this.events.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data.length > MAX_EVENT_BYTES) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      if (msg.t === 'ping') {
        const now = performance.now();
        if (now - (this.lastPong || 0) > 200 && Number.isFinite(msg.s)) {
          this.lastPong = now;
          this.send({ t: 'pong', s: msg.s });
        }
        return;
      }
      if (msg.t === 'pong') {
        const rtt = performance.now() - msg.s;
        if (rtt >= 0 && rtt < 10000) this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
        return;
      }
      if (this.onEvent) this.onEvent(msg);
    };
  }

  // Joining player: make the offer
  static async offer(iceServers) {
    const p = new Peer(iceServers);
    await p.pc.setLocalDescription(await p.pc.createOffer());
    await waitForCandidates(p.pc);
    return { peer: p, offer: p.pc.localDescription.sdp };
  }

  // Host: answer an offer
  static async answer(offerSdp, iceServers) {
    const p = new Peer(iceServers);
    await p.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await p.pc.setLocalDescription(await p.pc.createAnswer());
    await waitForCandidates(p.pc);
    return { peer: p, answer: p.pc.localDescription.sdp };
  }

  async accept(answerSdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  send(obj) {
    if (this.events.readyState !== 'open') return;
    try { this.events.send(JSON.stringify(obj)); } catch { /* closing */ }
  }

  sendState(buf) {
    // Drop rather than queue when the link is backed up: the next one is newer anyway
    if (this.state.readyState !== 'open' || this.state.bufferedAmount > 64 * 1024) return;
    try { this.state.send(buf); } catch { /* closing */ }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    clearInterval(this.pingTimer);
    try { this.pc.close(); } catch { /* already closed */ }
    if (this.onClose) this.onClose();
  }
}
