/**
 * Surfaces an intent that could not be queued (W-10).
 *
 * Every action surface dispatches fire-and-forget — the optimistic store update has already
 * happened and the UI must not wait on IndexedDB. Nothing caught the rejection, so a failed
 * `enqueueAction` (a full disk, realistically) left the row changed on screen with nothing behind
 * it: no outbox entry, no queued-sends chip, and a silent revert at the next reload.
 *
 * Mounted once in the shell beside {@link useStorageFullNotifier}, whose shape this follows. The
 * toast is `danger` and does not auto-dismiss: unlike a full cache, this one lost something the
 * user asked for, and they have to know which way the state actually went.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getDispatchFailureAt,
  getDispatchFailureMessage,
  subscribeDispatchFailure,
} from '../../sync'
import { useToast } from '../../ui'

export function useDispatchFailureNotifier(): void {
  const { t } = useTranslation()
  const { toast } = useToast()
  const at = useSyncExternalStore(subscribeDispatchFailure, getDispatchFailureAt, () => 0)
  const surfaced = useRef(0)

  useEffect(() => {
    if (at === 0 || surfaced.current === at) return
    surfaced.current = at
    // The message itself is not shown — it is a DOMException string, in English, about object
    // stores. The console keeps it for whoever is debugging.
    console.warn('[waxwing] could not queue an action:', getDispatchFailureMessage())
    toast({ tone: 'danger', title: t('status.dispatchFailed'), duration: 0 })
  }, [at, t, toast])
}
