/**
 * Firebase configuration and initialization.
 *
 * The Firebase config values are public (they identify the project,
 * not secrets). They're safe to commit.
 */

import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyCkDL2rHeGgcu24DkR2Vc8q9b_VmJQObmo',
  authDomain: 'asista-hackathon.firebaseapp.com',
  projectId: 'asista-hackathon',
  storageBucket: 'asista-hackathon.firebasestorage.app',
  messagingSenderId: '875791790592',
  appId: '1:875791790592:web:92896d049dfb43373c9ee5',
}

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)
const googleProvider = new GoogleAuthProvider()

export { auth, db, googleProvider }
