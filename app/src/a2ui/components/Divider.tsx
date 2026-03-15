/**
 * A2UI Divider Component.
 *
 * Horizontal or vertical dividing line.
 */

import type { A2UIRendererProps } from '../registry'
import type { DividerComponent } from '../types'

export function A2UIDivider({ node }: A2UIRendererProps) {
  const comp = node.component as DividerComponent
  const isVertical = comp.axis === 'vertical'

  return (
    <div
      className={
        isVertical
          ? 'mx-2 h-auto w-px self-stretch bg-[#30363d]'
          : 'my-2 h-px w-full bg-[#30363d]'
      }
      role="separator"
    />
  )
}
