/**
 * WebSocket hook for Gemini Live bidirectional streaming.
 *
 * Connects directly from the browser to the FastAPI backend WebSocket endpoint.
 * REST calls go through TanStack Start server functions (no CORS), but WebSocket
 * needs a persistent bidirectional connection so it connects directly.
 *
 * The backend URL is fetched once via a server function (getApiEndpoint) to avoid
 * baking it into the client bundle at build time.
 *
 * Features:
 *   - **Auto-connect** when a valid token is available (no manual connect call)
 *   - Auto-reconnect with exponential backoff on unexpected disconnects
 *   - Always-on: WebSocket stays connected regardless of mic/orb state
 *
 * Protocol:
 *   - Send text: JSON { type: "text", text: "..." }
 *   - Send audio: raw binary frames (PCM 16kHz 16-bit)
 *   - Receive: JSON-encoded ADK Event objects (text, audio, transcriptions,
 *     turn_complete, interrupted, errors, partial)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getApiEndpoint } from './api'

type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WsEvent {
  /** Raw parsed JSON event from the backend ADK runner */
  [key: string]: unknown
}

interface UseAgentSocketOptions {
  /** Workspace (session) ID */
  workspaceId: string
  /** Firebase ID token for auth — WebSocket connects when this becomes non-null */
  token: string | null
  /** Called when a JSON event is received from the backend */
  onEvent?: (event: WsEvent) => void
}

/** Max reconnect attempts before giving up */
const MAX_RETRIES = 5
/** Base delay for exponential backoff (ms) */
const BASE_DELAY = 1000
/** Max delay cap (ms) */
const MAX_DELAY = 15000

export function useAgentSocket({
  workspaceId,
  token,
  onEvent,
}: UseAgentSocketOptions) {
  const [status, setStatus] = useState<WsStatus>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const apiBaseRef = useRef<string | null>(null)

  // Reconnect state
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep mutable refs so the connect function stays stable across renders
  const tokenRef = useRef(token)
  tokenRef.current = token
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  // Track whether we're being torn down (unmount)
  const unmountedRef = useRef(false)

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  const connectInternal = useCallback(async () => {
    if (unmountedRef.current) return

    const currentToken = tokenRef.current
    const currentWorkspaceId = workspaceIdRef.current
    if (!currentToken) return

    // Already open or in the process of opening — don't duplicate
    const ws = wsRef.current
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    setStatus('connecting')

    try {
      // Fetch backend URL from server (runtime, not build-time)
      if (!apiBaseRef.current) {
        apiBaseRef.current = await getApiEndpoint()
      }

      // Convert http(s):// to ws(s)://
      const httpBase = apiBaseRef.current
      const wsBase = httpBase.replace(/^http/, 'ws')
      const url = `${wsBase}/ws/${currentWorkspaceId}?token=${encodeURIComponent(currentToken)}`

      const socket = new WebSocket(url)
      wsRef.current = socket

      socket.onopen = () => {
        if (unmountedRef.current) {
          socket.close()
          return
        }
        setStatus('connected')
        retryCountRef.current = 0
      }

      socket.onmessage = (event) => {
        let data: unknown
        try {
          data = JSON.parse(event.data)
        } catch {
          // Binary or unparseable — ignore
          return
        }

        // Extract and forward to consumer
        const evt = data as WsEvent

        try {
          onEventRef.current?.(evt)
        } catch (err) {
          console.error('[useAgentSocket] error in onEvent handler:', err)
        }
      }

      socket.onclose = () => {
        if (wsRef.current !== socket) return
        wsRef.current = null

        if (unmountedRef.current) {
          setStatus('disconnected')
          return
        }

        // Always attempt reconnect (WebSocket is always-on)
        if (retryCountRef.current < MAX_RETRIES) {
          const delay = Math.min(BASE_DELAY * 2 ** retryCountRef.current, MAX_DELAY)
          retryCountRef.current += 1
          setStatus('connecting')
          retryTimerRef.current = setTimeout(() => {
            connectInternal()
          }, delay)
        } else {
          // Give up after max retries — will retry when token refreshes or
          // component re-renders with a new token
          setStatus('error')
          retryCountRef.current = 0
        }
      }

      socket.onerror = () => {
        // onerror is always followed by onclose, so we handle reconnect there.
        if (wsRef.current === socket) {
          wsRef.current = null
        }
      }
    } catch {
      setStatus('error')
    }
  }, [clearRetryTimer])

  /** Send raw audio data (PCM 16kHz 16-bit) to the agent */
  const sendAudio = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
    }
  }, [])

  // Auto-connect when token becomes available, auto-disconnect on unmount
  useEffect(() => {
    unmountedRef.current = false

    if (token) {
      // Reset retry count on fresh token (e.g. token refresh)
      retryCountRef.current = 0
      connectInternal()
    }

    return () => {
      unmountedRef.current = true
      clearRetryTimer()
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [token, connectInternal, clearRetryTimer])

  return { status, sendAudio }
}
