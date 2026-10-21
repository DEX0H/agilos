// Firebase web app settings. The API key and app ID are not kept in the repository: they
// come from the build environment (GitHub Actions secrets in CI, a git-ignored .env.local
// for local development). Without them the game runs in guest mode.
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: 'agilos-c3f7b.firebaseapp.com',
  projectId: 'agilos-c3f7b',
  storageBucket: 'agilos-c3f7b.firebasestorage.app',
  messagingSenderId: '456784011791',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
};
