/**
 * The proactive quota warning (M3.7, FR-QTA-01): tell the user at ≥ 90 %, and again once the server
 * is actually refusing writes.
 *
 * It rides the existing Toast — no second live region, no new notification surface (the M3.4 storage
 * notifier's pattern, mounted beside it). The DURABLE surface is the sidebar bar; the toast is only
 * the "you should know this now" half, and it fires **once per quota per level per tab**: a warning
 * that repeats every sync pass is a warning people learn to dismiss without reading.
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../ui'
import type { QuotaClient } from './quota-client'
import { pickPrimaryQuota, toQuotaView } from './quota-model'
import { useQuota } from './use-quota'

export interface QuotaNotifierOptions {
  /** Injected in tests; defaults to the shared store's live client (the seam every section uses). */
  readonly client?: QuotaClient
}

export function useQuotaNotifier(options: QuotaNotifierOptions = {}): void {
  const { t } = useTranslation()
  const { toast } = useToast()
  const quotas = useQuota(options.client ? { client: options.client } : {})
  const surfaced = useRef(new Set<string>())

  const primary = quotas === null ? null : pickPrimaryQuota(quotas)
  const view = primary === null ? null : toQuotaView(primary)
  const level = view?.level ?? 'ok'
  const id = view?.id ?? ''

  useEffect(() => {
    if (view === null || level === 'ok') return
    const seen = `${id}:${level}`
    if (surfaced.current.has(seen)) return
    surfaced.current.add(seen)
    toast(
      level === 'over'
        ? { tone: 'danger', title: t('quota.fullToast') }
        : { tone: 'warning', title: t('quota.warnToast') },
    )
    // `view` is derived from `quotas`; only its id and level may re-fire a toast.
  }, [view, id, level, t, toast])
}
