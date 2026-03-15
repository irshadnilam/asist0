/**
 * A2UI Image Component.
 *
 * Displays an image from a URL with fit and variant styling.
 */

import type { A2UIRendererProps } from '../registry'
import type { ImageComponent } from '../types'
import { resolveString } from '../resolve'

const variantSizes: Record<string, string> = {
  icon: 'w-6 h-6',
  avatar: 'w-10 h-10 rounded-full',
  smallFeature: 'w-24 h-24',
  mediumFeature: 'w-48 h-48',
  largeFeature: 'w-full max-w-md',
  header: 'w-full max-h-48',
}

const fitMap: Record<string, string> = {
  contain: 'object-contain',
  cover: 'object-cover',
  fill: 'object-fill',
  none: 'object-none',
  scaleDown: 'object-scale-down',
}

export function A2UIImage({ node, dataModel }: A2UIRendererProps) {
  const comp = node.component as ImageComponent
  const url = resolveString(comp.url, dataModel)
  const variant = comp.variant ?? 'mediumFeature'
  const fit = comp.fit ?? 'fill'
  const sizeClass = variantSizes[variant] ?? variantSizes.mediumFeature
  const fitClass = fitMap[fit] ?? 'object-fill'

  if (!url) return null

  return (
    <img
      src={url}
      alt={comp.accessibility?.label ? resolveString(comp.accessibility.label, dataModel) : ''}
      className={`${sizeClass} ${fitClass}`}
    />
  )
}
