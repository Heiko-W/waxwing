import type { Mailbox } from '@waxwing/jmap'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '../i18n/formatters'
import styles from './demo.module.css'

export interface MailboxListViewProps {
  mailboxes: Mailbox[]
  selectedId: string | null
  onSelect: (id: string) => void
}

/** Presentational mailbox list: name, role and live total/unread counts from Mailbox/get. */
export function MailboxListView({ mailboxes, selectedId, onSelect }: MailboxListViewProps) {
  const { t } = useTranslation()

  return (
    <nav className={styles.mailboxes} aria-label={t('demo.mailboxes.heading')}>
      <h2 className={styles.cardHeading}>{t('demo.mailboxes.heading')}</h2>
      <ul className={styles.plainList}>
        {mailboxes.map((mailbox) => (
          <li key={mailbox.id}>
            <button
              type="button"
              className={styles.mailboxButton}
              aria-current={mailbox.id === selectedId ? 'true' : undefined}
              onClick={() => onSelect(mailbox.id)}
            >
              <span className={styles.mailboxName}>{mailbox.name}</span>
              {mailbox.role && <span className={styles.tag}>{mailbox.role}</span>}
              <span className={styles.mailboxCounts}>
                {t('demo.mailboxes.counts', {
                  unread: formatNumber(mailbox.unreadEmails),
                  total: formatNumber(mailbox.totalEmails),
                })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
