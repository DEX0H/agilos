import '@fontsource/teko/latin-600.css';
import '@fontsource/rajdhani/latin-500.css';
import '@fontsource/rajdhani/latin-600.css';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, browserSessionPersistence, setPersistence } from 'firebase/auth';
import { firebaseConfig } from './firebase-config.js';

// Opened by the Windows app in the system browser with ?port=<loopback port>&state=<nonce>.
// After Google sign-in, sends the Google ID token back to that port on this computer only.

const params = new URLSearchParams(location.search);
const port = Number(params.get('port'));
const state = params.get('state') || '';
const msg = document.getElementById('msg');
const go = document.getElementById('go');
const fail = (text) => { msg.textContent = text; msg.className = 'err'; };

if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9]{32}$/.test(state)) {
  go.disabled = true;
  fail('Open this page from the Agilos app (Sign in, Continue with Google).');
} else {
  const auth = getAuth(initializeApp(firebaseConfig));
  go.addEventListener('click', async () => {
    go.disabled = true;
    msg.className = '';
    msg.textContent = 'Waiting for Google…';
    try {
      await setPersistence(auth, browserSessionPersistence); // don't keep a web session here
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      const cred = GoogleAuthProvider.credentialFromResult(result);
      await signOut(auth);
      if (!cred || !cred.idToken) throw new Error('Google did not return a token.');
      msg.textContent = 'Signed in. Returning to Agilos…';
      const back = new URL(`http://127.0.0.1:${port}/callback`);
      back.searchParams.set('state', state);
      back.searchParams.set('id_token', cred.idToken);
      location.replace(back.toString());
    } catch (e) {
      go.disabled = false;
      fail(e && e.code === 'auth/popup-closed-by-user' ? 'The Google window was closed. Try again.' : 'Sign-in failed. Try again.');
    }
  });
}
