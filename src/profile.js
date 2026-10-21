import { firebase, firebaseEnabled } from './firebase.js';
import { applyRemoteSettings, settingsSnapshot, onSettingsChange, onBotsChange } from './settings.js';

// Player profiles with just a username and a password, or play as a guest.
// Firebase Auth needs an email for password accounts, so the username is mapped to a
// placeholder address (<username>@agilos.players) that is never shown or emailed; that
// also makes usernames unique (case-insensitive). A signed-in player has players/{uid}
// with their name as typed, a colour, synced settings and lifetime stats totals.

const GUEST_KEY = 'agilos.guest.v1';
const DOMAIN = 'agilos.players';
export const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
export const COLOURS = ['#ff8a1f', '#5fa8ff', '#5fd35a', '#e2452f', '#b072ff', '#ffd27a', '#2ec4b6', '#ff6fb5'];

export const profile = {
  mode: 'loading',   // loading | signedOut | guest | user
  uid: null,
  name: null,
  colour: COLOURS[0],
  totals: null,
};

const listeners = [];
export function onProfileChange(fn) {
  listeners.push(fn);
  fn(profile);
}
function emit() {
  for (const fn of listeners) fn(profile);
}

function guestChosen() {
  try { return localStorage.getItem(GUEST_KEY) === '1'; } catch { return false; }
}
function setGuestChosen(on) {
  try { on ? localStorage.setItem(GUEST_KEY, '1') : localStorage.removeItem(GUEST_KEY); } catch { /* ignore */ }
}

const loginEmail = (name) => `${name.toLowerCase()}@${DOMAIN}`;

// Friendly text for the errors players actually hit
export function errorText(e) {
  const code = (e && e.code) || '';
  const map = {
    'name-invalid': 'Usernames are 3 to 16 letters, digits, _ or -.',
    'auth/missing-password': 'Enter a password.',
    'auth/weak-password': 'Use a password of at least 6 characters.',
    'auth/email-already-in-use': 'That username is taken. Pick another, or sign in.',
    'auth/invalid-credential': 'Wrong username or password.',
    'auth/wrong-password': 'Wrong username or password.',
    'auth/user-not-found': 'No player with that username. Create the account instead.',
    'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
    'auth/network-request-failed': 'No connection. Check your internet and try again.',
    'auth/requires-recent-login': 'For safety, sign out and in again, then try once more.',
  };
  return map[code] || 'Something went wrong. Try again.';
}

function checkName(name) {
  if (!NAME_RE.test(name)) throw Object.assign(new Error('bad name'), { code: 'name-invalid' });
}

let unsubDoc = null;
let syncing = false;

export async function initProfile() {
  if (!firebaseEnabled) {
    profile.mode = 'guest';
    emit();
    return;
  }
  const { auth, db, A, F } = await firebase();
  A.onAuthStateChanged(auth, (user) => {
    if (unsubDoc) { unsubDoc(); unsubDoc = null; }
    if (!user) {
      Object.assign(profile, { uid: null, name: null, totals: null });
      profile.mode = guestChosen() ? 'guest' : 'signedOut';
      emit();
      return;
    }
    setGuestChosen(false);
    profile.uid = user.uid;
    unsubDoc = F.onSnapshot(F.doc(db, 'players', user.uid), (snap) => {
      const d = snap.data();
      if (!d) return; // created right after sign-up; the next snapshot has it
      const first = profile.mode !== 'user';
      Object.assign(profile, { mode: 'user', name: d.name, colour: d.colour || COLOURS[0], totals: d.totals || null });
      // Settings follow the player: take the profile's on sign-in
      if (first && d.settings) {
        syncing = true;
        applyRemoteSettings(d.settings);
        syncing = false;
      }
      emit();
    }, () => {});
  });

  // Local settings changes are saved to the profile (a second later, batched)
  let timer = 0;
  const push = () => {
    if (syncing || profile.mode !== 'user') return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      F.setDoc(F.doc(db, 'players', profile.uid), { settings: settingsSnapshot() }, { merge: true }).catch(() => {});
    }, 1000);
  };
  onSettingsChange(push);
  onBotsChange(push);
}

export async function signIn(name, password) {
  checkName(name);
  const { auth, A } = await firebase();
  await A.signInWithEmailAndPassword(auth, loginEmail(name), password);
}

export async function createAccount(name, password) {
  checkName(name);
  const { auth, db, A, F } = await firebase();
  const cred = await A.createUserWithEmailAndPassword(auth, loginEmail(name), password);
  const colour = COLOURS[Math.floor(Math.random() * COLOURS.length)];
  await F.setDoc(F.doc(db, 'players', cred.user.uid), {
    name, colour, createdAt: F.serverTimestamp(), settings: settingsSnapshot(),
  });
}

export async function setColour(colour) {
  const { db, F } = await firebase();
  await F.updateDoc(F.doc(db, 'players', profile.uid), { colour });
}

export async function changePassword(current, next) {
  const { auth, A } = await firebase();
  const user = auth.currentUser;
  await A.reauthenticateWithCredential(user, A.EmailAuthProvider.credential(user.email, current));
  await A.updatePassword(user, next);
}

export function playAsGuest() {
  setGuestChosen(true);
  profile.mode = 'guest';
  emit();
}

// Back to the sign-in card from guest mode
export function showSignIn() {
  setGuestChosen(false);
  if (profile.mode === 'guest') {
    profile.mode = 'signedOut';
    emit();
  }
}

export async function signOut() {
  setGuestChosen(false);
  const { auth, A } = await firebase();
  await A.signOut(auth);
}

// Removes the player's matches and profile, then the account itself
export async function deleteAccount(password) {
  const { auth, db, A, F } = await firebase();
  const user = auth.currentUser;
  await A.reauthenticateWithCredential(user, A.EmailAuthProvider.credential(user.email, password));
  const uid = user.uid;
  const matches = await F.getDocs(F.collection(db, 'players', uid, 'matches'));
  for (const m of matches.docs) await F.deleteDoc(m.ref);
  await F.deleteDoc(F.doc(db, 'players', uid));
  await A.deleteUser(user);
}
