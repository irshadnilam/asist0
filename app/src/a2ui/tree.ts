/**
 * A2UI Tree Builder.
 *
 * Converts the flat adjacency list of components into a renderable tree
 * starting from the "root" component. The tree is rebuilt on every render
 * from the component map — this is fast for typical A2UI surface sizes.
 */

import type { A2UIComponent, ChildList, ChildListTemplate, ComponentId } from './types'

/** A node in the rendered component tree. */
export interface TreeNode {
  component: A2UIComponent
  children: TreeNode[]
}

function isTemplate(cl: ChildList): cl is ChildListTemplate {
  return typeof cl === 'object' && !Array.isArray(cl) && 'componentId' in cl
}

/**
 * Get ordered child IDs from a component, handling the different
 * ways children can be expressed:
 *   - `children` (ChildList: string[] or template)
 *   - `child` (single ComponentId)
 */
function getChildIds(component: A2UIComponent): ComponentId[] {
  // Single child (Card, Button)
  if ('child' in component && typeof component.child === 'string') {
    return [component.child]
  }

  // ChildList (Row, Column, List)
  if ('children' in component) {
    const cl = component.children as ChildList
    if (Array.isArray(cl)) {
      return cl
    }
    if (isTemplate(cl)) {
      // Phase 5: template iteration — for now return the template component
      return [cl.componentId]
    }
  }

  return []
}

/**
 * Build a tree from the flat component map starting at the given root ID.
 * Returns null if root is not found. Skips missing children gracefully
 * (progressive rendering — they'll appear when updateComponents arrives).
 */
export function buildTree(
  components: Map<string, A2UIComponent>,
  rootId: string = 'root',
): TreeNode | null {
  const rootComp = components.get(rootId)
  if (!rootComp) return null

  const visited = new Set<string>()

  function build(comp: A2UIComponent): TreeNode {
    visited.add(comp.id)
    const childIds = getChildIds(comp)
    const children: TreeNode[] = []

    for (const childId of childIds) {
      // Skip if missing (progressive rendering) or circular reference
      if (visited.has(childId)) continue
      const childComp = components.get(childId)
      if (!childComp) continue
      children.push(build(childComp))
    }

    return { component: comp, children }
  }

  return build(rootComp)
}
