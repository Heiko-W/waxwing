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
import { Link, useRouterOptional } from '../app/route'
import { formatBytes } from '../i18n/formatters'
import styles from './quota.module.css'
import type { QuotaClient } from './quota-client'
import { pickPrimaryQuota, toQuotaView } from './quota-model'
import { useQuota } from './use-quota'

/**
 * The way out of a full mailbox (M-2): an all-mailboxes search for anything over 5 MB, Trash and
 * Junk INCLUDED — deleted mail still occupies the quota, so the scope that answers "what is filling
 * this up?" is the widest one, not the everyday default.
 *
 * 5 MB because that is roughly where an attachment stops being incidental; the query is an ordinary
 * search string, so the reader can widen or narrow it in the box it lands in.
 */
const LARGE_MESSAGE_SEARCH = `/mail?${new URLSearchParams({ q: 'larger:5M', scope: 'everywhere' }).toString()}`

export interface QuotaBarProps {
  /** Injected in tests; defaults to the shared store's live client. */
  readonly client?: QuotaClient
}

export function QuotaBar(props: QuotaBarProps) {
  const { t } = useTranslation()
  const quotas = useQuota(props.client ? { client: props.client } : {})
  // Optional: the bar's job is to show a number, and it must keep doing that wherever it is mounted.
  const router = useRouterOptional()
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
      {/* Only once the number is bad news. A permanent "find large messages" link beside a bar that
          reads 4 % is clutter offering to solve a problem nobody has; at 90 % it is the next thing
          the reader wants and it is already under their eyes. */}
      {view.level !== 'ok' && router !== null && (
        <Link className={styles.action} to={LARGE_MESSAGE_SEARCH}>
          {t('search.findLarge')}
        </Link>
      )}
    </div>
  )
}
