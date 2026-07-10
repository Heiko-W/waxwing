import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../i18n/formatters'
import styles from './demo.module.css'
import { pageInfo } from './pagination'

/** A flattened, presentational row (mapped from a partial Email in the container). */
export interface MessageRow {
  id: string
  sender: string
  subject: string | null
  preview: string
  /** UTCDate string. */
  receivedAt: string
  hasAttachment: boolean
  unread: boolean
}

export interface MessageListViewProps {
  rows: MessageRow[]
  /** 0-based window start (Email/query `position`). */
  position: number
  /** Calculated total across all pages (Email/query `total`). */
  total: number
  pageSize: number
  selectedId: string | null
  busy: boolean
  onSelect: (id: string) => void
  onPrev: () => void
  onNext: () => void
}

/**
 * Presentational paged message list. Paging math comes from the pure {@link pageInfo} helper
 * so prev/next disable correctly at both ends and the range label ("x–y of total") is exact.
 */
export function MessageListView(props: MessageListViewProps) {
  const { t } = useTranslation()
  const info = pageInfo(props.position, props.rows.length, props.total)

  return (
    <section className={styles.messages} aria-labelledby="demo-list-heading">
      <div className={styles.listHeader}>
        <h2 id="demo-list-heading" className={styles.cardHeading}>
          {t('demo.list.heading')}
        </h2>
        <div className={styles.pager}>
          <button
            type="button"
            className={styles.secondary}
            onClick={props.onPrev}
            disabled={!info.hasPrev || props.busy}
          >
            {t('demo.list.prev')}
          </button>
          <span className={styles.range} aria-live="polite">
            {t('demo.list.range', { from: info.from, to: info.to, total: info.total })}
          </span>
          <button
            type="button"
            className={styles.secondary}
            onClick={props.onNext}
            disabled={!info.hasNext || props.busy}
          >
            {t('demo.list.next')}
          </button>
        </div>
      </div>

      {props.rows.length === 0 ? (
        <p className={styles.hint}>{t('demo.list.empty')}</p>
      ) : (
        <ul className={styles.plainList}>
          {props.rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={`${styles.messageRow} ${row.unread ? styles.unreadRow : ''}`}
                aria-current={row.id === props.selectedId ? 'true' : undefined}
                onClick={() => props.onSelect(row.id)}
              >
                <span className={styles.rowTop}>
                  <span className={styles.rowSender}>{row.sender || t('demo.list.noSender')}</span>
                  <span className={styles.rowMeta}>
                    {row.unread && (
                      <span className={styles.dot} role="img" aria-label={t('demo.list.unread')} />
                    )}
                    {row.hasAttachment && (
                      <span
                        className={styles.clip}
                        role="img"
                        aria-label={t('demo.list.hasAttachment')}
                      >
                        ◆
                      </span>
                    )}
                    <time dateTime={row.receivedAt} className={styles.rowTime}>
                      {formatRelativeTime(new Date(row.receivedAt))}
                    </time>
                  </span>
                </span>
                <span className={styles.rowSubject}>{row.subject || t('demo.list.noSubject')}</span>
                <span className={styles.rowPreview}>{row.preview}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
