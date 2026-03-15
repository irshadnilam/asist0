/**
 * A2UI Text Component.
 *
 * Displays text with optional variant styling.
 * Supports simple Markdown (Phase 1: rendered as plain text with basic formatting).
 */

import React from 'react'
import type { A2UIRendererProps } from '../registry'
import type { TextComponent } from '../types'
import { resolveString } from '../resolve'

const variantStyles: Record<string, string> = {
  h1: 'text-2xl font-bold text-[#e6edf3]',
  h2: 'text-xl font-semibold text-[#e6edf3]',
  h3: 'text-lg font-semibold text-[#e6edf3]',
  h4: 'text-base font-semibold text-[#c9d1d9]',
  h5: 'text-sm font-semibold text-[#c9d1d9]',
  caption: 'text-xs text-[#8b949e]',
  body: 'text-sm text-[#c9d1d9]',
}

export function A2UIText({ node, dataModel }: A2UIRendererProps) {
  const comp = node.component as TextComponent
  const text = resolveString(comp.text, dataModel)
  const variant = comp.variant ?? 'body'
  const className = variantStyles[variant] ?? variantStyles.body

  // Simple Markdown heading support: # → variant mapping
  // If text starts with Markdown heading markers, strip them
  let displayText = text
  if (text.startsWith('# ')) displayText = text.slice(2)
  else if (text.startsWith('## ')) displayText = text.slice(3)
  else if (text.startsWith('### ')) displayText = text.slice(4)

  // Map variant to semantic HTML element
  const Tag = variant.startsWith('h')
    ? (variant as 'h1' | 'h2' | 'h3' | 'h4' | 'h5')
    : 'span'

  return React.createElement(Tag, { className }, displayText)
}
