/**
 * The open message's action-bar callbacks, published for the keyboard (M3.8).
 *
 * `r`/`a`/`f` (reply / reply-all / forward) cannot be reconstructed from outside `MessageView`: the
 * draft is seeded from the message's SANITIZED body, its inline images, the account's own addresses
 * and four localized strings — reproducing that in the shortcut layer would mean duplicating the
 * whole sanitize pipeline, and the two copies would drift. So `MessageView` registers the very
 * callbacks its buttons use, and the registry just calls them.
 *
 * Only the OPENED message registers (a thread's auto-expanded newest sibling does not — that is
 * exactly what `MessageView`'s `autoMark` prop already means), and it clears itself by id, so a
 * thread re-render can never null out another message's entry.
 */

import type { Id } from '@waxwing/jmap'
import { create } from 'zustand'
import type { ReplyKind } from '../compose'

export interface ReadingHandlers {
  readonly emailId: Id
  /** The mailbox the message is being read in — the `from` of a move; `null` when unknown. */
  readonly mailboxId: Id | null
  /**
   * Reply/forward need the SANITIZED body, so this covers both fetches: the body itself and the
   * inline `cid:` images the sanitize pass waits on. False through either (the buttons carry the
   * same condition). Seeding a draft in the second window used to quote the raw mail; it now quotes
   * nothing, and this is what keeps the reader from meeting that empty quote.
   */
  readonly bodyReady: boolean
  compose(kind: ReplyKind): void
  /**
   * Move the open message. **Returns whether the move was dispatched** — `false` when this view's own
   * role-mailbox liveQuery has not resolved yet (its buttons carry the same condition as
   * `disabled`). The keyboard has no `disabled` state to read, so it needs the answer at call time;
   * see {@link Triage.archive} for the bug this exists to prevent.
   */
  archive(): boolean
  junk(): boolean
  trash(): boolean
  toggleFlag(): void
  markUnread(): void
  openMove(): void
  openLabels(): void
  /** Open the permanent-delete confirmation dialog (Trash → destroy). */
  requestDelete(): void
  /** Hand the open message to the browser's print dialog. */
  print(): void
}

export interface ReadingStore {
  readonly handlers: ReadingHandlers | null
  set(handlers: ReadingHandlers): void
  /** Clear only if `emailId` is still the registered one (id-guarded unmount). */
  clear(emailId: Id): void
}

export const useReadingStore = create<ReadingStore>()((set, get) => ({
  handlers: null,
  set: (handlers) => set({ handlers }),
  clear: (emailId) => {
    if (get().handlers?.emailId === emailId) set({ handlers: null })
  },
}))
