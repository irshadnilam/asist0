import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createWorkspace, deleteWorkspace, listWorkspaces } from '../../lib/api'
import { useAuth } from '../../lib/useAuth'
import type { WorkspaceInfo } from '../../lib/api'

export const Route = createFileRoute('/app/')({
  component: WorkspaceList,
})

function WorkspaceList() {
  const navigate = useNavigate()
  const { user, loading: authLoading, idToken, signOut } = useAuth()
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Redirect to sign-in if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: '/sign-in' })
    }
  }, [authLoading, user, navigate])

  const fetchWorkspaces = useCallback(async () => {
    if (!idToken) return
    try {
      setLoading(true)
      setError(null)
      const data = await listWorkspaces({ data: idToken })
      setWorkspaces(data)
      setSelectedIndex(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces')
    } finally {
      setLoading(false)
    }
  }, [idToken])

  useEffect(() => {
    if (idToken) {
      fetchWorkspaces()
    }
  }, [idToken, fetchWorkspaces])

  const openWorkspace = useCallback(
    (workspaceId: string) => {
      navigate({ to: '/app/$workspaceId', params: { workspaceId } })
    },
    [navigate],
  )

  const handleCreateWorkspace = useCallback(async () => {
    if (!idToken) return
    try {
      setCreating(true)
      setError(null)
      const ws = await createWorkspace({ data: idToken })
      openWorkspace(ws.workspace_id)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create workspace',
      )
    } finally {
      setCreating(false)
    }
  }, [idToken, openWorkspace])

  const handleDeleteWorkspace = useCallback(
    async (e: React.MouseEvent, workspaceId: string) => {
      e.stopPropagation() // Don't trigger row click (open)
      if (!idToken) return
      try {
        setDeleting(workspaceId)
        setError(null)
        await deleteWorkspace({ data: { token: idToken, workspaceId } })
        setWorkspaces((prev) => prev.filter((ws) => ws.workspace_id !== workspaceId))
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to delete workspace',
        )
      } finally {
        setDeleting(null)
      }
    },
    [idToken],
  )

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(0, prev - 1))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) =>
          Math.min(workspaces.length - 1, prev + 1),
        )
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (workspaces.length > 0 && workspaces[selectedIndex]) {
          openWorkspace(workspaces[selectedIndex].workspace_id)
        }
      } else if (e.key === 'n' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleCreateWorkspace()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [workspaces, selectedIndex, openWorkspace, handleCreateWorkspace])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll('[data-workspace-item]')
    items[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Show nothing while checking auth
  if (authLoading || !user) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm text-[#484f58]">loading...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Title bar */}
      <div className="flex items-center justify-between border-b border-[#21262d] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[#58a6ff]">asisto</span>
          <span className="text-xs text-[#484f58]">/</span>
          <span className="text-sm text-[#8b949e]">workspaces</span>
        </div>
        <button
          type="button"
          onClick={handleCreateWorkspace}
          disabled={creating}
          className="flex items-center gap-1.5 rounded border border-[#30363d] bg-[#21262d] px-3 py-1 text-xs font-medium text-[#c9d1d9] transition hover:border-[#8b949e] hover:bg-[#30363d] disabled:opacity-50"
        >
          <span className="text-[#3fb950]">+</span>
          {creating ? 'creating...' : 'new workspace'}
          <span className="ml-1 text-[#484f58]">{'\u2318'}N</span>
        </button>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col px-4 py-3">
        {error && (
          <div className="mb-3 rounded border border-[#f85149]/30 bg-[#f85149]/10 px-3 py-2 text-xs text-[#f85149]">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="text-sm text-[#484f58]">loading workspaces...</span>
          </div>
        ) : workspaces.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <span className="text-sm text-[#484f58]">
              no workspaces yet
            </span>
            <button
              type="button"
              onClick={handleCreateWorkspace}
              disabled={creating}
              className="rounded border border-[#30363d] bg-[#21262d] px-4 py-2 text-sm text-[#c9d1d9] transition hover:border-[#8b949e] hover:bg-[#30363d] disabled:opacity-50"
            >
              create your first workspace
            </button>
          </div>
        ) : (
          <div ref={listRef} className="flex flex-col gap-0.5">
            {workspaces.map((ws, index) => (
              <div
                key={ws.workspace_id}
                data-workspace-item
                onClick={() => openWorkspace(ws.workspace_id)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`flex cursor-pointer items-center rounded px-3 py-2 text-sm transition ${
                  index === selectedIndex
                    ? 'bg-[#161b22] text-[#58a6ff]'
                    : 'text-[#8b949e] hover:bg-[#161b22]/50'
                }`}
              >
                <span className="mr-3 w-5 text-right text-xs text-[#484f58]">
                  {index + 1}
                </span>
                <span className="font-medium">{ws.workspace_id}</span>
                {index === selectedIndex && (
                  <span className="ml-auto flex items-center gap-3">
                    <button
                      type="button"
                      onClick={(e) => handleDeleteWorkspace(e, ws.workspace_id)}
                      disabled={deleting === ws.workspace_id}
                      className="text-[#484f58] transition hover:text-[#f85149] disabled:opacity-50"
                      title="Delete workspace"
                    >
                      {deleting === ws.workspace_id ? (
                        <span className="text-xs">...</span>
                      ) : (
                        <svg
                          className="h-3.5 w-3.5 fill-current"
                          viewBox="0 0 24 24"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                        </svg>
                      )}
                    </button>
                    <span className="text-xs text-[#484f58]">
                      enter to open
                    </span>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-[#21262d] px-4 py-1">
        <div className="flex items-center gap-3 text-xs text-[#484f58]">
          <span>{'\u2191\u2193'} navigate</span>
          <span>{'\u23CE'} open</span>
          <span>{'\u2318'}N new</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#484f58]">
            {user.displayName || user.email}
          </span>
          <button
            type="button"
            onClick={signOut}
            className="text-xs text-[#484f58] transition hover:text-[#c9d1d9]"
          >
            sign out
          </button>
        </div>
      </div>
    </div>
  )
}
