/**
 * Settings → Server (M3.7, FR-SRV-04): admin diagnostics — what this server is, what it allows, and
 * which optional JMAP features it offers.
 *
 * Availability is stated as WORDS ("Offered" / "Not offered"), never as a colour or an icon alone
 * (WCAG 1.4.1). Capabilities Waxwing does not know about are listed raw rather than swallowed: a
 * diagnostics panel that silently drops what it cannot name is worse than no panel.
 *
 * The session is the one captured at sign-in. Nothing re-fetches it (no `refreshSession` is wired,
 * and re-fetching would not update the React context anyway) — capabilities do not change hourly, and
 * a refresh button would imply a freshness we do not actually have.
 */

import { useTranslation } from 'react-i18next'
import { useSessionOptional } from '../app/session/context'
import type { JmapSession } from '../app/session/types'
import { formatBytes, formatNumber } from '../i18n/formatters'
import type { QuotaClient } from '../quota'
import { QuotaPanel } from '../quota/QuotaPanel'
import { buildCapabilitiesView, type LimitRow, type LimitValue } from './capabilities-model'
import styles from './settings.module.css'

export interface ServerSectionProps {
  /** Injected in tests; defaults to the live session from context. */
  readonly session?: JmapSession
  readonly accountId?: string
  /** Injected in tests; forwarded to the quota panel. */
  readonly quotaClient?: QuotaClient
}

function LimitList(props: { readonly rows: readonly LimitRow[] }) {
  const { t } = useTranslation()

  function render(value: LimitValue): string {
    switch (value.kind) {
      case 'bytes':
        return formatBytes(value.value)
      case 'count':
        return formatNumber(value.value)
      case 'bool':
        return value.value ? t('settings.server.yes') : t('settings.server.no')
      case 'list':
        return value.value.length === 0 ? t('settings.server.none') : value.value.join(', ')
      case 'unlimited':
        return t('settings.server.unlimited')
    }
  }

  return (
    <dl className={styles.breakdown}>
      {props.rows.map((row) => (
        <div key={row.key} className={styles.breakdownRow}>
          <dt>{t(`settings.server.limit.${row.key}`)}</dt>
          <dd>{render(row.value)}</dd>
        </div>
      ))}
    </dl>
  )
}

export function ServerSection(props: ServerSectionProps) {
  const { t } = useTranslation()
  const connected = useSessionOptional()
  const session = props.session ?? connected?.jmapSession ?? null
  const accountId = props.accountId ?? connected?.accountId ?? null

  if (session === null || accountId === null) return null
  const view = buildCapabilitiesView(session, accountId)

  return (
    <div className={styles.controls}>
      <p className={styles.hint}>{t('settings.server.description')}</p>

      <dl className={styles.breakdown}>
        <div className={styles.breakdownRow}>
          <dt>{t('settings.server.connection.url')}</dt>
          <dd>{view.apiOrigin}</dd>
        </div>
        <div className={styles.breakdownRow}>
          <dt>{t('settings.server.connection.username')}</dt>
          <dd>{view.username}</dd>
        </div>
        <div className={styles.breakdownRow}>
          <dt>{t('settings.server.connection.account')}</dt>
          <dd>
            {view.accountName}
            {view.accountIsReadOnly ? ` — ${t('settings.server.connection.readOnly')}` : ''}
          </dd>
        </div>
      </dl>

      <QuotaPanel {...(props.quotaClient ? { client: props.quotaClient } : {})} />

      <div className={styles.field}>
        <span className={styles.label}>{t('settings.server.core.title')}</span>
        {view.core === null ? (
          <p className={styles.hint}>{t('settings.server.coreMissing')}</p>
        ) : (
          <LimitList rows={view.core} />
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>{t('settings.server.mail.title')}</span>
        {view.mail === null ? (
          <p className={styles.hint}>{t('settings.server.mailMissing')}</p>
        ) : (
          <LimitList rows={view.mail} />
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>{t('settings.server.capabilities.title')}</span>
        <dl className={styles.breakdown}>
          {view.known.map((row) => (
            <div key={row.urn} className={styles.breakdownRow}>
              <dt>{t(`settings.server.cap.${row.key}`)}</dt>
              {/* Words, not a colour: a red dot is not an answer for anyone who cannot see it. */}
              <dd>{row.present ? t('settings.server.available') : t('settings.server.absent')}</dd>
            </div>
          ))}
        </dl>
      </div>

      {view.extra.length > 0 && (
        <div className={styles.field}>
          <span className={styles.label}>{t('settings.server.extra.title')}</span>
          <ul className={styles.urnList}>
            {view.extra.map((urn) => (
              <li key={urn}>{urn}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
