import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Filemanager, WillowDark } from '@svar-ui/react-filemanager'
import '@svar-ui/react-filemanager/all.css'
import {
  createFile,
  deleteFiles,
  downloadFile,
  getDriveInfo,
  moveFiles,
  renameFile,
  type DriveInfo,
} from '../../lib/api'
import { useAuth } from '../../lib/useAuth'
import { useFiles } from '../../lib/useFiles'
import { useAgentSocket, type WsEvent } from '../../lib/useAgentSocket'
import { useAudioCapture } from '../../lib/useAudioCapture'
import { useAudioPlayback } from '../../lib/useAudioPlayback'
import FileViewer from '../../components/FileViewer'
import Window from '../../components/Window'
import Orb from '../../components/Orb'

export const Route = createFileRoute('/app/')({
  component: AppPage,
})

/** Cascade offset for new windows (px) */
const CASCADE_OFFSET = 30
const INITIAL_WIDTH = 700
const INITIAL_HEIGHT = 500

function AppPage() {
  const navigate = useNavigate()
  const { user, loading: authLoading, idToken, signOut } = useAuth()
  const [drive, setDrive] = useState<DriveInfo>({ used: 0, total: 1073741824 })
  const [error, setError] = useState<string | null>(null)
  const idTokenRef = useRef(idToken)

  // Firestore realtime file subscription
  const {
    allFiles,
    getChildren,
    loading: filesLoading,
    error: filesError,
  } = useFiles(user?.uid ?? null)

  // --- Multi-window state ---
  // Ordered list of open file IDs (order = creation order for cascade)
  const [openWindows, setOpenWindows] = useState<string[]>([])
  // Counter for cascading position
  const cascadeCountRef = useRef(0)

  const openFile = useCallback((fileId: string) => {
    setOpenWindows((prev) => {
      if (prev.includes(fileId)) {
        // Already open — WinBox will handle focus via its own z-index
        // We just need to programmatically focus it
        const el = document.getElementById(`wb-${CSS.escape(fileId)}`)
        if (el && (el as any).winbox) {
          ;(el as any).winbox.focus()
        }
        return prev
      }
      cascadeCountRef.current += 1
      return [...prev, fileId]
    })
  }, [])

  const closeWindow = useCallback((fileId: string) => {
    setOpenWindows((prev) => prev.filter((id) => id !== fileId))
  }, [])

  // --- Agent state ---
  // micActive = orb is on, user is speaking. WebSocket is always-on independently.
  const [micActive, setMicActive] = useState(false)
  const [transcript, setTranscript] = useState<string>('')
  const [agentError, setAgentError] = useState<string | null>(null)
  const [agentStreaming, setAgentStreaming] = useState(false)
  const WORKSPACE_ID = 'default'

  // Audio playback (PCM 24kHz from Gemini → speaker) — always ready
  const {
    play: playAudio,
    stop: stopAudio,
    destroy: destroyAudio,
  } = useAudioPlayback()

  // WebSocket hook — auto-connects when idToken is available, always stays connected
  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      // Audio data: base64 inline data → PCM playback (always plays)
      const content = event.content as
        | { parts?: Array<{ inlineData?: { data: string } }> }
        | undefined
      if (content?.parts) {
        for (const part of content.parts) {
          if (part.inlineData?.data) {
            const binStr = atob(part.inlineData.data)
            const buf = new ArrayBuffer(binStr.length)
            const view = new Uint8Array(buf)
            for (let i = 0; i < binStr.length; i++) view[i] = binStr.charCodeAt(i)
            playAudio(buf)
          }
        }
      }

      // Transcriptions
      const inputT = event.inputTranscription as
        | { text?: string; finished?: boolean }
        | undefined
      if (inputT?.finished && inputT.text) {
        setTranscript(inputT.text)
      }
      const outputT = event.outputTranscription as
        | { text?: string; finished?: boolean }
        | undefined
      if (outputT?.finished && outputT.text) {
        setTranscript(outputT.text)
      }

      // On interrupt, stop audio playback buffer
      if (event.interrupted) {
        stopAudio()
      }

      // Streaming indicator: partial=true means agent is mid-response
      if (event.partial === true) {
        setAgentStreaming(true)
      }

      // Turn complete: agent finished responding
      if (event.turnComplete) {
        setAgentStreaming(false)
      }

      // Agent errors — show to user briefly, auto-dismiss after 8s
      if (event.errorCode || event.errorMessage) {
        const errMsg = (event.errorMessage as string) || (event.errorCode as string) || 'Unknown error'
        setAgentError(errMsg)
        setTimeout(() => setAgentError(null), 8000)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const { status: wsStatus, sendAudio } = useAgentSocket({
    workspaceId: WORKSPACE_ID,
    token: idToken,
    onEvent: handleWsEvent,
  })

  // Audio capture (mic → PCM 16kHz → WebSocket)
  const { start: startMic, stop: stopMic } = useAudioCapture({
    onChunk: sendAudio,
  })

  // Toggle mic: orb only controls microphone capture
  const toggleMic = useCallback(async () => {
    if (micActive) {
      stopMic()
      setMicActive(false)
    } else {
      await startMic()
      setMicActive(true)
    }
  }, [micActive, startMic, stopMic])

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      destroyAudio()
    }
  }, [destroyAudio])

  // SVAR api ref for pushing realtime updates
  const svarApiRef = useRef<any>(null)
  const getChildrenRef = useRef(getChildren)
  getChildrenRef.current = getChildren

  // Keep refs for callbacks used inside SVAR init
  const openFileRef = useRef(openFile)
  openFileRef.current = openFile
  const allFilesRef = useRef(allFiles)
  allFilesRef.current = allFiles

  // Keep token ref in sync so init callbacks always have latest token
  useEffect(() => {
    idTokenRef.current = idToken
  }, [idToken])

  // Redirect to sign-in if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: '/sign-in' })
    }
  }, [authLoading, user, navigate])

  // Fetch drive info (not part of realtime — it's a computed aggregate)
  useEffect(() => {
    if (!idToken) return
    getDriveInfo({ data: idToken })
      .then((info) => setDrive(info.stats))
      .catch((err) => console.error('[asisto] getDriveInfo error:', err))
  }, [idToken, allFiles.length])

  // Surface realtime subscription errors
  useEffect(() => {
    if (filesError) setError(filesError)
  }, [filesError])

  // --- SVAR Filemanager init callback ---
  const initFilemanager = useCallback(
    (api: any) => {
      svarApiRef.current = api

      // Intercept open-file BEFORE SVAR processes it — handle entirely ourselves.
      // Return false to stop SVAR's internal event pipeline.
      api.intercept('open-file', (ev: any) => {
        if (ev.id) {
          // Don't open folders as file viewers
          const match = allFilesRef.current.find((f: any) => f.id === ev.id)
          if (match?.type === 'folder') return false
          openFileRef.current(ev.id)
        }
        return false
      })

      // Lazy loading: use realtime data (no server call needed)
      api.on('request-data', (ev: any) => {
        const children = getChildrenRef.current(ev.id)
        api.exec('provide-data', { data: children, id: ev.id })
      })

      // Create file/folder
      api.on('create-file', async (ev: any) => {
        const token = idTokenRef.current
        if (!token) return
        try {
          const name = ev.file?.name || 'untitled'
          const type = ev.file?.type || 'folder'
          const parentId = ev.parent || '/'
          await createFile({
            data: { token, parentId, name, type },
          })
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to create')
        }
      })

      // Rename
      api.on('rename-file', async (ev: any) => {
        const token = idTokenRef.current
        if (!token) return
        try {
          await renameFile({
            data: { token, fileId: ev.id, name: ev.name },
          })
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to rename')
        }
      })

      // Delete
      api.on('delete-files', async (ev: any) => {
        const token = idTokenRef.current
        if (!token) return
        try {
          await deleteFiles({ data: { token, ids: ev.ids } })
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to delete')
        }
      })

      // Copy
      api.on('copy-files', async (ev: any) => {
        const token = idTokenRef.current
        if (!token) return
        try {
          await moveFiles({
            data: { token, ids: ev.ids, target: ev.target, copy: true },
          })
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to copy')
        }
      })

      // Move
      api.on('move-files', async (ev: any) => {
        const token = idTokenRef.current
        if (!token) return
        try {
          await moveFiles({
            data: { token, ids: ev.ids, target: ev.target, copy: false },
          })
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to move')
        }
      })

      // Download (context menu)
      api.on('download-file', async (ev: any) => {
        const token = idTokenRef.current
        if (!token || !ev.id) return
        try {
          const { base64, contentType, filename } = await downloadFile({
            data: { token, fileId: ev.id },
          })
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
          const blob = new Blob([bytes], { type: contentType })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = filename
          a.click()
          URL.revokeObjectURL(url)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to download')
        }
      })
    },
    [],
  )

  if (authLoading || !user) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm text-[#484f58]">loading...</span>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Title bar */}
      <div className="shrink-0 flex items-center justify-between border-b border-[#30363d] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[#58a6ff]">asisto</span>
          <span className="text-xs text-[#484f58]">/</span>
          <span className="text-sm text-[#8b949e]">files</span>
          {openWindows.length > 0 && (
            <>
              <span className="text-xs text-[#484f58]">
                ({openWindows.length} open)
              </span>
            </>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="shrink-0 border-b border-[#f85149]/30 bg-[#f85149]/10 px-4 py-2 text-xs text-[#f85149]">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-3 text-[#f85149]/60 hover:text-[#f85149]"
          >
            dismiss
          </button>
        </div>
      )}

      {/* File manager — always full width */}
      {filesLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-[#484f58]">loading files...</span>
        </div>
      ) : (
        <div className="fm-container">
          <WillowDark>
            <Filemanager
              data={allFiles}
              drive={drive}
              init={initFilemanager}
            />
          </WillowDark>
        </div>
      )}

      {/* Floating file editor windows (WinBox portals) */}
      {idToken &&
        openWindows.map((fileId, index) => {
          const filename = fileId.split('/').pop() || fileId
          // Cascade position: offset each window slightly
          const cascadeX = 80 + (index % 10) * CASCADE_OFFSET
          const cascadeY = 60 + (index % 10) * CASCADE_OFFSET
          return (
            <Window
              key={fileId}
              id={fileId}
              title={filename}
              width={INITIAL_WIDTH}
              height={INITIAL_HEIGHT}
              x={cascadeX}
              y={cascadeY}
              minWidth={350}
              minHeight={250}
              onClose={closeWindow}
              border={1}
              top={0}
              bottom={30}
            >
              <FileViewer
                fileId={fileId}
                token={idToken}
              />
            </Window>
          )
        })}

      {/* Status bar */}
      <div className="shrink-0 flex items-center justify-between border-t border-[#30363d] px-4 py-1">
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#484f58]">
            {allFiles.length} item{allFiles.length !== 1 ? 's' : ''}
          </span>
          {wsStatus === 'connected' && (
            <span className="text-xs text-[#3fb950]">●</span>
          )}
          {wsStatus === 'connecting' && (
            <span className="text-xs text-[#d29922]">connecting...</span>
          )}
          {wsStatus === 'error' && (
            <span className="text-xs text-[#f85149]">disconnected</span>
          )}
          {agentStreaming && (
            <span className="text-xs text-[#d2a8ff]">thinking...</span>
          )}
          {agentError && (
            <span className="max-w-xs truncate text-xs text-[#f85149]">
              {agentError}
            </span>
          )}
          {!agentError && transcript && (
            <span className="max-w-md truncate text-xs text-[#8b949e]">
              {transcript}
            </span>
          )}
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

      {/* Orb — bottom-center, floating above status bar */}
      <div className="fixed bottom-3 left-1/2 z-50 -translate-x-1/2">
        <Orb
          active={micActive}
          onToggle={toggleMic}
          size={72}
        />
      </div>
    </div>
  )
}
