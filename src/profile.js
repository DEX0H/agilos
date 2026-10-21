import { firebase, firebaseEnabled } from './firebase.js';
import { applyRemoteSettings, settingsSnapshot, onSettingsChange, onBotsChange } from './settings.js';

// Player profiles: sign in with Google or email + password (Firebase Auth), or play as a
// guest. A signed-in player has a document players/{uid} with a unique display name, a
// colour, synced settings and lifetime stats totals; names/{lower-case name} reserves the
// name. Guests keep their stats in this browser only (stats.js).

const GUEST_KEY = 'agilos.guest.v1';
export const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
export const COLOURS = ['#ff8a1f', '#5fa8ff', '#5fd35a', '#e2452f', '#b072ff', '#ffd27a', '#2ec4b6', '#ff6fb5'];

export const profile = {
  mode: 'loading',   // loading | signedOut | needsName | guest | user
  uid: null,
  email: null,
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

// Friendly text for the errors players actually hit
export function errorText(e) {
  const code = (e && e.code) || '';
  const map = {
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/missing-password': 'Enter a password.',
    'auth/weak-password': 'Use a password of at least 6 characters.',
    'auth/email-already-in-use': 'An account with this email exists. Sign in instead.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'No account with this email. Create one instead.',
    'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
    'auth/popup-closed-by-user': 'The Google window was closed before signing in.',
    'auth/popup-blocked': 'The browser blocked the Google window. Allow pop-ups and try again.',
    'auth/network-request-failed': 'No connection. Check your internet and try again.',
    'name-taken': 'That name is taken. Try another.',
    'name-invalid': 'Names are 3 to 16 letters, digits, _ or -.',
  };
  return map[code] || (e && e.message) || 'Something went wrong.';
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
      Object.assign(profile, { uid: null, email: null, name: null, totals: null });
      profile.mode = guestChosen() ? 'guest' : 'signedOut';
      emit();
      return;
    }
    setGuestChosen(false);
    Object.assign(profile, { uid: user.uid, email: user.email });
    unsubDoc = F.onSnapshot(F.doc(db, 'players', user.uid), (snap) => {
      const d = snap.data();
      if (!d || !d.name) {
        profile.mode = 'needsName';
        emit();
        return;
      }
      const first = profile.mode !== 'user';
      Object.assign(profile, { mode: 'user', name: d.name, colour: d.colour || COLOURS[0], totals: d.totals || null });
      // Settings follow the player: take the profile's on sign-in
      if (first && d.settings) {
        syncing = true;
        applyRemoteSettings(d.settings);
        syncing = false;
      }
      emit();
    }, () => {
      profile.mode = 'needsName';
      emit();
    });
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

export async function signInWithGoogle() {
  const { auth, A } = await firebase();
  if (window.agilosDesktop && window.agilosDesktop.googleSignIn) {
    // Desktop: Google sign-in happens in the system browser, which hands back a token
    const idToken = await window.agilosDesktop.googleSignIn();
    await A.signInWithCredential(auth, A.GoogleAuthProvider.credential(idToken));
  } else {
    await A.signInWithPopup(auth, new A.GoogleAuthProvider());
  }
}

export async function signInWithEmail(email, password) {
  const { auth, A } = await firebase();
  await A.signInWithEmailAndPassword(auth, email.trim(), password);
}

export async function createAccount(email, password) {
  const { auth, A } = await firebase();
  await A.createUserWithEmailAndPassword(auth, email.trim(), password);
}

export async function resetPassword(email) {
  const { auth, A } = await firebase();
  await A.sendPasswordResetEmail(auth, email.trim());
}

// Claim a unique name (and change it later the same way)
export async function chooseName(name, colour = profile.colour) {
  if (!NAME_RE.test(name)) throw Object.assign(new Error('bad name'), { code: 'name-invalid' });
  const { db, F } = await firebase();
  const uid = profile.uid;
  const key = name.toLowerCase();
  await F.runTransaction(db, async (tx) => {
    const nameRef = F.doc(db, 'names', key);
    const playerRef = F.doc(db, 'players', uid);
    const [taken, me] = await Promise.all([tx.get(nameRef), tx.get(playerRef)]);
    if (taken.exists() && taken.data().uid !== uid) throw Object.assign(new Error('taken'), { code: 'name-taken' });
    const old = me.exists() ? me.data().name : null;
    if (old && old.toLowerCase() !== key) tx.delete(F.doc(db, 'names', old.toLowerCase()));
    if (!taken.exists()) tx.set(nameRef, { uid });
    if (me.exists()) {
      tx.update(playerRef, { name, colour });
    } else {
      tx.set(playerRef, { name, colour, createdAt: F.serverTimestamp(), settings: settingsSnapshot() });
    }
  });
}

export function playAsGuest() {
  setGuestChosen(true);
  profile.mode = 'guest';
  emit();
}

// Back to the sign-in card (from guest mode, or after signing out)
export async function showSignIn() {
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

// Removes the player's matches, name and profile, then the account itself
export async function deleteAccount() {
  const { auth, db, A, F } = await firebase();
  const uid = profile.uid;
  const matches = await F.getDocs(F.collection(db, 'players', uid, 'matches'));
  for (const m of matches.docs) await F.deleteDoc(m.ref);
  if (profile.name) await F.deleteDoc(F.doc(db, 'names', profile.name.toLowerCase())).catch(() => {});
  await F.deleteDoc(F.doc(db, 'players', uid));
  await A.deleteUser(auth.currentUser);
}
