import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../lib/useAuth'
import { deleteWorkspace } from '../../lib/api'
import { useAgentSocket, type WsEvent, type WsStatus } from '../../lib/useAgentSocket'
import { useAudioCapture } from '../../lib/useAudioCapture'
import { useAudioPlayback } from '../../lib/useAudioPlayback'
import { SurfaceRenderer, useA2UIStore } from '../../a2ui'

const Orb = lazy(() => import('../../components/Orb'))

/** Decode base64 (standard or URL-safe) string to ArrayBuffer */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  // Convert URL-safe base64 to standard base64
  let standardBase64 = base64.replace(/-/g, '+').replace(/_/g, '/')
  // Add padding if needed
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

export const Route = createFileRoute('/app/$workspaceId')({
  component: WorkspaceView,
})

function WorkspaceView() {
  const { workspaceId } = Route.useParams()
  const navigate = useNavigate()
  const { user, loading: authLoading, idToken, signOut } = useAuth()
  const [orbActive, setOrbActive] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const orbActiveRef = useRef(false)

  // --- Audio playback (agent → speaker) ---
  const { play: playAudio, stop: stopPlayback, destroy: destroyPlayback, ensureInit: ensurePlaybackInit } = useAudioPlayback()

  // --- A2UI store ---
  const syncA2UIState = useA2UIStore((s) => s.syncFromState)
  const clearA2UISurfaces = useA2UIStore((s) => s.clearAll)
  const hasSurfaces = useA2UIStore((s) => s.surfaces.size > 0)

  // --- WebSocket ---
  const handleEvent = useCallback(
    (event: WsEvent) => {
      // --- A2UI state sync from backend ---
      // Backend sends: {"type": "a2ui_state", "state": {"surfaces": {...}}}
      if (event.type === 'a2ui_state' && event.state) {
        syncA2UIState(event.state as Record<string, unknown>)
        return
      }

      // Audio response: content.parts[].inlineData.data (base64 PCM int16)
      // Field names are camelCase (pydantic by_alias=True serialization)
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

      // Interrupted — agent was cut off (user started talking)
      if (event.interrupted) {
        stopPlayback()
      }
    },
    [playAudio, stopPlayback, syncA2UIState],
  )

  const { status, connect, disconnect, sendAudio, sendText } = useAgentSocket({
    workspaceId,
    token: idToken,
    onEvent: handleEvent,
  })

  // --- A2UI action handler (button clicks, form submissions, etc.) ---
  const handleA2UIAction = useCallback(
    (surfaceId: string, name: string, context?: Record<string, unknown>) => {
      // Send action back to the agent via WebSocket as a JSON text message
      sendText(JSON.stringify({
        type: 'a2ui_action',
        action: { surfaceId, name, context },
      }))
    },
    [sendText],
  )

  // --- Audio capture (mic → backend) ---
  const { start: startCapture, stop: stopCapture } = useAudioCapture({
    onChunk: useCallback(
      (pcm: ArrayBuffer) => {
        sendAudio(pcm)
      },
      [sendAudio],
    ),
  })

  // Redirect to sign-in if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: '/sign-in' })
    }
  }, [authLoading, user, navigate])

  // Connect WebSocket once when workspace loads and token is ready.
  // connect/disconnect are stable refs (token + workspaceId read from refs inside the hook).
  useEffect(() => {
    if (idToken && workspaceId) {
      connect()
    }
    return () => {
      disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idToken, workspaceId])

  // Clean up audio and A2UI on unmount
  useEffect(() => {
    return () => {
      stopCapture()
      destroyPlayback()
      clearA2UISurfaces()
    }
  }, [stopCapture, destroyPlayback, clearA2UISurfaces])

  const handleDelete = useCallback(async () => {
    if (!idToken || deleting) return
    try {
      setDeleting(true)
      disconnect()
      await deleteWorkspace({ data: { token: idToken, workspaceId } })
      navigate({ to: '/app' })
    } catch {
      setDeleting(false)
    }
  }, [idToken, workspaceId, deleting, disconnect, navigate])

  const handleOrbToggle = useCallback(() => {
    const next = !orbActiveRef.current
    orbActiveRef.current = next
    setOrbActive(next)

    if (next) {
      // Init playback AudioContext during user gesture so the browser allows it
      void ensurePlaybackInit()
      // Stop any ongoing playback when user starts talking
      stopPlayback()
      startCapture()
    } else {
      stopCapture()
    }
  }, [startCapture, stopCapture, stopPlayback, ensurePlaybackInit])

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
          <Link
            to="/app"
            className="text-sm text-[#58a6ff] no-underline transition hover:text-[#79c0ff]"
          >
            asisto
          </Link>
          <span className="text-xs text-[#484f58]">/</span>
          <span className="text-sm text-[#8b949e]">workspaces</span>
          <span className="text-xs text-[#484f58]">/</span>
          <span className="text-sm font-medium text-[#c9d1d9]">
            {workspaceId}
          </span>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="flex items-center gap-1.5 text-xs text-[#484f58] transition hover:text-[#f85149] disabled:opacity-50"
          title="Delete workspace"
        >
          <svg
            className="h-3.5 w-3.5 fill-current"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
          </svg>
          {deleting ? 'deleting...' : 'delete'}
        </button>
      </div>

      {/* Main content area */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Workspace content — visible when orb is active */}
        <div
          className="flex flex-1 flex-col transition-opacity duration-700 ease-out"
          style={{ opacity: orbActive ? 1 : 0, pointerEvents: orbActive ? 'auto' : 'none' }}
        >
          {hasSurfaces ? (
            <div className="flex-1 overflow-auto p-4">
              <SurfaceRenderer onAction={handleA2UIAction} />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <span className="text-sm text-[#484f58]">workspace ready</span>
            </div>
          )}
        </div>

        {/* Orb container — centered when idle, top-right when active */}
        <div
          className="absolute transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
          style={
            orbActive
              ? {
                  top: 16,
                  right: 16,
                  width: 56,
                  height: 56,
                  /* reset centering */
                  left: 'auto',
                  transform: 'none',
                }
              : {
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: 200,
                  height: 200,
                }
          }
        >
          <Suspense fallback={null}>
            <Orb
              active={orbActive}
              onToggle={handleOrbToggle}
              size={orbActive ? 56 : 200}
            />
          </Suspense>
        </div>

        {/* Hint text — only when idle and connected */}
        {!orbActive && status === 'connected' && (
          <span className="absolute bottom-8 left-1/2 -translate-x-1/2 text-xs text-[#484f58] transition-opacity duration-500">
            tap orb to start
          </span>
        )}
        {!orbActive && status !== 'connected' && (
          <span className="absolute bottom-8 left-1/2 -translate-x-1/2 text-xs text-[#484f58] transition-opacity duration-500">
            connecting...
          </span>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-[#21262d] px-4 py-1">
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#484f58]">workspace: {workspaceId}</span>
          <WsStatusIndicator status={status} />
          {orbActive && (
            <span className="text-xs text-[#3fb950]">listening</span>
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
