/**
 * A2UI Surface Store — Zustand store managing all active surfaces.
 *
 * Processes the four A2UI envelope message types:
 *   - createSurface: Initialize a new surface
 *   - updateComponents: Upsert components into a surface's component map
 *   - updateDataModel: Patch or replace a surface's data model
 *   - deleteSurface: Remove a surface entirely
 *
 * The store holds a Map<surfaceId, SurfaceState> and exposes actions
 * corresponding to each message type, plus selectors for use in React.
 */

import { create } from 'zustand'
import type {
  A2UIComponent,
  A2UIEnvelope,
  SurfaceState,
} from './types'

// ---------------------------------------------------------------------------
// JSON Pointer helpers (RFC 6901)
// ---------------------------------------------------------------------------

/** Parse a JSON Pointer string into path segments. */
function parsePointer(pointer: string): string[] {
  if (!pointer || pointer === '/') return []
  // Remove leading slash, then split and unescape
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
}

/**
 * Set a value at a JSON Pointer path in an object (immutable — returns new root).
 * If value is undefined, the key at path is removed.
 */
function setAtPointer(
  root: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  const segments = parsePointer(pointer)

  // Replace entire root
  if (segments.length === 0) {
    if (value === undefined) return {}
    return (typeof value === 'object' && value !== null ? { ...value as Record<string, unknown> } : root)
  }

  // Shallow-clone path to root and set value
  const newRoot = { ...root }
  let current: Record<string, unknown> = newRoot

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const next = current[seg]
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      current[seg] = { ...(next as Record<string, unknown>) }
    } else if (Array.isArray(next)) {
      current[seg] = [...next]
    } else {
      // Path doesn't exist yet — create intermediate objects
      current[seg] = {}
    }
    current = current[seg] as Record<string, unknown>
  }

  const lastSeg = segments[segments.length - 1]
  if (value === undefined) {
    delete current[lastSeg]
  } else {
    current[lastSeg] = value
  }

  return newRoot
}

/**
 * Get a value at a JSON Pointer path. Returns undefined if not found.
 */
export function getAtPointer(
  root: Record<string, unknown>,
  pointer: string,
): unknown {
  const segments = parsePointer(pointer)
  let current: unknown = root
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return current
}

// ---------------------------------------------------------------------------
// Store definition
// ---------------------------------------------------------------------------

export interface A2UIStore {
  /** All active surfaces keyed by surfaceId */
  surfaces: Map<string, SurfaceState>

  // --- Actions ---

  /** Process any A2UI envelope message. Dispatches to the correct handler. */
  processMessage: (envelope: A2UIEnvelope) => void

  /** Create a new surface. */
  createSurface: (
    surfaceId: string,
    catalogId: string,
    theme?: Record<string, unknown>,
    sendDataModel?: boolean,
  ) => void

  /** Upsert components into a surface. */
  updateComponents: (surfaceId: string, components: A2UIComponent[]) => void

  /** Patch or replace data model. */
  updateDataModel: (surfaceId: string, path?: string, value?: unknown) => void

  /** Delete a surface. */
  deleteSurface: (surfaceId: string) => void

  /** Sync entire store from a backend state snapshot.
   *  Backend sends: {"surfaces": {id: {components: {id: comp}, dataModel: {...}}}}
   *  This replaces all surfaces with the snapshot. */
  syncFromState: (snapshot: Record<string, unknown>) => void

  /** Clear all surfaces (e.g., on workspace change). */
  clearAll: () => void
}

export const useA2UIStore = create<A2UIStore>((set, get) => ({
  surfaces: new Map(),

  processMessage: (envelope) => {
    if ('createSurface' in envelope) {
      const { surfaceId, catalogId, theme, sendDataModel } = envelope.createSurface
      get().createSurface(surfaceId, catalogId, theme, sendDataModel)
    } else if ('updateComponents' in envelope) {
      const { surfaceId, components } = envelope.updateComponents
      get().updateComponents(surfaceId, components)
    } else if ('updateDataModel' in envelope) {
      const { surfaceId, path, value } = envelope.updateDataModel
      get().updateDataModel(surfaceId, path, value)
    } else if ('deleteSurface' in envelope) {
      const { surfaceId } = envelope.deleteSurface
      get().deleteSurface(surfaceId)
    }
  },

  createSurface: (surfaceId, catalogId, theme, sendDataModel) => {
    set((state) => {
      const next = new Map(state.surfaces)
      next.set(surfaceId, {
        surfaceId,
        catalogId,
        theme,
        sendDataModel: sendDataModel ?? false,
        components: new Map(),
        dataModel: {},
      })
      return { surfaces: next }
    })
  },

  updateComponents: (surfaceId, components) => {
    set((state) => {
      const surface = state.surfaces.get(surfaceId)
      if (!surface) {
        // Buffer: create a placeholder surface if it doesn't exist yet
        // (spec says components may arrive before createSurface in some edge cases)
        const newComponents = new Map<string, A2UIComponent>()
        for (const comp of components) {
          newComponents.set(comp.id, comp)
        }
        const next = new Map(state.surfaces)
        next.set(surfaceId, {
          surfaceId,
          catalogId: '',
          sendDataModel: false,
          components: newComponents,
          dataModel: {},
        })
        return { surfaces: next }
      }

      // Upsert components
      const newComponents = new Map(surface.components)
      for (const comp of components) {
        newComponents.set(comp.id, comp)
      }

      const next = new Map(state.surfaces)
      next.set(surfaceId, { ...surface, components: newComponents })
      return { surfaces: next }
    })
  },

  updateDataModel: (surfaceId, path, value) => {
    set((state) => {
      const surface = state.surfaces.get(surfaceId)
      if (!surface) return state

      const pointer = path ?? '/'
      const newDataModel = setAtPointer(surface.dataModel, pointer, value)

      const next = new Map(state.surfaces)
      next.set(surfaceId, { ...surface, dataModel: newDataModel })
      return { surfaces: next }
    })
  },

  deleteSurface: (surfaceId) => {
    set((state) => {
      const next = new Map(state.surfaces)
      next.delete(surfaceId)
      return { surfaces: next }
    })
  },

  syncFromState: (snapshot) => {
    const surfacesObj = (snapshot as { surfaces?: Record<string, unknown> }).surfaces
    if (!surfacesObj || typeof surfacesObj !== 'object') {
      // Only clear if we actually have surfaces
      if (get().surfaces.size > 0) {
        set({ surfaces: new Map() })
      }
      return
    }

    // Quick check: skip update if surface IDs haven't changed and
    // the JSON representation is identical (avoids unnecessary re-renders
    // when backend sends the same state_delta repeatedly).
    const current = get().surfaces
    const incomingIds = Object.keys(surfacesObj).sort()
    const currentIds = Array.from(current.keys()).sort()
    if (
      incomingIds.length === currentIds.length &&
      incomingIds.every((id, i) => id === currentIds[i])
    ) {
      // Same surface IDs — do a quick JSON comparison per surface
      let identical = true
      for (const id of incomingIds) {
        const raw = surfacesObj[id] as Record<string, unknown> | undefined
        const cur = current.get(id)
        if (!raw || !cur) { identical = false; break }
        // Compare component count as a fast heuristic
        const rawComps = raw.components as Record<string, unknown> | undefined
        if (Object.keys(rawComps ?? {}).length !== cur.components.size) {
          identical = false; break
        }
      }
      if (identical) return
    }

    const next = new Map<string, SurfaceState>()
    for (const [surfaceId, raw] of Object.entries(surfacesObj)) {
      if (!raw || typeof raw !== 'object') continue
      const s = raw as Record<string, unknown>

      // Convert components from {id: comp} object to Map<string, A2UIComponent>
      const componentsObj = (s.components ?? {}) as Record<string, A2UIComponent>
      const componentsMap = new Map<string, A2UIComponent>()
      for (const [compId, comp] of Object.entries(componentsObj)) {
        if (comp && typeof comp === 'object') {
          componentsMap.set(compId, comp)
        }
      }

      next.set(surfaceId, {
        surfaceId,
        catalogId: (s.catalogId as string) ?? '',
        sendDataModel: (s.sendDataModel as boolean) ?? false,
        theme: s.theme as Record<string, unknown> | undefined,
        components: componentsMap,
        dataModel: (s.dataModel ?? {}) as Record<string, unknown>,
      })
    }

    set({ surfaces: next })
  },

  clearAll: () => {
    set({ surfaces: new Map() })
  },
}))

// Expose store on window in dev mode for console testing
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__a2ui = useA2UIStore
}
