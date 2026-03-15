/**
 * A2UI Module — barrel export.
 *
 * Registers all basic catalog components and re-exports key items.
 */

// --- Component registration (must happen before any rendering) ---
import { registerComponent } from './registry'
import { A2UIText } from './components/Text'
import { A2UIRow } from './components/Row'
import { A2UIColumn } from './components/Column'
import { A2UICard } from './components/Card'
import { A2UIButton } from './components/Button'
import { A2UIImage } from './components/Image'
import { A2UIDivider } from './components/Divider'
import { A2UIIcon } from './components/Icon'

registerComponent('Text', A2UIText)
registerComponent('Row', A2UIRow)
registerComponent('Column', A2UIColumn)
registerComponent('Card', A2UICard)
registerComponent('Button', A2UIButton)
registerComponent('Image', A2UIImage)
registerComponent('Divider', A2UIDivider)
registerComponent('Icon', A2UIIcon)

// --- Public API ---
export { SurfaceRenderer } from './SurfaceRenderer'
export { useA2UIStore } from './store'
export type { A2UIEnvelope, A2UIComponent, SurfaceState, ActionMessage } from './types'
export type { A2UIRendererProps } from './registry'
export { registerComponent } from './registry'
