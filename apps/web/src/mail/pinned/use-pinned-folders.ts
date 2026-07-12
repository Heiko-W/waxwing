/**
 * The "keep offline" pin, bound to the replica (M3.4). {@link usePinnedMailboxes} is the live set the
 * folder tree renders from; {@link usePinActions} mutates it through the cross-tab-safe
 * read-modify-write in `repo.updatePinnedMailboxes` (a blind `setPref` would let two tabs clobber
 * each other's pins).
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import { updatePinnedMailboxes, useLocalPref, useReplica } from '../../sync'
import { PINNED_PREF_KEY, type PinnedPref, togglePinned } from './pinned-model'

/** The pinned mailbox ids; `undefined` until the first query resolves. */
export function usePinnedMailboxes(): ReadonlySet<Id> | undefined {
  const pref = useLocalPref<PinnedPref>(PINNED_PREF_KEY)
  const stable = pref === undefined ? undefined : pref.join(',')
  // Keyed on the joined ids, not the array identity: liveQuery hands back a fresh array on every
  // emission, which would otherwise re-create the Set (and re-render the whole tree) on any pref write.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stable` is the value-identity of `pref`.
  return useMemo(() => (pref === undefined ? undefined : new Set(pref)), [stable])
}

export interface PinActions {
  /** Pin or unpin a folder for offline use. */
  toggle(mailboxId: Id): void
}

export function usePinActions(): PinActions {
  const { db, accountId } = useReplica()
  return useMemo(
    () => ({
      toggle: (mailboxId) => {
        void updatePinnedMailboxes(db, accountId, (current) => togglePinned(current, mailboxId))
      },
    }),
    [db, accountId],
  )
}
