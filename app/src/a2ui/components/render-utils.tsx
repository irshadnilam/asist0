/**
 * A2UI Component Renderers — shared child-rendering helper.
 */

import React from 'react'
import type { TreeNode } from '../tree'
import { getComponent } from '../registry'

/** Render a tree node using the registry. */
export function renderNode(
  node: TreeNode,
  dataModel: Record<string, unknown>,
  onAction?: (name: string, context?: Record<string, unknown>) => void,
): React.ReactNode {
  const Comp = getComponent(node.component.component)
  if (!Comp) {
    // Unknown component type — render nothing (graceful degradation)
    return null
  }
  return (
    <Comp
      key={node.component.id}
      node={node}
      dataModel={dataModel}
      onAction={onAction}
    />
  )
}

/** Render an array of child tree nodes. */
export function renderChildren(
  children: TreeNode[],
  dataModel: Record<string, unknown>,
  onAction?: (name: string, context?: Record<string, unknown>) => void,
): React.ReactNode[] {
  return children.map((child) => renderNode(child, dataModel, onAction))
}
