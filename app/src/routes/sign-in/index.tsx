import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAuth } from '../../lib/useAuth'

export const Route = createFileRoute('/sign-in/')({
  component: SignIn,
})

function SignIn() {
  const navigate = useNavigate()
  const { user, loading, signInWithGoogle } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)

  // Redirect to /app if already authenticated
  useEffect(() => {
    if (!loading && user) {
      navigate({ to: '/app' })
    }
  }, [loading, user, navigate])

  const handleSignIn = async () => {
    try {
      setError(null)
      setSigningIn(true)
      await signInWithGoogle()
      // onAuthStateChanged will update user state, triggering redirect above
    } catch (err: unknown) {
      // Handle specific Firebase auth errors
      const code = (err as { code?: string })?.code
      if (code === 'auth/popup-closed-by-user') {
        // User closed the popup — not an error
        return
      }
      if (code === 'auth/popup-blocked') {
        setError('Popup was blocked by the browser. Please allow popups for this site.')
        return
      }
      setError(
        err instanceof Error ? err.message : 'Sign-in failed. Please try again.',
      )
    } finally {
      setSigningIn(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <span className="text-2xl font-bold text-[#c9d1d9]">asisto</span>
        <span className="text-sm text-[#484f58]">AI voice + text assistant</span>
      </div>

      {error && (
        <div className="max-w-sm rounded border border-[#f85149]/30 bg-[#f85149]/10 px-4 py-2 text-xs text-[#f85149]">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleSignIn}
        disabled={loading || signingIn}
        className="flex items-center gap-3 rounded border border-[#30363d] bg-[#21262d] px-6 py-3 text-sm font-medium text-[#c9d1d9] transition hover:border-[#8b949e] hover:bg-[#30363d] disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path
            fill="#4285F4"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
          />
          <path
            fill="#34A853"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          />
          <path
            fill="#FBBC05"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
          />
          <path
            fill="#EA4335"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
          />
        </svg>
        {loading || signingIn ? 'loading...' : 'sign in with Google'}
      </button>

      {/* Status bar */}
      <div className="fixed bottom-0 left-0 right-0 flex items-center justify-center border-t border-[#21262d] px-4 py-1">
        <span className="text-xs text-[#484f58]">
          powered by Gemini + Google ADK
        </span>
      </div>
    </div>
  )
}
