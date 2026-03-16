/**
 * Window — thin React wrapper around WinBox.js
 *
 * Creates a WinBox instance on mount, renders React children into
 * winbox.body via a portal, and destroys on unmount.
 *
 * WinBox.js accesses `document` at import time (template.js), so it
 * MUST be dynamically imported inside useEffect to avoid SSR crashes.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface WindowProps {
  /** Unique identifier for this window */
  id: string
  /** Window title (shown in title bar) */
  title: string
  /** React children rendered inside the window body */
  children: ReactNode
  /** Initial width (px or %) */
  width?: number | string
  /** Initial height (px or %) */
  height?: number | string
  /** Initial x position (px, %, 'center', 'right') */
  x?: number | string
  /** Initial y position (px, %, 'center', 'bottom') */
  y?: number | string
  /** Minimum width */
  minWidth?: number
  /** Minimum height */
  minHeight?: number
  /** Extra CSS class(es) for the WinBox window */
  className?: string
  /** Called when the window is closed (via X button or programmatic) */
  onClose?: (id: string) => void
  /** Called when the window gains focus */
  onFocus?: (id: string) => void
  /** Called when the window is minimized */
  onMinimize?: (id: string) => void
  /** Called when the window is maximized */
  onMaximize?: (id: string) => void
  /** Titlebar icon URL */
  icon?: string
  /** Background color/gradient */
  background?: string
  /** Border width */
  border?: number
  /** Viewport constraints */
  top?: number | string
  bottom?: number | string
}

// WinBox CSS is safe to import at module level (no DOM access)
import 'winbox/dist/css/winbox.min.css'

export default function Window({
  id,
  title,
  children,
  width = 600,
  height = 400,
  x = 'center',
  y = 'center',
  minWidth = 300,
  minHeight = 200,
  className,
  onClose,
  onFocus,
  onMinimize,
  onMaximize,
  icon,
  background,
  border = 1,
  top = 0,
  bottom = 30, // leave space for status bar
}: WindowProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const winboxRef = useRef<any>(null)
  const portalRef = useRef<HTMLDivElement | null>(null)
  const [mounted, setMounted] = useState(false)

  // Keep callback refs stable so WinBox callbacks always see latest
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  const onMinimizeRef = useRef(onMinimize)
  onMinimizeRef.current = onMinimize
  const onMaximizeRef = useRef(onMaximize)
  onMaximizeRef.current = onMaximize

  // Create WinBox instance on mount — dynamic import to avoid SSR crash
  useEffect(() => {
    let cancelled = false

    async function create() {
      // Dynamic import: WinBox accesses `document` at load time
      const { default: WinBox } = await import('winbox/src/js/winbox.js')
      if (cancelled) return

      // Create a container div for the React portal
      const container = document.createElement('div')
      container.style.width = '100%'
      container.style.height = '100%'
      container.style.overflow = 'hidden'
      portalRef.current = container

      const wb = new WinBox({
        id: `wb-${id}`,
        title,
        width,
        height,
        x,
        y,
        minwidth: minWidth,
        minheight: minHeight,
        border,
        top,
        bottom,
        class: className ? `asisto-window ${className}` : 'asisto-window',
        background: background || '#161b22',
        icon,
        mount: container,
        onclose() {
          onCloseRef.current?.(id)
          portalRef.current = null
          winboxRef.current = null
          setMounted(false)
          // Return false to allow closing
          return false
        },
        onfocus() {
          onFocusRef.current?.(id)
        },
        onminimize() {
          onMinimizeRef.current?.(id)
        },
        onmaximize() {
          onMaximizeRef.current?.(id)
        },
      })

      winboxRef.current = wb
      setMounted(true)
    }

    create()

    return () => {
      cancelled = true
      // Destroy on unmount (force close, skip onclose callback)
      if (winboxRef.current) {
        try {
          winboxRef.current.close(true)
        } catch {
          // Already closed
        }
        winboxRef.current = null
      }
      portalRef.current = null
      setMounted(false)
    }
    // Only run on mount — id is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Sync title changes
  useEffect(() => {
    winboxRef.current?.setTitle(title)
  }, [title])

  // Sync background changes
  useEffect(() => {
    if (background) winboxRef.current?.setBackground(background)
  }, [background])

  // Render children via portal into the WinBox body
  if (!mounted || !portalRef.current) return null
  return createPortal(children, portalRef.current)
}
