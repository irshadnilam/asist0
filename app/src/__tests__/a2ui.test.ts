/**
 * A2UI Store + Tree Builder unit tests.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useA2UIStore } from '../a2ui/store'
import { buildTree } from '../a2ui/tree'
import type {
  CreateSurfaceMessage,
  UpdateComponentsMessage,
  UpdateDataModelMessage,
  DeleteSurfaceMessage,
  A2UIComponent,
} from '../a2ui/types'

// Reset the store before each test
beforeEach(() => {
  useA2UIStore.getState().clearAll()
})

describe('A2UI Store', () => {
  it('creates a surface via processMessage', () => {
    const msg: CreateSurfaceMessage = {
      version: 'v0.9',
      createSurface: {
        surfaceId: 'test_surface',
        catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
        theme: { primaryColor: '#00BFFF' },
        sendDataModel: true,
      },
    }

    useA2UIStore.getState().processMessage(msg)
    const surface = useA2UIStore.getState().surfaces.get('test_surface')

    expect(surface).toBeDefined()
    expect(surface!.surfaceId).toBe('test_surface')
    expect(surface!.catalogId).toBe('https://a2ui.org/specification/v0_9/basic_catalog.json')
    expect(surface!.sendDataModel).toBe(true)
    expect(surface!.theme).toEqual({ primaryColor: '#00BFFF' })
    expect(surface!.components.size).toBe(0)
    expect(surface!.dataModel).toEqual({})
  })

  it('upserts components via processMessage', () => {
    // Create surface first
    useA2UIStore.getState().createSurface('s1', 'catalog')

    const msg: UpdateComponentsMessage = {
      version: 'v0.9',
      updateComponents: {
        surfaceId: 's1',
        components: [
          { id: 'root', component: 'Column', children: ['title'] } as A2UIComponent,
          { id: 'title', component: 'Text', text: 'Hello' } as A2UIComponent,
        ],
      },
    }

    useA2UIStore.getState().processMessage(msg)
    const surface = useA2UIStore.getState().surfaces.get('s1')

    expect(surface!.components.size).toBe(2)
    expect(surface!.components.get('root')!.component).toBe('Column')
    expect(surface!.components.get('title')!.component).toBe('Text')
  })

  it('updates data model at a specific path', () => {
    useA2UIStore.getState().createSurface('s1', 'catalog')

    const msg: UpdateDataModelMessage = {
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 's1',
        path: '/user/name',
        value: 'Alice',
      },
    }

    useA2UIStore.getState().processMessage(msg)
    const surface = useA2UIStore.getState().surfaces.get('s1')

    expect(surface!.dataModel).toEqual({ user: { name: 'Alice' } })
  })

  it('replaces entire data model when path is /', () => {
    useA2UIStore.getState().createSurface('s1', 'catalog')
    useA2UIStore.getState().updateDataModel('s1', '/user/name', 'Alice')

    useA2UIStore.getState().processMessage({
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 's1',
        value: { brand: 'Asisto' },
      },
    })

    const surface = useA2UIStore.getState().surfaces.get('s1')
    expect(surface!.dataModel).toEqual({ brand: 'Asisto' })
  })

  it('deletes a surface', () => {
    useA2UIStore.getState().createSurface('s1', 'catalog')
    expect(useA2UIStore.getState().surfaces.has('s1')).toBe(true)

    const msg: DeleteSurfaceMessage = {
      version: 'v0.9',
      deleteSurface: { surfaceId: 's1' },
    }

    useA2UIStore.getState().processMessage(msg)
    expect(useA2UIStore.getState().surfaces.has('s1')).toBe(false)
  })

  it('clearAll removes all surfaces', () => {
    useA2UIStore.getState().createSurface('s1', 'catalog')
    useA2UIStore.getState().createSurface('s2', 'catalog')
    expect(useA2UIStore.getState().surfaces.size).toBe(2)

    useA2UIStore.getState().clearAll()
    expect(useA2UIStore.getState().surfaces.size).toBe(0)
  })

  it('syncFromState replaces all surfaces from a backend snapshot', () => {
    // Start with an existing surface
    useA2UIStore.getState().createSurface('old', 'catalog')
    expect(useA2UIStore.getState().surfaces.has('old')).toBe(true)

    // Sync from backend snapshot — old surface should be gone
    useA2UIStore.getState().syncFromState({
      surfaces: {
        'profile': {
          catalogId: 'basic',
          components: {
            'root': { id: 'root', component: 'Card', child: 'name' },
            'name': { id: 'name', component: 'Text', text: 'Alice' },
          },
          dataModel: { user: { name: 'Alice' } },
        },
        'tasks': {
          catalogId: 'basic',
          components: {
            'root': { id: 'root', component: 'Column', children: ['t1'] },
            't1': { id: 't1', component: 'Text', text: 'Task 1' },
          },
          dataModel: {},
        },
      },
    })

    expect(useA2UIStore.getState().surfaces.has('old')).toBe(false)
    expect(useA2UIStore.getState().surfaces.size).toBe(2)

    const profile = useA2UIStore.getState().surfaces.get('profile')
    expect(profile).toBeDefined()
    expect(profile!.catalogId).toBe('basic')
    expect(profile!.components.size).toBe(2)
    expect(profile!.components.get('name')!.component).toBe('Text')
    expect(profile!.dataModel).toEqual({ user: { name: 'Alice' } })

    const tasks = useA2UIStore.getState().surfaces.get('tasks')
    expect(tasks).toBeDefined()
    expect(tasks!.components.size).toBe(2)
  })

  it('syncFromState handles empty snapshot', () => {
    useA2UIStore.getState().createSurface('s1', 'catalog')
    useA2UIStore.getState().syncFromState({ surfaces: {} })
    expect(useA2UIStore.getState().surfaces.size).toBe(0)
  })

  it('syncFromState handles missing surfaces key', () => {
    useA2UIStore.getState().createSurface('s1', 'catalog')
    useA2UIStore.getState().syncFromState({})
    expect(useA2UIStore.getState().surfaces.size).toBe(0)
  })
})

describe('Tree Builder', () => {
  it('builds a simple tree from root', () => {
    const components = new Map<string, A2UIComponent>([
      ['root', { id: 'root', component: 'Column', children: ['title', 'subtitle'] } as A2UIComponent],
      ['title', { id: 'title', component: 'Text', text: 'Hello' } as A2UIComponent],
      ['subtitle', { id: 'subtitle', component: 'Text', text: 'World' } as A2UIComponent],
    ])

    const tree = buildTree(components)
    expect(tree).not.toBeNull()
    expect(tree!.component.id).toBe('root')
    expect(tree!.children.length).toBe(2)
    expect(tree!.children[0].component.id).toBe('title')
    expect(tree!.children[1].component.id).toBe('subtitle')
  })

  it('returns null if root not found', () => {
    const components = new Map<string, A2UIComponent>([
      ['title', { id: 'title', component: 'Text', text: 'Hello' } as A2UIComponent],
    ])

    const tree = buildTree(components)
    expect(tree).toBeNull()
  })

  it('skips missing children gracefully (progressive rendering)', () => {
    const components = new Map<string, A2UIComponent>([
      ['root', { id: 'root', component: 'Column', children: ['title', 'missing_child'] } as A2UIComponent],
      ['title', { id: 'title', component: 'Text', text: 'Hello' } as A2UIComponent],
    ])

    const tree = buildTree(components)
    expect(tree).not.toBeNull()
    expect(tree!.children.length).toBe(1)
    expect(tree!.children[0].component.id).toBe('title')
  })

  it('handles Card with single child', () => {
    const components = new Map<string, A2UIComponent>([
      ['root', { id: 'root', component: 'Card', child: 'content' } as A2UIComponent],
      ['content', { id: 'content', component: 'Text', text: 'Inside card' } as A2UIComponent],
    ])

    const tree = buildTree(components)
    expect(tree).not.toBeNull()
    expect(tree!.children.length).toBe(1)
    expect(tree!.children[0].component.id).toBe('content')
  })

  it('handles deep nesting', () => {
    const components = new Map<string, A2UIComponent>([
      ['root', { id: 'root', component: 'Card', child: 'col' } as A2UIComponent],
      ['col', { id: 'col', component: 'Column', children: ['row'] } as A2UIComponent],
      ['row', { id: 'row', component: 'Row', children: ['text1', 'text2'] } as A2UIComponent],
      ['text1', { id: 'text1', component: 'Text', text: 'A' } as A2UIComponent],
      ['text2', { id: 'text2', component: 'Text', text: 'B' } as A2UIComponent],
    ])

    const tree = buildTree(components)
    expect(tree).not.toBeNull()
    expect(tree!.component.id).toBe('root')
    expect(tree!.children[0].component.id).toBe('col')
    expect(tree!.children[0].children[0].component.id).toBe('row')
    expect(tree!.children[0].children[0].children.length).toBe(2)
  })

  it('prevents circular references', () => {
    const components = new Map<string, A2UIComponent>([
      ['root', { id: 'root', component: 'Column', children: ['child'] } as A2UIComponent],
      ['child', { id: 'child', component: 'Column', children: ['root'] } as A2UIComponent],
    ])

    const tree = buildTree(components)
    expect(tree).not.toBeNull()
    // root → child, but child cannot reference root again (circular)
    expect(tree!.children.length).toBe(1)
    expect(tree!.children[0].children.length).toBe(0)
  })
})
