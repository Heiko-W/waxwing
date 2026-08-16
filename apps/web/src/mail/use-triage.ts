/**
 * The shared triage seam (M3.8): archive / junk / trash / read / flag, with an UNDO toast.
 *
 * Archive and Trash were silent and irreversible: one click (or, from M3.8, one keystroke) moved mail
 * with no feedback and no way back. A keystroke with neither is the biggest regression risk in a
 * shortcut layer, so every move raises a toast whose "Undo" dispatches the INVERSE move — the `move`
 * intent is symmetric (`move(ids, from, to)`), so undo is exactly one more idempotent dispatch through
 * the same outbox. When the source mailbox is unknown (a cross-folder search selection) the move still
 * runs but no Undo is offered, because there is nowhere to put the mail back.
 *
 * This is a thin layer over {@link useMessageActions} — still the ONLY email-write seam — and both the
 * on-screen buttons (bulk bar, reading action bar) and the shortcut registry go through it, so a click
 * and a keystroke are the same action.
 *
 * Account (M4.4 Etappe 4): the undo closure captures `actions`, and therefore the ACCOUNT it was
 * created for, at dispatch time. Switching account inside the five-second toast window cannot
 * re-point the inverse move — it goes back to where the mail came from, by construction.
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useMailboxByRole } from '../sync'
import { useToast } from '../ui'
import { useMessageActions } from './use-message-actions'
import { useMessageRights } from './use-message-rights'

/** A stable empty id list: the seam-level check asks about the ACCOUNT floor, not about subjects. */
const EMPTY_IDS: Id[] = []

export interface Triage {
  /**
   * Move to the Archive role mailbox. **Returns whether the move was dispatched** — `false` when the
   * account has no such mailbox OR its liveQuery has not resolved yet.
   *
   * The boolean is not decoration. These moves used to return `void`, and a caller had no way to tell
   * "filed" from "silently dropped": `e` on a just-opened message ran through MessageView's own
   * `useMailboxByRole('archive')`, found it still `undefined`, returned quietly — and the registry
   * advanced the reading pane anyway, handing the user the exact confirmation they were trained to
   * trust while the mail sat untouched in the Inbox. Proven at ~7% against the live fixture (M3.9).
   * A caller that ignores this result reintroduces that bug.
   *
   * It is also `false` for a SELF-MOVE (`to === from`) — Trash while viewing Trash, Archive while
   * viewing Archive. That is not a harmless no-op downstream, which is why it is stopped here rather
   * than at each call site: `moveUpdate` builds the patch as `{[`mailboxIds/${to}`]: true}` and then
   * writes `[`mailboxIds/${from}`]: null` onto it, so with the same id the removal wins on the SAME
   * key and the server is told to take the mail out of the only mailbox it is in — an
   * `invalidProperties` rejection at best, an Email in no mailbox at worst (RFC 8621 requires ≥ 1).
   * Optimistically it is just as wrong: the apply passes one predicate as both `left` and `entered`,
   * `left` is tested first, and the row is pruned out of the window it never left. Reachable today
   * from the bulk bar's Trash button while viewing Trash.
   */
  archive(ids: Id[], from: Id | null): boolean
  junk(ids: Id[], from: Id | null): boolean
  trash(ids: Id[], from: Id | null): boolean
  /**
   * Move to an ARBITRARY mailbox the user picked, naming it in the toast. `toName` is the label
   * already on screen — this module cannot resolve a display name (it holds no mailbox list, and a
   * role folder's name is localized, not the server's `name`), so the picker hands it down.
   *
   * Unlike the three above, the boolean cannot report a missing mailbox: `to` is caller-supplied and
   * therefore always known. It is `false` for an empty id set or a self-move, and is returned for
   * uniformity.
   */
  moveTo(ids: Id[], from: Id | null, to: Id, toName: string): boolean
  setSeen(ids: Id[], seen: boolean): void
  setFlagged(ids: Id[], flagged: boolean): void
}

export function useTriage(): Triage {
  const { t } = useTranslation()
  const actions = useMessageActions()
  const { toast } = useToast()
  const archiveBox = useMailboxByRole('archive')
  const junkBox = useMailboxByRole('junk')
  const trashBox = useMailboxByRole('trash')
  // Defence in depth for B34. The surfaces gate their own controls — that is where a refusal can be
  // EXPLAINED — but this seam is what both a click and a chord funnel through, so a write that got
  // past an ungated surface still stops here. `useMessageRights` degrades to all-granted outside a
  // ReplicaProvider, so component tests and the single-account path are untouched.
  const rights = useMessageRights(EMPTY_IDS)

  return useMemo<Triage>(() => {
    // Takes the finished title, not a key: a folder move interpolates its target's name, and the
    // role moves' titles are plain lookups — resolving them at the call site keeps one helper.
    const moveWithUndo = (
      ids: Id[],
      from: Id | null,
      to: Id | undefined,
      title: string,
    ): boolean => {
      if (to === undefined || to === from || ids.length === 0) return false
      // And no engine serves this account (M4.4 Etappe 4) ⇒ nothing is queued, so claim nothing. The
      // same "filed or silently dropped?" contract the boolean above exists for: a toast reading
      // "Moved to Archive" over mail that is still in the list is the failure this seam prevents.
      if (!actions.available) return false
      // B34: a move needs `mayRemoveItems` on the SOURCE and `mayAddItems` on the TARGET. The source
      // half is the gap this closes — every pre-existing check in the app looked at the target only,
      // so moving OUT of a read-only shared folder was offered, dispatched and toasted as done.
      if (rights.moveReason(from, to) !== null) return false
      actions.move(ids, from, to)
      // The Undo is offered only when the INVERSE is itself permitted (B34). Rights that allow a
      // move do not imply the way back: `to` must grant `mayRemoveItems` and `from` must grant
      // `mayAddItems`, which is the mirror of the forward check and not implied by it. An Undo that
      // cannot execute is the exact "looks like it worked" failure this whole seam exists to
      // prevent — and it would fail at the worst moment, when the user is trying to undo.
      const undoable = from !== null && rights.moveReason(to, from) === null
      toast({
        title,
        // Without a known source there is no inverse move — offer no Undo rather than a broken one.
        ...(undoable
          ? { action: { label: t('list.undo'), onAction: () => actions.move(ids, to, from) } }
          : {}),
      })
      return true
    }
    return {
      archive: (ids, from) => moveWithUndo(ids, from, archiveBox?.id, t('list.moved.archive')),
      junk: (ids, from) => moveWithUndo(ids, from, junkBox?.id, t('list.moved.junk')),
      trash: (ids, from) => moveWithUndo(ids, from, trashBox?.id, t('list.moved.trash')),
      moveTo: (ids, from, to, toName) =>
        moveWithUndo(ids, from, to, t('list.moved.folder', { folder: toName })),
      // Rights are checked against the account floor here (no subject rows), so this refuses only
      // what is refused for EVERY message in the account — a read-only share, or a mailbox-wide
      // denial. Per-message denials are caught by the calling surface, which has the rows.
      setSeen: (ids, seen) => {
        if (!rights.maySetSeen) return
        actions.setSeen(ids, seen)
      },
      setFlagged: (ids, flagged) => {
        if (!rights.maySetKeywords) return
        actions.setFlagged(ids, flagged)
      },
    }
  }, [actions, toast, t, archiveBox, junkBox, trashBox, rights])
}
