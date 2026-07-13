/**
 * User-configurable reading preferences (M3.7 — FR-RD-02 remote content, FR-RD-07 auto-mark-read).
 *
 * Two of these keys are not new. `reading.autoMarkRead` has gated {@link MessageView}'s dwell timer
 * since M1.8 and has never had a control — a preference nobody could set. `reading.remoteAllow` has
 * been WRITTEN since M1.7 (the "always load from this sender" button) and never shown, so the list
 * only ever grew. M3.7 gives both a surface; the third key lets a user override the hoster's
 * remote-content default, which until now was the only say anyone had.
 *
 * Kept in `mail/`, beside the reader that consumes them (the settings screen only renders controls).
 */

import type { Id } from '@waxwing/jmap'
import type { RemoteContentDefault } from '../app/config'
import { DEFAULT_CONFIG } from '../app/config'
import { useConfigOptional } from '../app/config-context'
import { type ReplicaDb, setPref, useLocalPrefOptional } from '../sync'

export const READING_PREF_KEYS = {
  /** Existing (M1.8). `false` disables the dwell timer that marks an opened message read. */
  autoMarkRead: 'reading.autoMarkRead',
  /** New (M3.7). Overrides `config.features.remoteContentDefault` for this account. */
  remoteContent: 'reading.remoteContent',
  /** Existing (M1.7). Senders whose remote content always loads. */
  remoteAllow: 'reading.remoteAllow',
} as const

export function coerceRemoteContent(value: unknown): RemoteContentDefault | null {
  return value === 'allow' || value === 'block' ? value : null
}

/** FR-RD-07. Default ON — the stored value only ever turns it off. */
export function useAutoMarkRead(): boolean {
  return useLocalPrefOptional<unknown>(READING_PREF_KEYS.autoMarkRead) !== false
}

/** FR-RD-02. The user's choice, else the deployment default, else block (the privacy-safe side). */
export function useRemoteContentDefault(): RemoteContentDefault {
  const stored = coerceRemoteContent(useLocalPrefOptional<unknown>(READING_PREF_KEYS.remoteContent))
  const configured = useConfigOptional()?.features.remoteContentDefault
  return stored ?? configured ?? DEFAULT_CONFIG.features.remoteContentDefault
}

/** The senders the user has chosen to always load remote content from. */
export function useRemoteAllowList(): readonly string[] {
  return useLocalPrefOptional<string[]>(READING_PREF_KEYS.remoteAllow) ?? []
}

/** Forget every "always load from this sender" decision (the list is otherwise write-only). */
export async function clearRemoteAllowList(db: ReplicaDb, accountId: Id): Promise<void> {
  await setPref(db, accountId, READING_PREF_KEYS.remoteAllow, [])
}
