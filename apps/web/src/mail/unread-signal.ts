/**
 * "Someone just asked for these messages to be UNREAD" — a one-way signal from the write seam to
 * whoever has a timer running that would undo it (B26).
 *
 * ## The hole this closes
 *
 * `MessageView` arms a dwell that marks an opened message read after ~1.5 s (FR-RD-07), and it has
 * two cancels: its own `markUnread` closure, and a `$seen` true → false TRANSITION on the same
 * message. Between them they cover every mark-unread that either goes through the pane or moves the
 * row — but not a mark-unread issued from OUTSIDE the pane against a message that is ALREADY
 * unread. There is no transition to watch, nothing calls into the pane, and the armed dwell fires
 * anyway, ~1.5 s after the open, against the one thing the reader explicitly asked for.
 *
 * That is reachable, not theoretical: `BulkBar`'s read button derives `allSeen` from a Dexie
 * `useLiveQuery`, which keeps returning its LAST RESOLVED value while a query for changed ids is in
 * flight, and its freshness guard compares cardinality only — so a stale result of equal cardinality
 * passes and the "toggle" issues a mark-UNread against a message that is already unread.
 *
 * ## Why the INTENT and not the row
 *
 * Because the intent is the only place where the answer exists. A row-based cancel can only see
 * state that CHANGED; this signal carries what was ASKED FOR, and the ids are known there whatever
 * the rows say. It hangs off `dispatch` in `use-message-actions.ts` — the single email-write seam —
 * so every surface is covered by construction: bulk bar, swipe, context menu, chords, and any
 * surface added later without anyone remembering this file exists.
 *
 * Deliberately NOT a store: there is no state here to read, only an edge to hear. A module-level
 * subscriber set is the whole mechanism, in the shape `theme.ts` and `offline-prefs.ts` already use
 * for their own module-level state.
 */

import type { Id } from '@waxwing/jmap'

type Listener = (ids: readonly Id[]) => void

const listeners = new Set<Listener>()

/** Called by the write seam when a `$seen: false` intent is queued. Never called for `true`. */
export function announceMarkedUnread(ids: readonly Id[]): void {
  if (ids.length === 0) return
  // A copy of the set, so a listener that unsubscribes itself cannot mutate what we are iterating.
  for (const listener of [...listeners]) listener(ids)
}

/** Listen for mark-unread intents. Returns the unsubscribe, for an effect's cleanup. */
export function onMarkedUnread(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
