/**
 * A2UI v0.9 Protocol TypeScript types.
 *
 * These types model the server-to-client envelope messages, component definitions,
 * the data model, and common primitives (DynamicString, ChildList, etc.).
 *
 * Phase 1 focuses on static rendering — DynamicString resolves literal strings only,
 * data binding (path / FunctionCall) types are defined but resolved in Phase 2.
 */

// ---------------------------------------------------------------------------
// Common primitives
// ---------------------------------------------------------------------------

/** A reference to a component by its unique ID within a surface. */
export type ComponentId = string

/** A JSON Pointer path (RFC 6901) into the data model. */
export interface DataBinding {
  path: string
}

/** A client-side function call reference. */
export interface FunctionCall {
  call: string
  args?: Record<string, unknown>
  returnType?: string
  message?: string // used in checks
}

/**
 * DynamicString — can be a literal, a data binding, or a function call.
 * Phase 1: only literal strings are resolved. Bindings/functions return placeholder.
 */
export type DynamicString = string | DataBinding | FunctionCall

/**
 * DynamicNumber — literal number or data binding.
 */
export type DynamicNumber = number | DataBinding | FunctionCall

/**
 * DynamicBoolean — literal boolean or data binding.
 */
export type DynamicBoolean = boolean | DataBinding | FunctionCall

/**
 * ChildList — static array of component IDs, or a template for dynamic lists.
 */
export type ChildList = ComponentId[] | ChildListTemplate

export interface ChildListTemplate {
  path: string
  componentId: ComponentId
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ServerAction {
  event: {
    name: string
    context?: Record<string, unknown>
  }
}

export interface LocalAction {
  functionCall: FunctionCall
}

export type Action = ServerAction | LocalAction

// ---------------------------------------------------------------------------
// Check rules (validation)
// ---------------------------------------------------------------------------

export interface CheckRule {
  call: string
  args?: Record<string, unknown>
  message: string
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

export interface AccessibilityAttributes {
  label?: DynamicString
  description?: DynamicString
}

// ---------------------------------------------------------------------------
// Component definitions (flat adjacency list entries)
// ---------------------------------------------------------------------------

/** Base properties shared by all components. */
export interface ComponentBase {
  id: ComponentId
  component: string
  accessibility?: AccessibilityAttributes
  weight?: number
}

/** Text component */
export interface TextComponent extends ComponentBase {
  component: 'Text'
  text: DynamicString
  variant?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body'
}

/** Row layout */
export interface RowComponent extends ComponentBase {
  component: 'Row'
  children: ChildList
  justify?: 'center' | 'end' | 'spaceAround' | 'spaceBetween' | 'spaceEvenly' | 'start' | 'stretch'
  align?: 'start' | 'center' | 'end' | 'stretch'
}

/** Column layout */
export interface ColumnComponent extends ComponentBase {
  component: 'Column'
  children: ChildList
  justify?: 'start' | 'center' | 'end' | 'spaceBetween' | 'spaceAround' | 'spaceEvenly' | 'stretch'
  align?: 'center' | 'end' | 'start' | 'stretch'
}

/** Card container */
export interface CardComponent extends ComponentBase {
  component: 'Card'
  child: ComponentId
}

/** Button */
export interface ButtonComponent extends ComponentBase {
  component: 'Button'
  child: ComponentId
  action: Action
  variant?: 'default' | 'primary' | 'borderless'
  checks?: CheckRule[]
}

/** Image */
export interface ImageComponent extends ComponentBase {
  component: 'Image'
  url: DynamicString
  fit?: 'contain' | 'cover' | 'fill' | 'none' | 'scaleDown'
  variant?: 'icon' | 'avatar' | 'smallFeature' | 'mediumFeature' | 'largeFeature' | 'header'
}

/** Divider */
export interface DividerComponent extends ComponentBase {
  component: 'Divider'
  axis?: 'horizontal' | 'vertical'
}

/** Icon */
export interface IconComponent extends ComponentBase {
  component: 'Icon'
  name: DynamicString
}

// Phase 2+ components (defined as stubs for forward compatibility)
export interface TextFieldComponent extends ComponentBase {
  component: 'TextField'
  label?: DynamicString
  value?: DataBinding
  variant?: 'shortText' | 'longText'
  checks?: CheckRule[]
}

export interface CheckBoxComponent extends ComponentBase {
  component: 'CheckBox'
  label?: DynamicString
  value?: DataBinding
}

export interface SliderComponent extends ComponentBase {
  component: 'Slider'
  value?: DataBinding
  min?: DynamicNumber
  max?: DynamicNumber
  step?: DynamicNumber
}

export interface ChoicePickerComponent extends ComponentBase {
  component: 'ChoicePicker'
  variant?: 'mutuallyExclusive' | 'multipleChoice'
  options?: Array<{ label: string; value: string }>
  value?: DataBinding
}

export interface ListComponent extends ComponentBase {
  component: 'List'
  children: ChildList
}

/** Union of all known component types */
export type A2UIComponent =
  | TextComponent
  | RowComponent
  | ColumnComponent
  | CardComponent
  | ButtonComponent
  | ImageComponent
  | DividerComponent
  | IconComponent
  | TextFieldComponent
  | CheckBoxComponent
  | SliderComponent
  | ChoicePickerComponent
  | ListComponent

// ---------------------------------------------------------------------------
// Envelope messages (server → client)
// ---------------------------------------------------------------------------

export interface CreateSurfaceMessage {
  version: string
  createSurface: {
    surfaceId: string
    catalogId: string
    theme?: Record<string, unknown>
    sendDataModel?: boolean
  }
}

export interface UpdateComponentsMessage {
  version: string
  updateComponents: {
    surfaceId: string
    components: A2UIComponent[]
  }
}

export interface UpdateDataModelMessage {
  version: string
  updateDataModel: {
    surfaceId: string
    path?: string
    value?: unknown
  }
}

export interface DeleteSurfaceMessage {
  version: string
  deleteSurface: {
    surfaceId: string
  }
}

export type A2UIEnvelope =
  | CreateSurfaceMessage
  | UpdateComponentsMessage
  | UpdateDataModelMessage
  | DeleteSurfaceMessage

// ---------------------------------------------------------------------------
// Client → server action message
// ---------------------------------------------------------------------------

export interface ActionMessage {
  action: {
    surfaceId: string
    name: string
    context?: Record<string, unknown>
  }
}

// ---------------------------------------------------------------------------
// Surface state (client-side)
// ---------------------------------------------------------------------------

export interface SurfaceState {
  surfaceId: string
  catalogId: string
  theme?: Record<string, unknown>
  sendDataModel: boolean
  /** Map of component ID → component definition */
  components: Map<string, A2UIComponent>
  /** The data model for this surface (arbitrary JSON) */
  dataModel: Record<string, unknown>
}
