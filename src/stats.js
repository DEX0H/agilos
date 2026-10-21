import { firebase } from './firebase.js';
import { profile } from './profile.js';

// Per-match stats for the local player, saved when the match ends: to the player's
// Firestore profile when signed in (match record + lifetime totals in one transaction),
// or to this browser's storage for guests.

const GUEST_KEY = 'agilos.stats.v1';
const KEEP = 50;
const WEAPONS = ['handgun', 'smg', 'rifle', 'sniper', 'knife'];
const RARITIES = ['common', 'rare', 'legendary'];

const blank = () => ({
  kills: 0, deaths: 0, headshots: 0, shots: 0, hits: 0,
  damageDealt: 0, damageTaken: 0, longestKill: 0,
  killsByWeapon: Object.fromEntries(WEAPONS.map((w) => [w, 0])),
  boxRolls: Object.fromEntries(RARITIES.map((r) => [r, 0])),
});

export const emptyTotals = () => ({ matches: 0, wins: 0, placeSum: 0, timeAlive: 0, ...blank() });

export class MatchStats {
  constructor({ player, world, match, currentWeapon }) {
    this.player = player;
    this.match = match;
    this.currentWeapon = currentWeapon; // () => weapon name of what the player holds
    this.cur = null;
    this.onSaved = null;                // (record, totals) => void

    player.onDamaged = (amount) => { if (this.live()) this.cur.damageTaken += amount; };
    player.onDealt = (amount) => { if (this.live()) this.cur.damageDealt += amount; };
    world.onKill((killer, victim, how) => {
      if (!this.live()) return;
      if (killer === player && victim !== player) {
        const c = this.cur;
        c.kills++;
        if (how === 'headshot') c.headshots++;
        const w = this.currentWeapon();
        if (w in c.killsByWeapon) c.killsByWeapon[w]++;
        c.longestKill = Math.max(c.longestKill, Math.round(player.position.distanceTo(victim.position)));
      }
      if (victim === player) {
        this.cur.deaths++;
        this.cur.diedAt = performance.now();
      }
    });
  }

  live() {
    return this.cur && !this.cur.saved;
  }

  // Called when a match starts (and before a new one, which saves an unfinished one)
  start() {
    if (this.live() && this.cur.liveAt) this.finish();
    this.cur = { ...blank(), startedAt: Date.now(), liveAt: 0, diedAt: 0, saved: false };
  }

  // Each frame: notes when play begins and saves once the match is decided for the player
  update() {
    const c = this.cur;
    if (!c || c.saved) return;
    if (!c.liveAt && this.match.state === 'live') c.liveAt = performance.now();
    // Saved once the player is out (their place is known) or the match is over
    if (this.match.state === 'over' || (this.player.dead && this.match.playerPlace)) this.finish();
  }

  shot(result) {
    if (!this.live() || !result.fired) return;
    this.cur.shots++;
    if (result.hit) this.cur.hits++;
  }

  boxRoll(spec) {
    if (this.live() && spec.rarity in this.cur.boxRolls) this.cur.boxRolls[spec.rarity]++;
  }

  finish() {
    const c = this.cur;
    if (!c || c.saved || !c.liveAt) return;
    c.saved = true;
    const m = this.match;
    const end = c.diedAt || performance.now();
    const place = m.playerPlace || (this.player.dead ? m.aliveCount() + 1 : 1);
    const record = {
      endedAt: Date.now(),
      place: Math.max(1, Math.min(place, m.total)),
      total: m.total,
      bots: m.total - 1,
      win: m.winner === this.player,
      timeAlive: Math.round((end - c.liveAt) / 1000),
      kills: c.kills, deaths: c.deaths, headshots: c.headshots,
      shots: c.shots, hits: c.hits,
      damageDealt: Math.round(c.damageDealt), damageTaken: Math.round(c.damageTaken),
      longestKill: c.longestKill,
      killsByWeapon: c.killsByWeapon,
      boxRolls: c.boxRolls,
      platform: window.agilosDesktop ? 'windows' : 'web',
      version: 1,
    };
    save(record).then((totals) => { if (this.onSaved) this.onSaved(record, totals); }).catch((e) => {
      console.warn('Could not save match stats', e);
    });
  }
}

function addTotals(t, r) {
  const n = { ...emptyTotals(), ...t };
  n.killsByWeapon = { ...emptyTotals().killsByWeapon, ...(t && t.killsByWeapon) };
  n.boxRolls = { ...emptyTotals().boxRolls, ...(t && t.boxRolls) };
  n.matches += 1;
  n.wins += r.win ? 1 : 0;
  n.placeSum += r.place;
  n.timeAlive += r.timeAlive;
  for (const k of ['kills', 'deaths', 'headshots', 'shots', 'hits', 'damageDealt', 'damageTaken']) n[k] += r[k];
  n.longestKill = Math.max(n.longestKill, r.longestKill);
  for (const w of WEAPONS) n.killsByWeapon[w] += r.killsByWeapon[w] || 0;
  for (const x of RARITIES) n.boxRolls[x] += r.boxRolls[x] || 0;
  return n;
}

async function save(record) {
  if (profile.mode === 'user' && profile.uid) {
    const { db, F } = await firebase();
    const playerRef = F.doc(db, 'players', profile.uid);
    const matchRef = F.doc(F.collection(db, 'players', profile.uid, 'matches'));
    let totals;
    await F.runTransaction(db, async (tx) => {
      const snap = await tx.get(playerRef);
      totals = addTotals(snap.exists() ? snap.data().totals : null, record);
      tx.set(matchRef, { ...record, endedAt: F.serverTimestamp() });
      tx.update(playerRef, { totals });
    });
    return totals;
  }
  // Guest: this browser only
  const local = loadGuest();
  local.totals = addTotals(local.totals, record);
  local.matches = [record, ...local.matches].slice(0, KEEP);
  try { localStorage.setItem(GUEST_KEY, JSON.stringify(local)); } catch { /* storage full or off */ }
  return local.totals;
}

function loadGuest() {
  try {
    const v = JSON.parse(localStorage.getItem(GUEST_KEY) || 'null');
    if (v && typeof v === 'object' && Array.isArray(v.matches)) return { totals: v.totals || null, matches: v.matches };
  } catch { /* corrupt: start over */ }
  return { totals: null, matches: [] };
}

// Lifetime totals + recent matches for the stats screen
export async function loadStats(limit = 20) {
  if (profile.mode === 'user' && profile.uid) {
    const { db, F } = await firebase();
    const q = F.query(F.collection(db, 'players', profile.uid, 'matches'), F.orderBy('endedAt', 'desc'), F.limit(limit));
    const snap = await F.getDocs(q);
    const matches = snap.docs.map((d) => {
      const m = d.data();
      return { ...m, endedAt: m.endedAt && m.endedAt.toMillis ? m.endedAt.toMillis() : Date.now() };
    });
    return { totals: profile.totals || emptyTotals(), matches };
  }
  const g = loadGuest();
  return { totals: g.totals || emptyTotals(), matches: g.matches.slice(0, limit) };
}
