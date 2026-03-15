/**
 * A2UI Component Registry.
 *
 * Maps component type names (e.g., "Text", "Row") to their React renderer.
 * This is the extension point for adding new component types.
 */

import type { ComponentType } from 'react'
import type { TreeNode } from './tree'

/** Props passed to every A2UI component renderer. */
export interface A2UIRendererProps {
  node: TreeNode
  dataModel: Record<string, unknown>
  onAction?: (name: string, context?: Record<string, unknown>) => void
}

/** Registry of component type → React component */
const registry = new Map<string, ComponentType<A2UIRendererProps>>()

export function registerComponent(
  type: string,
  component: ComponentType<A2UIRendererProps>,
): void {
  registry.set(type, component)
}

export function getComponent(
  type: string,
): ComponentType<A2UIRendererProps> | undefined {
  return registry.get(type)
}

export function hasComponent(type: string): boolean {
  return registry.has(type)
}
