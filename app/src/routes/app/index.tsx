import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { FileManager } from '@cubone/react-file-manager'
import '@cubone/react-file-manager/dist/style.css'
import { createWorkspace, deleteWorkspace, listWorkspaces } from '../../lib/api'
import { useAuth } from '../../lib/useAuth'
import { useAgentSocket, type WsEvent, type WsStatus } from '../../lib/useAgentSocket'
import { useAudioCapture } from '../../lib/useAudioCapture'
import { useAudioPlayback } from '../../lib/useAudioPlayback'

const Orb = lazy(() => import('../../components/Orb'))

/** Decode base64 (standard or URL-safe) string to ArrayBuffer */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  let standardBase64 = base64.replace(/-/g, '+').replace(/_/g, '/')
  const pad = standardBase64.length % 4
  if (pad) {
    standardBase64 += '='.repeat(4 - pad)
  }
  const binaryString = atob(standardBase64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes.buffer
}

export const Route = createFileRoute('/app/')({
  component: WorkspaceExplorer,
})

/** Build FileManager file objects from workspace IDs.
 *  Each workspace is a folder containing a prompt.md file. */
function workspacesToFiles(ids: string[]) {
  const files: Array<{
    name: string
    isDirectory: boolean
    path: string
    updatedAt: string
    size?: number
  }> = []

  for (const id of ids) {
    // The workspace folder
    files.push({
      name: id,
      isDirectory: true,
      path: `/${id}`,
      updatedAt: new Date().toISOString(),
    })
    // prompt.md inside each workspace
    files.push({
      name: 'prompt.md',
      isDirectory: false,
      path: `/${id}/prompt.md`,
      updatedAt: new Date().toISOString(),
      size: 256,
    })
  }

  return files
}

function WorkspaceExplorer() {
  const navigate = useNavigate()
  const { user, loading: authLoading, idToken, signOut } = useAuth()
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [orbActive, setOrbActive] = useState(false)
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null)
  const orbActiveRef = useRef(false)

  // --- Audio playback (agent -> speaker) ---
  const { play: playAudio, stop: stopPlayback, destroy: destroyPlayback, ensureInit: ensurePlaybackInit } = useAudioPlayback()

  // --- WebSocket event handler ---
  const handleEvent = useCallback(
    (event: WsEvent) => {
      const content = event.content as
        | { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> }
        | undefined
      if (content?.parts) {
        for (const part of content.parts) {
          if (
            part.inlineData?.data &&
            part.inlineData.mimeType?.startsWith('audio/')
          ) {
            const pcmBuffer = base64ToArrayBuffer(part.inlineData.data)
            playAudio(pcmBuffer)
          }
        }
      }
      if (event.interrupted) {
        stopPlayback()
      }
    },
    [playAudio, stopPlayback],
  )

  const { status, connect, disconnect, sendAudio } = useAgentSocket({
    workspaceId: activeWorkspace ?? '',
    token: idToken,
    onEvent: handleEvent,
  })

  // --- Audio capture (mic -> backend) ---
  const { start: startCapture, stop: stopCapture } = useAudioCapture({
    onChunk: useCallback(
      (pcm: ArrayBuffer) => { sendAudio(pcm) },
      [sendAudio],
    ),
  })

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopCapture()
      destroyPlayback()
    }
  }, [stopCapture, destroyPlayback])

  // Connect WebSocket when a workspace is active
  useEffect(() => {
    if (idToken && activeWorkspace) {
      connect()
    }
    return () => { disconnect() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idToken, activeWorkspace])

  const handleOrbToggle = useCallback(() => {
    // Can't activate the orb without a workspace
    if (!activeWorkspace) return

    const next = !orbActiveRef.current
    orbActiveRef.current = next
    setOrbActive(next)

    if (next) {
      void ensurePlaybackInit()
      stopPlayback()
      startCapture()
    } else {
      stopCapture()
    }
  }, [activeWorkspace, startCapture, stopCapture, stopPlayback, ensurePlaybackInit])

  // Track which workspace folder the user is in.
  // When navigating back to root, deactivate the orb and stop audio.
  const handleFolderChange = useCallback((path: string) => {
    const parts = path.split('/').filter(Boolean)
    const wsId = parts.length > 0 ? parts[0] : null

    if (!wsId && orbActiveRef.current) {
      // Leaving a workspace — deactivate orb
      orbActiveRef.current = false
      setOrbActive(false)
      stopCapture()
    }

    setActiveWorkspace(wsId)
  }, [stopCapture])

  // Redirect to sign-in if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: '/sign-in' })
    }
  }, [authLoading, user, navigate])

  // Fetch workspaces
  const fetchWorkspaces = useCallback(async () => {
    if (!idToken) return
    try {
      setLoading(true)
      setError(null)
      const data = await listWorkspaces({ data: idToken })
      setWorkspaceIds(data.map((ws) => ws.workspace_id))
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

  // Create workspace -> new folder
  const handleCreateFolder = useCallback(
    async (_name: string) => {
      if (!idToken) return
      try {
        setError(null)
        const ws = await createWorkspace({ data: idToken })
        setWorkspaceIds((prev) => [...prev, ws.workspace_id])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create workspace')
      }
    },
    [idToken],
  )

  // Delete workspace(s)
  const handleDelete = useCallback(
    async (files: Array<{ name: string; isDirectory: boolean; path: string }>) => {
      if (!idToken) return
      try {
        setError(null)
        for (const f of files) {
          if (f.isDirectory) {
            await deleteWorkspace({ data: { token: idToken, workspaceId: f.name } })
          }
        }
        const deletedNames = new Set(files.map((f) => f.name))
        setWorkspaceIds((prev) => prev.filter((id) => !deletedNames.has(id)))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete workspace')
      }
    },
    [idToken],
  )

  const handleRefresh = useCallback(() => {
    fetchWorkspaces()
  }, [fetchWorkspaces])

  if (authLoading || !user) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm text-[#484f58]">loading...</span>
      </div>
    )
  }

  const files = workspacesToFiles(workspaceIds)

  return (
    <div className="flex h-full flex-col">
      {/* Title bar */}
      <div className="shrink-0 flex items-center justify-between border-b border-[#21262d] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[#58a6ff]">asisto</span>
          <span className="text-xs text-[#484f58]">/</span>
          <span className="text-sm text-[#8b949e]">workspaces</span>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="shrink-0 border-b border-[#f85149]/30 bg-[#f85149]/10 px-4 py-2 text-xs text-[#f85149]">
          {error}
        </div>
      )}

      {/* File manager — fills all remaining height */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-[#484f58]">loading workspaces...</span>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <div className="fm-dark-theme h-full">
            <FileManager
              files={files}
              fontFamily="'JetBrains Mono', 'Fira Code', ui-monospace, monospace"
              primaryColor="#58a6ff"
              height="100%"
              width="100%"
              layout="list"
              enableFilePreview={false}
              onCreateFolder={handleCreateFolder}
              onDelete={handleDelete}
              onRefresh={handleRefresh}
              onFolderChange={handleFolderChange}
              permissions={{
                create: true,
                delete: true,
                upload: false,
                move: false,
                copy: false,
                rename: false,
                download: false,
              }}
            />
          </div>

          {/* Orb — bottom-left corner */}
          <div className="absolute bottom-4 left-4 z-10" style={{ width: 56, height: 56 }}>
            <Suspense fallback={null}>
              <Orb
                active={orbActive}
                disabled={!activeWorkspace}
                onToggle={handleOrbToggle}
                size={56}
              />
            </Suspense>
          </div>
        </div>
      )}

      {/* Status bar */}
      <div className="shrink-0 flex items-center justify-between border-t border-[#21262d] px-4 py-1">
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#484f58]">
            {workspaceIds.length} workspace{workspaceIds.length !== 1 ? 's' : ''}
          </span>
          {activeWorkspace ? (
            <>
              <span className="text-xs text-[#484f58]">|</span>
              <span className="text-xs text-[#8b949e]">{activeWorkspace}</span>
              <WsStatusIndicator status={status} />
              {orbActive && (
                <span className="text-xs text-[#3fb950]">listening</span>
              )}
            </>
          ) : (
            <span className="text-xs text-[#484f58] italic">no workspace selected</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#484f58]">{user.displayName || user.email}</span>
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

function WsStatusIndicator({ status }: { status: WsStatus }) {
  const color: Record<WsStatus, string> = {
    disconnected: '#484f58',
    connecting: '#d29922',
    connected: '#3fb950',
    error: '#f85149',
  }
  return (
    <span
      className="inline-block h-2 w-2 rounded-full"
      title={status}
      style={{ backgroundColor: color[status] }}
    />
  )
}
