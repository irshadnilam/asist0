/**
 * A2UI Card Component.
 *
 * Container with card-like styling (border, padding, slight elevation).
 * Renders a single child.
 */

import type { A2UIRendererProps } from '../registry'
import { renderChildren } from './render-utils'

export function A2UICard({ node, dataModel, onAction }: A2UIRendererProps) {
  const weight = node.component.weight

  return (
    <div
      className="rounded-lg border border-[#30363d] bg-[#161b22] p-4"
      style={weight !== undefined ? { flex: weight } : undefined}
    >
      {renderChildren(node.children, dataModel, onAction)}
    </div>
  )
}
