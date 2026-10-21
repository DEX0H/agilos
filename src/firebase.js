import { firebaseConfig } from './firebase-config.js';

// Firebase (sign-in and the stats database), loaded only when first needed so the game
// itself starts as fast as before.
export const firebaseEnabled = !!(firebaseConfig.apiKey && firebaseConfig.appId);

let services = null;
export function firebase() {
  if (!firebaseEnabled) return Promise.reject(new Error('Firebase is not configured'));
  services ||= (async () => {
    const [{ initializeApp }, A, F] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/firestore'),
    ]);
    const app = initializeApp(firebaseConfig);
    const auth = A.initializeAuth(app, {
      persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence],
      popupRedirectResolver: A.browserPopupRedirectResolver,
    });
    // Offline cache: finished matches queue up and upload when back online
    const db = F.initializeFirestore(app, { localCache: F.persistentLocalCache() });
    return { app, auth, db, A, F };
  })();
  return services;
}
