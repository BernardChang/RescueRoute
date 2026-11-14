import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, doc, onSnapshot, setDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

export {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  updateProfile,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  signOut,
  validatePassword,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

// Firebase is the authentication backend. Admin credentials are not needed here.
const configResponse = await fetch('/api/firebase-config', { cache: 'no-store' });
if (!configResponse.ok) throw new Error('Firebase is not configured on this website.');
const firebaseConfig = await configResponse.json();
export const auth = getAuth(initializeApp(firebaseConfig));
export const db = getFirestore(auth.app);
export { doc, onSnapshot, setDoc };
auth.useDeviceLanguage();
