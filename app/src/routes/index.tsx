/**
 * Root route — redirects to /app if authenticated, /sign-in if not.
 *
 * Since Firebase auth state is client-side only, we use a component
 * (not beforeLoad) to check auth and redirect accordingly.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useAuth } from '../lib/useAuth'

export const Route = createFileRoute('/')({
  component: RootRedirect,
})

function RootRedirect() {
  const navigate = useNavigate()
  const { user, loading } = useAuth()

  useEffect(() => {
    if (loading) return
    if (user) {
      navigate({ to: '/app' })
    } else {
      navigate({ to: '/sign-in' })
    }
  }, [loading, user, navigate])

  return (
    <div className="flex flex-1 items-center justify-center">
      <span className="text-sm text-[#484f58]">loading...</span>
    </div>
  )
}
