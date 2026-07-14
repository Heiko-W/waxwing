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
  /** Reply/forward need the loaded body; false while it is still fetching (the buttons are disabled). */
  readonly bodyReady: boolean
  compose(kind: ReplyKind): void
  archive(): void
  junk(): void
  trash(): void
  toggleFlag(): void
  markUnread(): void
  openMove(): void
  openLabels(): void
  /** Open the permanent-delete confirmation dialog (Trash → destroy). */
  requestDelete(): void
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
