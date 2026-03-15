/**
 * A2UI Dynamic Value Resolution.
 *
 * Resolves DynamicString / DynamicNumber / DynamicBoolean to concrete values
 * using the surface data model.
 *
 * Phase 1: Resolves literal values and basic data binding paths.
 * Phase 2 will add FunctionCall resolution, formatString, etc.
 */

import type { DataBinding, DynamicBoolean, DynamicNumber, DynamicString, FunctionCall } from './types'
import { getAtPointer } from './store'

function isDataBinding(v: unknown): v is DataBinding {
  return typeof v === 'object' && v !== null && 'path' in v && typeof (v as DataBinding).path === 'string' && !('call' in v)
}

function isFunctionCall(v: unknown): v is FunctionCall {
  return typeof v === 'object' && v !== null && 'call' in v
}

/**
 * Resolve a DynamicString to a concrete string.
 */
export function resolveString(
  value: DynamicString | undefined,
  dataModel: Record<string, unknown>,
  _scope?: string,
): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (isDataBinding(value)) {
    const resolved = getAtPointer(dataModel, value.path)
    if (resolved === undefined || resolved === null) return ''
    if (typeof resolved === 'object') return JSON.stringify(resolved)
    return String(resolved)
  }
  if (isFunctionCall(value)) {
    // Phase 2: evaluate function calls
    return `[fn:${value.call}]`
  }
  return ''
}

/**
 * Resolve a DynamicNumber to a concrete number.
 */
export function resolveNumber(
  value: DynamicNumber | undefined,
  dataModel: Record<string, unknown>,
  _scope?: string,
): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'number') return value
  if (isDataBinding(value)) {
    const resolved = getAtPointer(dataModel, value.path)
    return typeof resolved === 'number' ? resolved : 0
  }
  if (isFunctionCall(value)) {
    // Phase 2
    return 0
  }
  return 0
}

/**
 * Resolve a DynamicBoolean to a concrete boolean.
 */
export function resolveBoolean(
  value: DynamicBoolean | undefined,
  dataModel: Record<string, unknown>,
  _scope?: string,
): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (isDataBinding(value)) {
    const resolved = getAtPointer(dataModel, value.path)
    return Boolean(resolved)
  }
  if (isFunctionCall(value)) {
    // Phase 2
    return false
  }
  return false
}
