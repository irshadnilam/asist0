/**
 * A2UI Button Component.
 *
 * Clickable button that dispatches a server action or local function call.
 * Phase 1: only server actions (event) are supported. Validation (checks) in Phase 3.
 */

import { useCallback } from 'react'
import type { A2UIRendererProps } from '../registry'
import type { ButtonComponent, ServerAction } from '../types'
import { renderChildren } from './render-utils'

const variantStyles: Record<string, string> = {
  default:
    'rounded-md border border-[#30363d] bg-[#21262d] px-4 py-2 text-sm text-[#c9d1d9] hover:bg-[#30363d] hover:border-[#8b949e] transition cursor-pointer',
  primary:
    'rounded-md border border-[#238636] bg-[#238636] px-4 py-2 text-sm text-white hover:bg-[#2ea043] transition cursor-pointer',
  borderless:
    'rounded-md px-4 py-2 text-sm text-[#58a6ff] hover:text-[#79c0ff] transition cursor-pointer',
}

export function A2UIButton({ node, dataModel, onAction }: A2UIRendererProps) {
  const comp = node.component as ButtonComponent
  const variant = comp.variant ?? 'default'
  const className = variantStyles[variant] ?? variantStyles.default

  const handleClick = useCallback(() => {
    if (!onAction) return
    const action = comp.action
    if ('event' in action) {
      const evt = (action as ServerAction).event
      // Phase 2: resolve context data bindings
      onAction(evt.name, evt.context as Record<string, unknown> | undefined)
    }
    // Phase 3: local actions (functionCall)
  }, [comp.action, onAction])

  return (
    <button type="button" className={className} onClick={handleClick}>
      {renderChildren(node.children, dataModel, onAction)}
    </button>
  )
}
