/**
 * Drag & drop model (M3.9 5b, FR-MBX-03) — pure, no React, no DOM.
 *
 * Two things live here that the UI cannot hold:
 *
 * 1. **The drag subject, in MODULE state.** `dragover` has to decide whether to accept a drop
 *    synchronously, in the same tick, and by spec it may only look at `dataTransfer.types` — the
 *    VALUES are unreadable until `drop`. React state is a tick too late. The subject cannot ride in
 *    the MIME type either: `setData` lowercases the format, and a JMAP `Id` is opaque and
 *    case-sensitive (RFC 8620 §1.2), so `Ab3Xy` would come back `ab3xy` and match nothing. The type
 *    therefore carries the KIND only, and the subject rides here.
 *
 * 2. **The two gates the write paths do not have.** `triage.moveTo` and `useFolderActions().move`
 *    both dispatch unconditionally and apply optimistically, so an ungated drop renders as success
 *    and is reverted a round-trip later — exactly the bug 5a closed when the picker was offering
 *    `mayAddItems: false` targets.
 *
 * Folder legality is NOT re-implemented here: {@link legalParents} is the whole oracle (no cycle,
 * `mayCreateChild` on the target, depth, top-level right), and a drag holds the Set it returned.
 */

import type { Id } from '@waxwing/jmap'
import type { MailboxRow } from '../sync'

/** The kind marker for a message drag. Values are unreadable during `dragover` — the kind is not. */
export const MESSAGES_MIME = 'application/x-waxwing-messages'
/** The kind marker for a folder re-parent drag. */
export const MAILBOX_MIME = 'application/x-waxwing-mailbox'

export type DragSubject =
  | {
      readonly kind: 'messages'
      readonly ids: readonly Id[]
      /** Never null: a move without a source is a COPY, so the drag is not offered at all. */
      readonly from: Id
    }
  | {
      readonly kind: 'mailbox'
      readonly id: Id
      /** Legal target ids, from {@link legalParents} at dragstart — `null` (top level) dropped:
       *  the tree has no node to drop onto for it, and the picker owns that target. */
      readonly legal: ReadonlySet<string>
    }

let active: DragSubject | null = null

export function setActiveDrag(subject: DragSubject): void {
  active = subject
}

/** The drag in flight, or `null`. Read synchronously from `dragover`. */
export function getActiveDrag(): DragSubject | null {
  return active
}

export function clearActiveDrag(): void {
  active = null
}

/**
 * What a drag starting on `rowId` actually carries.
 *
 * Dragging a row INSIDE the selection takes the whole selection; dragging one OUTSIDE it takes that
 * row alone. Deliberately NOT `targetIds`' rule (`use-shortcut-context.ts`), which returns the
 * selection first and unconditionally: under a pointer that would fly the selected messages into the
 * folder while the row under the cursor — the one the user is looking at — stayed put. Every
 * platform does it this way, and the list already concedes the point for clicks: `open()` clears the
 * selection first, because "opening a message makes IT the subject".
 */
export function draggedMessageIds(selected: ReadonlySet<Id>, rowId: Id): readonly Id[] {
  return selected.has(rowId) ? [...selected] : [rowId]
}

/**
 * May these messages be dropped on `target`? Mirrors the picker's filter, so the drag and the dialog
 * cannot drift apart — a target we may not add to is one the server rejects after the optimistic
 * apply has already shown the move as done.
 */
export function canDropMessages(target: MailboxRow, from: Id): boolean {
  return target.myRights.mayAddItems && target.id !== from
}
