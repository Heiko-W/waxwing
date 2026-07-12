/**
 * Surfaces a full disk (M3.4, FR-OFF-04). A cache write that cannot get space is BEST-EFFORT — the
 * message still opens, the attachment still downloads — so nothing throws and nothing in the UI would
 * otherwise change. But the user must learn that mail has silently stopped being kept offline, or the
 * app's central promise (it works offline) fails quietly. Mounted once in the shell, next to the send
 * and conflict notifiers; it toasts once per event, never on a loop.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { getStorageFullAt, subscribeStorageFull } from '../../sync'
import { useToast } from '../../ui'

export function useStorageFullNotifier(): void {
  const { t } = useTranslation()
  const { toast } = useToast()
  const at = useSyncExternalStore(subscribeStorageFull, getStorageFullAt, () => 0)
  const surfaced = useRef(0)

  useEffect(() => {
    if (at === 0 || surfaced.current === at) return
    surfaced.current = at
    toast({ tone: 'warning', title: t('status.storage.full') })
  }, [at, t, toast])
}
