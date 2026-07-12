/**
 * The "keep offline" folder pin (M3.4, FR-OFF-04) — pure, so the `sync` layer can import it without
 * pulling React in (the `labels/label-model.ts` precedent).
 *
 * A pinned mailbox is the user's explicit statement that this folder must be usable offline. It has
 * two effects, both owner-decided:
 *  - **Exempt from eviction.** Its envelopes, their bodies and their blobs are never LRU-evicted and
 *    never pruned by the `cacheDays` horizon — not even under storage pressure.
 *  - **Prefetched.** The maintenance pass tops the folder's cached window up with the bodies it is
 *    missing (bounded per pass, leader-only, online-only, and it stops at the low watermark, so a pin
 *    can never fill the disk).
 *
 * Unknown/deleted mailbox ids are ignored on read rather than pruned on write: a folder that
 * disappears from a stale replica and comes back on the next sync keeps its pin.
 */

import type { Id } from '@waxwing/jmap'

/** localPrefs key under which the pinned mailbox ids are stored. */
export const PINNED_PREF_KEY = 'offline.pinnedMailboxes'

/** The stored value: mailbox ids. */
export type PinnedPref = Id[]

/** Toggle a mailbox id in the pin set (pure — the repo wraps it in a read-modify-write txn). */
export function togglePinned(current: PinnedPref, mailboxId: Id): PinnedPref {
  return current.includes(mailboxId)
    ? current.filter((id) => id !== mailboxId)
    : [...current, mailboxId]
}
