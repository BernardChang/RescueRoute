import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';

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
export const auth = getAuth(initializeApp(firebaseConfig));
auth.useDeviceLanguage();
