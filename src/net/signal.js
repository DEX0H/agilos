import { firebase, firebaseEnabled } from '../firebase.js';
import { profile } from '../profile.js';

// Signaling: how two games find each other before they talk directly. The host puts a
// lobby under a 6-letter code; a joining player leaves a connection offer under that code
// and the host's game answers it. After that, nothing goes through the server.
//
//   lobbies/{code}              host: { host: uid, name, max, createdAt, expireAt }
//   lobbies/{code}/peers/{uid}  joining player: { offer, name, colour, at }; host adds { answer }
//
// The local version uses a BroadcastChannel instead, for two tabs on one computer (testing,
// or trying it out without an account). Only with ?net=local.

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: easy to read out loud
export const CODE_RE = /^[A-HJ-NP-Z]{6}$/;
const LOBBY_HOURS = 2;
const ANSWER_TIMEOUT = 20000;

export function newCode() {
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => LETTERS[n % LETTERS.length]).join('');
}

export function normalizeCode(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
}

const err = (code, message) => Object.assign(new Error(message), { code });

export const localMode = () => new URLSearchParams(location.search).get('net') === 'local';

// Firestore signaling (needs a signed-in profile)
async function firestoreSignal() {
  if (!firebaseEnabled) throw err('offline', 'Online play is not available in this build.');
  if (profile.mode !== 'user' || !profile.uid) throw err('signin', 'Sign in to play online.');
  const { db, F } = await firebase();
  const uid = profile.uid;
  return {
    uid,
    async host({ name, max }) {
      // A fresh code; `create` fails if the code is already in use, so try a few
      for (let tries = 0; tries < 5; tries++) {
        const code = newCode();
        const ref = F.doc(db, 'lobbies', code);
        try {
          const snap = await F.getDoc(ref);
          if (snap.exists()) continue;
        } catch { /* not readable: someone else's; try another code */ continue; }
        const expireAt = F.Timestamp.fromMillis(Date.now() + LOBBY_HOURS * 3600e3);
        await F.setDoc(ref, { host: uid, name, max, createdAt: F.serverTimestamp(), expireAt });
        const seen = new Set();
        const peers = new Set();
        let onOffer = null;
        const unsub = F.onSnapshot(F.collection(db, 'lobbies', code, 'peers'), (qs) => {
          for (const ch of qs.docChanges()) {
            if (ch.type === 'removed') continue;
            const d = ch.doc.data();
            peers.add(ch.doc.id);
            const key = `${ch.doc.id}:${(d.offer || '').length}:${d.at?.seconds || 0}`;
            if (!d.offer || d.answer || seen.has(key)) continue;
            seen.add(key);
            if (onOffer) onOffer(ch.doc.id, d.offer, { name: d.name, colour: d.colour });
          }
        }, () => {});
        return {
          code,
          set onOffer(fn) { onOffer = fn; },
          answer: (peerUid, sdp) => F.updateDoc(F.doc(db, 'lobbies', code, 'peers', peerUid), { answer: sdp }),
          // Connected: the offer and answer aren't needed any more
          done: (peerUid) => F.deleteDoc(F.doc(db, 'lobbies', code, 'peers', peerUid)).catch(() => {}),
          close: async () => {
            unsub();
            await Promise.all([...peers].map((id) => F.deleteDoc(F.doc(db, 'lobbies', code, 'peers', id)).catch(() => {})));
            await F.deleteDoc(ref).catch(() => {});
          },
        };
      }
      throw err('busy', 'Could not create a lobby. Try again.');
    },
    async join(code, { name, colour }, offerSdp) {
      const lobby = await F.getDoc(F.doc(db, 'lobbies', code)).catch(() => null);
      if (!lobby || !lobby.exists()) throw err('not-found', 'No lobby with that code.');
      const ref = F.doc(db, 'lobbies', code, 'peers', uid);
      await F.deleteDoc(ref).catch(() => {});
      await F.setDoc(ref, { offer: offerSdp, name, colour, at: F.serverTimestamp() });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unsub();
          F.deleteDoc(ref).catch(() => {}); // the offer holds network addresses: don't leave it
          reject(err('timeout', 'The host did not answer.'));
        }, ANSWER_TIMEOUT);
        const unsub = F.onSnapshot(ref, (snap) => {
          const d = snap.data();
          if (d && d.answer) {
            clearTimeout(timer);
            unsub();
            resolve(d.answer);
          }
        }, () => {});
      });
    },
  };
}

// Same thing over a BroadcastChannel, for tabs in one browser
function localSignal() {
  const bc = new BroadcastChannel('agilos-net');
  const uid = `local-${Math.random().toString(36).slice(2, 10)}`;
  const handlers = new Set();
  bc.onmessage = (e) => { for (const h of handlers) h(e.data); };
  return {
    uid,
    async host() {
      const code = newCode();
      let onOffer = null;
      const h = (m) => {
        if (m && m.t === 'offer' && m.code === code && onOffer) onOffer(m.uid, m.sdp, { name: m.name, colour: m.colour });
      };
      handlers.add(h);
      return {
        code,
        set onOffer(fn) { onOffer = fn; },
        answer: async (peerUid, sdp) => bc.postMessage({ t: 'answer', code, uid: peerUid, sdp }),
        done: () => {},
        close: async () => { handlers.delete(h); },
      };
    },
    join(code, { name, colour }, offerSdp) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { handlers.delete(h); reject(err('not-found', 'No lobby with that code.')); }, 8000);
        const h = (m) => {
          if (m && m.t === 'answer' && m.code === code && m.uid === uid) {
            clearTimeout(timer);
            handlers.delete(h);
            resolve(m.sdp);
          }
        };
        handlers.add(h);
        bc.postMessage({ t: 'offer', code, uid, sdp: offerSdp, name, colour });
      });
    },
  };
}

export async function createSignal() {
  return localMode() ? localSignal() : firestoreSignal();
}
