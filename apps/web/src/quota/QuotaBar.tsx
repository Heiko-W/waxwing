/**
 * The mailbox-quota bar in the folder sidebar (M3.7, FR-QTA-01).
 *
 * Always present when the server offers a quota — compact and muted while there is room, and saying
 * so in WORDS once there is not. A meter you only notice when it is too late is exactly why people
 * are surprised by a full mailbox.
 *
 * Renders nothing at all when the server has no quota capability, when the fetch failed, or when no
 * quota is meterable. Nothing is a better answer than a bar that means nothing.
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../i18n/formatters'
import styles from './quota.module.css'
import type { QuotaClient } from './quota-client'
import { pickPrimaryQuota, toQuotaView } from './quota-model'
import { useQuota } from './use-quota'

export interface QuotaBarProps {
  /** Injected in tests; defaults to the shared store's live client. */
  readonly client?: QuotaClient
}

export function QuotaBar(props: QuotaBarProps) {
  const { t } = useTranslation()
  const quotas = useQuota(props.client ? { client: props.client } : {})
  const labelId = useId()
  const summaryId = useId()

  if (quotas === null) return null
  const primary = pickPrimaryQuota(quotas)
  if (primary === null) return null
  const view = toQuotaView(primary)

  const summary =
    view.level === 'over'
      ? t('quota.full')
      : view.level === 'warn'
        ? t('quota.nearlyFull', {
            used: formatBytes(view.used),
            total: formatBytes(view.limit),
          })
        : t('quota.used', { used: formatBytes(view.used), total: formatBytes(view.limit) })

  return (
    <div className={styles.bar} data-level={view.level}>
      <span id={labelId} className={styles.label}>
        {t('quota.label')}
      </span>
      {/* Native <progress> carries role="progressbar"; the numbers live in the TEXT it points at,
          never in the bar alone, and the warn/over state changes that text — not just its colour. */}
      <progress
        className={styles.meter}
        value={view.used}
        max={view.limit}
        aria-labelledby={labelId}
        aria-describedby={summaryId}
      />
      <span id={summaryId} className={styles.summary}>
        {summary}
      </span>
    </div>
  )
}
