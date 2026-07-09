/** Small internal helpers shared by the push transports. Not part of the public surface. */

import { JmapError } from '../errors'
import type { StateChange } from '../types/push'

/** Narrows an unknown parsed frame to a {@link StateChange} (RFC 8620 §7.1). */
export function isStateChange(value: unknown): value is StateChange {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { '@type'?: unknown; changed?: unknown }
  return (
    frame['@type'] === 'StateChange' && typeof frame.changed === 'object' && frame.changed !== null
  )
}

/** Coerces an unknown thrown value to an `Error`. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new JmapError(String(value))
}
