/**
 * "Select all {{total}}" — the second step of select-all (FR-LST-04, R-08 stage 2).
 *
 * The first step ticks the loaded window; in a folder of 300 that is 50 rows, and the bar says so
 * ("50 of 300 selected"). This is the step that closes the gap: it pages the remaining ids out of
 * `Email/query` (`Engine.collectQueryIds`) and hands the whole set to the selection, so the bulk
 * actions that follow really do act on the folder.
 *
 * WHAT IT IS NOT is a subscription. The ids are the ones the query answered with at the moment of
 * the click, and every later action targets exactly those — a message that arrives a second later is
 * not in the set. That is why the bar goes on naming a NUMBER ("300 selected") instead of saying
 * "all": the number is a fact about what is held, and "all" would be a claim about a folder that has
 * moved on. See `message-selection.ts` for the state that carries it and `list-store.ts` for the
 * prune rule that keeps it.
 *
 * THREE REFUSALS, all of them spoken rather than silent — the button stays focusable and carries the
 * sentence (`Button`'s `unavailableReason`), because the reader who most needs the explanation is
 * the one a `disabled` button would put out of reach:
 *
 *  - OFFLINE. The query cannot be paged without a connection, and the loaded window is not an
 *    answer — a select-all that quietly selected 50 offline and 300 online is a promise that depends
 *    on the weather. `navigator.onLine` is a floor, not a guarantee, so the failure path below still
 *    exists for a connection that says it is there and is not.
 *  - TOO MANY. {@link SELECT_ALL_LIMIT} is the point at which this app stops pretending a selection
 *    is the right tool. It is not a network bound (paging 50 000 ids is 100 cheap requests) but a
 *    SELECTION bound: two live `useEmailWindow` subscriptions run over the selected id-set on every
 *    write to the `emails` table — one in the bulk bar, one in the shortcut context — and each of
 *    them is a `bulkGet` of the whole set. Beyond the limit the honest answer is that this is a
 *    folder-level operation ("Empty Trash", "Delete older than…"), not a selection, and the button
 *    says so instead of freezing the tab.
 *  - THE FOLDER GREW PAST THE LIMIT between the render and the click. `collectQueryIds` stops at the
 *    cap and reports `complete: false`; applying what it got would tick 10 000 under a label that
 *    said 10 004, which is the exact false promise this feature exists to remove. The refusal
 *    becomes the same "too many" sentence, now on a button that has been pressed — which is why it
 *    is remembered rather than recomputed.
 *
 * A FAILURE IS NOT A REFUSAL and does not go on the button: a request that was made and did not
 * arrive leaves the selection exactly as it was and raises a toast, so the control stays live for
 * the retry that is the sensible next move.
 */

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnline } from '../app/use-online'
import { useAccountEngine } from '../sync/engine'
import { useToast } from '../ui'
import { useListStore } from './list-store'

/**
 * The largest selection this app will build in one step.
 *
 * The number is the SELECTION's cost, not the query's. Paging is cheap and scales flat — 10 000 ids
 * is 20 `Email/query` calls of 500 and no `Email/get` at all — while the selection is read back by
 * two live `useEmailWindow` subscriptions over the whole id-set (the bulk bar's, for the read/flag
 * toggle labels, and the shortcut context's), each of them a `bulkGet` of every selected id, re-run
 * whenever the `emails` table changes.
 *
 * Measured with `emailsByIds` on fake-indexeddb (the pessimistic end — a browser's IndexedDB is
 * several times faster, and this is the number available without a browser): 1 000 ids 61 ms,
 * 5 000 288 ms, 10 000 588 ms, 50 000 4 010 ms. It is not paid per message — the optimistic apply of
 * a bulk action is one transaction, so one re-run — but it is paid on the click that builds the
 * selection and again after each bulk write, twice over.
 *
 * Ten thousand is where that stays a pause and stops being a freeze, and it is past any folder a
 * person picks a selection out of. Beyond it the honest answer is that a selection is the wrong
 * tool and the folder-level operations are the right one ("Empty Trash", "Delete older than…"),
 * which is what {@link SelectAllInQuery.unavailableReason} then says out loud.
 */
export const SELECT_ALL_LIMIT = 10_000

export interface SelectAllInQuery {
  /** True while the ids are being paged — the button shows it and refuses a second press. */
  readonly pending: boolean
  /** Why this cannot run right now, as a finished sentence; `undefined` when it can. */
  readonly unavailableReason: string | undefined
  readonly run: () => void
}

/**
 * @param windowKey the canonical key of the list's current query window
 * @param total     the query's total, as the window reports it
 * @returns the control, or `undefined` when no engine serves this account — a structurally absent
 *          action stays hidden rather than explaining itself (`Button`'s rule).
 */
export function useSelectAllInQuery(
  windowKey: string,
  total: number | undefined,
): SelectAllInQuery | undefined {
  const { t } = useTranslation()
  const engine = useAccountEngine()
  const online = useOnline()
  const { toast } = useToast()
  const select = useListStore((state) => state.select)
  const [pending, setPending] = useState(false)
  const [refused, setRefused] = useState(false)

  // A new window is a new question: what the last one was told about its size does not apply to it,
  // and neither does a page still in flight (`run` re-checks the key before it applies anything).
  // The documented "adjust state while rendering" shape rather than an effect — an effect would
  // paint one frame of the previous folder's answer first.
  const [renderedKey, setRenderedKey] = useState(windowKey)
  if (renderedKey !== windowKey) {
    setRenderedKey(windowKey)
    setPending(false)
    setRefused(false)
  }

  const tooMany = refused || (total !== undefined && total > SELECT_ALL_LIMIT)

  const run = useCallback(() => {
    if (engine === null || pending) return
    setPending(true)
    engine
      .collectQueryIds(windowKey, { max: SELECT_ALL_LIMIT })
      .then(({ ids, complete }) => {
        if (!complete) {
          setRefused(true)
          return
        }
        // The window the reader was looking at when they pressed it. Switching folder (or sort, or
        // search) resets the selection, and applying a set paged for the previous query would tick
        // ids that are not in this list at all — the store would prune them on the next window
        // publication and leave a count nobody can explain.
        if (useListStore.getState().windowKey !== windowKey) return
        select({ type: 'selectAllInQuery', ids })
      })
      .catch(() => {
        // Made and not answered: say so and leave the selection alone. No `unavailableReason` for
        // this — the button has to stay pressable, because trying again is the right next move.
        toast({ tone: 'danger', title: t('list.selectAllFailed') })
      })
      .finally(() => {
        setPending(false)
      })
  }, [engine, pending, windowKey, select, toast, t])

  if (engine === null) return undefined
  return {
    pending,
    unavailableReason: !online
      ? t('list.selectAllOffline')
      : tooMany
        ? t('list.selectAllTooMany', { max: SELECT_ALL_LIMIT })
        : undefined,
    run,
  }
}
