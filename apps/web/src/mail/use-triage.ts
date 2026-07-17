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
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useMailboxByRole } from '../sync'
import { useToast } from '../ui'
import { useMessageActions } from './use-message-actions'

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
   * therefore always known. It is `false` only for an empty id set, and is returned for uniformity.
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

  return useMemo<Triage>(() => {
    // Takes the finished title, not a key: a folder move interpolates its target's name, and the
    // role moves' titles are plain lookups — resolving them at the call site keeps one helper.
    const moveWithUndo = (
      ids: Id[],
      from: Id | null,
      to: Id | undefined,
      title: string,
    ): boolean => {
      if (to === undefined || ids.length === 0) return false
      actions.move(ids, from, to)
      toast({
        title,
        // Without a known source there is no inverse move — offer no Undo rather than a broken one.
        ...(from !== null
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
      setSeen: (ids, seen) => actions.setSeen(ids, seen),
      setFlagged: (ids, flagged) => actions.setFlagged(ids, flagged),
    }
  }, [actions, toast, t, archiveBox, junkBox, trashBox])
}
