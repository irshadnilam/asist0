/**
 * A2UI Column Component.
 *
 * Vertical flex layout container.
 */

import type { A2UIRendererProps } from '../registry'
import type { ColumnComponent } from '../types'
import { renderChildren } from './render-utils'

const justifyMap: Record<string, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  spaceBetween: 'justify-between',
  spaceAround: 'justify-around',
  spaceEvenly: 'justify-evenly',
  stretch: 'justify-stretch',
}

const alignMap: Record<string, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
}

export function A2UIColumn({ node, dataModel, onAction }: A2UIRendererProps) {
  const comp = node.component as ColumnComponent
  const justify = justifyMap[comp.justify ?? 'start'] ?? 'justify-start'
  const align = alignMap[comp.align ?? 'stretch'] ?? 'items-stretch'
  const weight = comp.weight

  return (
    <div
      className={`flex flex-col gap-2 ${justify} ${align}`}
      style={weight !== undefined ? { flex: weight } : undefined}
    >
      {renderChildren(node.children, dataModel, onAction)}
    </div>
  )
}
