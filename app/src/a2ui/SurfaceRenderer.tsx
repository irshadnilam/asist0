/**
 * A2UI SurfaceRenderer.
 *
 * Top-level React component that renders all active surfaces (or a specific one).
 * Reads from the Zustand store, builds the component tree, and renders it
 * using the component registry.
 */

import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useA2UIStore } from './store'
import { buildTree } from './tree'
import { renderNode } from './components/render-utils'

interface SurfaceRendererProps {
  /** If provided, render only this surface. Otherwise render all surfaces. */
  surfaceId?: string
  /** Called when a component dispatches a server action. */
  onAction?: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
}

/** Render a single surface. */
function Surface({
  surfaceId,
  onAction,
}: {
  surfaceId: string
  onAction?: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
}) {
  const surface = useA2UIStore((s) => s.surfaces.get(surfaceId))

  const tree = useMemo(() => {
    if (!surface) return null
    return buildTree(surface.components)
  }, [surface])

  const handleAction = useMemo(() => {
    if (!onAction) return undefined
    return (name: string, context?: Record<string, unknown>) => {
      onAction(surfaceId, name, context)
    }
  }, [surfaceId, onAction])

  if (!surface || !tree) {
    return null
  }

  return (
    <div className="a2ui-surface" data-surface-id={surfaceId}>
      {renderNode(tree, surface.dataModel, handleAction)}
    </div>
  )
}

/**
 * SurfaceRenderer — renders one or all A2UI surfaces.
 *
 * Usage:
 *   <SurfaceRenderer />                    — renders all active surfaces
 *   <SurfaceRenderer surfaceId="my_form" /> — renders only "my_form"
 */
export function SurfaceRenderer({ surfaceId, onAction }: SurfaceRendererProps) {
  // useShallow does shallow array comparison — prevents re-render when
  // the surface IDs haven't actually changed.
  const surfaceIds = useA2UIStore(
    useShallow((s) => {
      if (surfaceId) return [surfaceId]
      return Array.from(s.surfaces.keys())
    }),
  )

  if (surfaceIds.length === 0) return null

  return (
    <div className="a2ui-renderer flex flex-col gap-4">
      {surfaceIds.map((id) => (
        <Surface key={id} surfaceId={id} onAction={onAction} />
      ))}
    </div>
  )
}
