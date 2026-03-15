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
 * Protocol:
 *   - Send text: JSON { type: "text", text: "..." }
 *   - Send audio: raw binary frames (PCM 16kHz 16-bit)
 *   - Receive: JSON-encoded ADK Event objects (text, audio, transcriptions, turn_complete, interrupted)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getApiEndpoint } from './api'

export type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WsEvent {
  /** Raw parsed JSON event from the backend ADK runner */
  [key: string]: unknown
}

interface UseAgentSocketOptions {
  /** Workspace (session) ID */
  workspaceId: string
  /** Firebase ID token for auth */
  token: string | null
  /** Called when a JSON event is received from the backend */
  onEvent?: (event: WsEvent) => void
  /** Called when the connection status changes */
  onStatusChange?: (status: WsStatus) => void
}

export function useAgentSocket({
  workspaceId,
  token,
  onEvent,
  onStatusChange,
}: UseAgentSocketOptions) {
  const [status, setStatus] = useState<WsStatus>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const apiBaseRef = useRef<string | null>(null)

  // Keep mutable refs so connect/disconnect can stay stable across renders
  const tokenRef = useRef(token)
  tokenRef.current = token
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const onStatusChangeRef = useRef(onStatusChange)
  onStatusChangeRef.current = onStatusChange

  const updateStatus = useCallback((s: WsStatus) => {
    setStatus(s)
    onStatusChangeRef.current?.(s)
  }, [])

  const connect = useCallback(async () => {
    const currentToken = tokenRef.current
    const currentWorkspaceId = workspaceIdRef.current
    if (!currentToken) return

    // Already open or in the process of opening — don't duplicate
    const ws = wsRef.current
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    updateStatus('connecting')

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
        updateStatus('connected')
      }

      socket.onmessage = (event) => {
        let data: unknown
        try {
          data = JSON.parse(event.data)
        } catch {
          // Binary or unparseable — ignore
          return
        }
        try {
          onEventRef.current?.(data as WsEvent)
        } catch (err) {
          console.error('[useAgentSocket] error in onEvent handler:', err)
        }
      }

      socket.onclose = () => {
        // Only update status if this is still the active socket
        if (wsRef.current === socket) {
          wsRef.current = null
          updateStatus('disconnected')
        }
      }

      socket.onerror = () => {
        if (wsRef.current === socket) {
          wsRef.current = null
          updateStatus('error')
        }
      }
    } catch {
      updateStatus('error')
    }
  }, [updateStatus])

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    updateStatus('disconnected')
  }, [updateStatus])

  /** Send a text message to the agent */
  const sendText = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'text', text }))
    }
  }, [])

  /** Send raw audio data (PCM 16kHz 16-bit) to the agent */
  const sendAudio = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
    }
  }, [])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [])

  return { status, connect, disconnect, sendText, sendAudio }
}
