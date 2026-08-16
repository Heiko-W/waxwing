/**
 * The detailed quota breakdown in Settings → Server (M3.7, FR-QTA-01). One row per quota the server
 * exposes — a server may meter bytes and object counts separately, and the sidebar bar shows only
 * one of them.
 *
 * Only ever reached from the lazy `/settings` chunk, so it costs the entry bundle nothing.
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes, formatNumber } from '../i18n/formatters'
import styles from '../settings/settings.module.css'
import type { QuotaClient } from './quota-client'
import { toQuotaView } from './quota-model'
import { useQuota } from './use-quota'

export interface QuotaPanelProps {
  /** Injected in tests; defaults to the shared store's live client. */
  readonly client?: QuotaClient
}

export function QuotaPanel(props: QuotaPanelProps) {
  const { t } = useTranslation()
  const quotas = useQuota(props.client ? { client: props.client } : {})
  // Before the early return: a quota arriving later must not change the hook count (B20.6).
  const labelId = useId()

  if (quotas === null || quotas.length === 0) return null

  return (
    <div className={styles.field}>
      <span id={labelId} className={styles.label}>
        {t('quota.label')}
      </span>
      <dl className={styles.breakdown} aria-labelledby={labelId}>
        {quotas.map((quota) => {
          const view = toQuotaView(quota)
          const amount =
            view.resourceType === 'octets'
              ? t('quota.used', {
                  used: formatBytes(view.used),
                  total: formatBytes(view.limit),
                })
              : t('quota.used', {
                  used: formatNumber(view.used),
                  total: formatNumber(view.limit),
                })
          return (
            <div key={view.id} className={styles.breakdownRow}>
              <dt>{view.name}</dt>
              <dd>{amount}</dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}
