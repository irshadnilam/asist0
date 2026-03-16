/**
 * useWorkspace — persist and restore workspace layout via backend API.
 *
 * Saves a snapshot of open windows (positions, sizes, min/max state)
 * and the file manager's current path. Auto-saves on changes (debounced),
 * restores on mount.
 *
 * Backend: PUT /workspace (save) and GET /workspace (restore)
 * Firestore path (on backend): users/{uid}/workspace/layout
 */

import { useCallback, useEffect, useRef } from 'react'
import { getWorkspaceLayout, saveWorkspaceLayout } from './api'
import type { WindowState } from '../components/Window'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WindowSnapshot {
  fileId: string
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
  maximized: boolean
  zIndex: number
}

export interface WorkspaceSnapshot {
  /** Schema version for forward compatibility */
  version: 1
  /** ISO timestamp of last save */
  savedAt: string
  /** Open windows in z-index order */
  windows: WindowSnapshot[]
  /** File manager's currently browsed folder */
  fileManagerPath: string | null
  /** Viewport dimensions at save time (for proportional repositioning) */
  viewport: { width: number; height: number }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 2000

interface UseWorkspaceOpts {
  uid: string | null
  token: string | null
}

export function useWorkspace({ uid, token }: UseWorkspaceOpts) {
  // Mutable map of window states (updated on every move/resize/focus)
  const windowStatesRef = useRef<Map<string, WindowSnapshot>>(new Map())
  // Mutable extras that get merged into the snapshot on save
  const fileManagerPathRef = useRef<string | null>(null)
  // Debounce timer
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track whether initial restore has happened
  const restoredRef = useRef(false)
  // Prevent saving during restore
  const suppressSaveRef = useRef(false)
  // Keep token ref current for async callbacks
  const tokenRef = useRef(token)
  tokenRef.current = token

  // ------------------------------------------------------------------
  // Save
  // ------------------------------------------------------------------

  const saveNow = useCallback(async () => {
    const currentToken = tokenRef.current
    if (!uid || !currentToken || suppressSaveRef.current) return
    const windows = Array.from(windowStatesRef.current.values())
      // Sort by z-index so restore order is consistent
      .sort((a, b) => a.zIndex - b.zIndex)

    const snapshot: WorkspaceSnapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      windows,
      fileManagerPath: fileManagerPathRef.current,
      viewport: {
        width: typeof window !== 'undefined' ? window.innerWidth : 1920,
        height: typeof window !== 'undefined' ? window.innerHeight : 1080,
      },
    }

    try {
      await saveWorkspaceLayout({
        data: { token: currentToken, snapshot: snapshot as unknown as Record<string, unknown> },
      })
    } catch {
      // Silently fail — workspace save is best-effort
    }
  }, [uid])

  /** Schedule a debounced save */
  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      saveNow()
    }, DEBOUNCE_MS)
  }, [saveNow])

  // ------------------------------------------------------------------
  // Restore
  // ------------------------------------------------------------------

  const restore = useCallback(
    async (): Promise<WorkspaceSnapshot | null> => {
      const currentToken = tokenRef.current
      if (!uid || !currentToken) return null
      try {
        const data = await getWorkspaceLayout({ data: currentToken })
        if (!data || !('version' in data)) return null
        const snapshot = data as unknown as WorkspaceSnapshot
        if (snapshot.version !== 1) return null
        restoredRef.current = true
        return snapshot
      } catch {
        return null
      }
    },
    [uid],
  )

  // ------------------------------------------------------------------
  // State update handlers (called from app)
  // ------------------------------------------------------------------

  /** Called by Window.onStateChange for every move/resize/focus/min/max */
  const updateWindowState = useCallback(
    (fileId: string, state: WindowState) => {
      windowStatesRef.current.set(fileId, { fileId, ...state })
      scheduleSave()
    },
    [scheduleSave],
  )

  /** Called when a window is closed */
  const removeWindowState = useCallback(
    (fileId: string) => {
      windowStatesRef.current.delete(fileId)
      scheduleSave()
    },
    [scheduleSave],
  )

  /** Called when files are opened (batch, e.g. during restore) */
  const setWindowStates = useCallback(
    (snapshots: WindowSnapshot[]) => {
      windowStatesRef.current.clear()
      for (const s of snapshots) {
        windowStatesRef.current.set(s.fileId, s)
      }
    },
    [],
  )

  /** Update the file manager path for next save */
  const setFileManagerPath = useCallback(
    (path: string | null) => {
      fileManagerPathRef.current = path
      scheduleSave()
    },
    [scheduleSave],
  )

  /** Temporarily suppress saves (e.g. during restore) */
  const suppressSave = useCallback((suppress: boolean) => {
    suppressSaveRef.current = suppress
  }, [])

  // Flush pending save on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        // Fire a final save
        saveNow()
      }
    }
  }, [saveNow])

  return {
    restore,
    updateWindowState,
    removeWindowState,
    setWindowStates,
    setFileManagerPath,
    suppressSave,
    scheduleSave,
  }
}
