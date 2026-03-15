/**
 * Firebase Auth context and hook.
 *
 * Uses a React context provider so that all components share a single
 * auth state subscription and token refresh interval (instead of each
 * component running its own).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { auth, googleProvider } from './firebase'

interface AuthState {
  user: User | null
  loading: boolean
  idToken: string | null
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [idToken, setIdToken] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser)
      if (firebaseUser) {
        try {
          const token = await firebaseUser.getIdToken()
          setIdToken(token)
        } catch (err) {
          console.error('Failed to get ID token:', err)
          setIdToken(null)
        }
      } else {
        setIdToken(null)
      }
      setLoading(false)
    })
    return unsubscribe
  }, [])

  // Refresh token periodically (tokens expire after 1 hour).
  // Uses auth.currentUser instead of captured `user` to avoid stale refs.
  useEffect(() => {
    if (!user) return
    const interval = setInterval(async () => {
      const currentUser = auth.currentUser
      if (!currentUser) return
      try {
        const token = await currentUser.getIdToken(true)
        setIdToken(token)
      } catch (err) {
        console.error('Failed to refresh ID token:', err)
      }
    }, 10 * 60 * 1000) // refresh every 10 minutes
    return () => clearInterval(interval)
  }, [user])

  const signInWithGoogle = useCallback(async () => {
    await signInWithPopup(auth, googleProvider)
  }, [])

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth)
  }, [])

  const value = useMemo(
    () => ({ user, loading, idToken, signInWithGoogle, signOut }),
    [user, loading, idToken, signInWithGoogle, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}
