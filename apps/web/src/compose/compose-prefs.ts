/**
 * User-configurable composer preferences (M3.7 — FR-CMP-08 undo-send, FR-CMP-02 signature placement).
 *
 * They live HERE, next to the code that consumes them, not in `settings/`: the settings screen only
 * renders a control, while the composer is what has to mean something by the value. Keeping the key,
 * the coercer and the hook together is also what stops a `settings → compose → settings` import cycle.
 *
 * `config.json` sets the DEPLOYMENT DEFAULT, never a lock: a hoster picks the grace period their users
 * start with, and a user who wants none — or wants thirty seconds — overrides it here. The pref is
 * account-scoped `localPrefs`, so it follows the account rather than the browser profile.
 */

import { DEFAULT_CONFIG } from '../app/config'
import { useConfigOptional } from '../app/config-context'
import { useLocalPrefOptional } from '../sync'
import type { SignaturePlacement } from './signature'

export const COMPOSE_PREF_KEYS = {
  undoSendSeconds: 'compose.undoSendSeconds',
  signaturePlacement: 'compose.signaturePlacement',
} as const

/** FR-CMP-08: the grace period offered in the UI. `0` is "send immediately". */
export const UNDO_SEND_OPTIONS: readonly number[] = [0, 5, 15, 30]

/** The stored value, or `null` for "no preference — use the deployment default". */
export function coerceUndoSendSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return UNDO_SEND_OPTIONS.includes(value) ? value : null
}

export function coerceSignaturePlacement(value: unknown): SignaturePlacement {
  return value === 'belowQuote' ? 'belowQuote' : 'aboveQuote'
}

/**
 * The effective undo-send grace: the user's choice, else the deployment default, else the built-in
 * one. Never throws outside a provider — the composer's own tests render without either.
 */
export function useUndoSendSeconds(): number {
  const stored = coerceUndoSendSeconds(
    useLocalPrefOptional<unknown>(COMPOSE_PREF_KEYS.undoSendSeconds),
  )
  const configured = useConfigOptional()?.features.undoSendSeconds
  return stored ?? configured ?? DEFAULT_CONFIG.features.undoSendSeconds
}

/** FR-CMP-02 — where a signature is seeded relative to the quoted original. Default: above it. */
export function useSignaturePlacement(): SignaturePlacement {
  return coerceSignaturePlacement(
    useLocalPrefOptional<unknown>(COMPOSE_PREF_KEYS.signaturePlacement),
  )
}
