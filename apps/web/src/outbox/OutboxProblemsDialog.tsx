/**
 * The dead-letter list (M3.3) — the PERSISTENT half of "never silent data loss": a toast that was
 * missed (or dismissed) must not be the only trace of an action that did not go through. Every
 * unresolved problem is listed here with what the server said, when, and the two things the user can
 * do about it: try again, or discard it (the replica has already been rolled back either way).
 *
 * Lazily imported (see {@link OutboxProblemsButton}) so it stays out of the entry chunk.
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { OutboxRow } from '../sync'
import { Button, Dialog } from '../ui'
import { describeConflict } from './describe-conflict'
import styles from './outbox.module.css'
import { useOutboxProblems } from './use-outbox-problems'

/** A row whose account has no folder names loaded yet — `describeConflict` degrades to a plain offer. */
const NO_NAMES: ReadonlyMap<string, string> = new Map()

export interface OutboxProblemsDialogProps {
  /** Must be stable (useCallback) — the dialog closes itself once the last problem is resolved. */
  readonly onClose: () => void
}

export default function OutboxProblemsDialog({ onClose }: OutboxProblemsDialogProps) {
  const { t, i18n } = useTranslation()
  const { rows, folderNames, retry, discard, discardAll } = useOutboxProblems()

  // Once the last problem is retried/discarded there is nothing left to act on — and the trigger
  // button hides itself at zero, so leaving an empty modal open would strand focus in dead chrome.
  const hadRows = useRef(false)
  useEffect(() => {
    if (rows.length > 0) {
      hadRows.current = true
      return
    }
    if (hadRows.current) onClose()
  }, [rows, onClose])

  const when = (row: OutboxRow): string => {
    const at = row.conflict?.at ?? row.createdAt
    return new Date(at).toLocaleString(i18n.language)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('outbox.problems.title')}
      size="md"
      footer={
        <>
          {rows.length > 0 && (
            <Button variant="ghost" onClick={() => void discardAll()}>
              {t('outbox.problems.discardAll')}
            </Button>
          )}
          <Button onClick={onClose}>{t('ui.dialog.close')}</Button>
        </>
      }
    >
      {rows.length === 0 ? (
        <p className={styles.empty}>{t('outbox.problems.empty')}</p>
      ) : (
        <ul className={styles.problems}>
          {rows.map((row) => {
            // The ROW's account names its folders (B32): mailbox ids are per-account and short, so a
            // flat map would confidently name the wrong folder for a shared account's row.
            const description = describeConflict(row, folderNames.get(row.accountId) ?? NO_NAMES)
            const retryable = description.action === 'retry'
            return (
              <li key={row.id} className={styles.problem}>
                <div className={styles.problemText}>
                  <p className={styles.problemTitle}>
                    {t(description.titleKey, description.params)}
                  </p>
                  {row.conflict?.detail ? (
                    <p className={styles.problemDetail}>{row.conflict.detail}</p>
                  ) : null}
                  <p className={styles.problemMeta}>{when(row)}</p>
                </div>
                <div className={styles.problemActions}>
                  {retryable && (
                    <Button size="sm" variant="ghost" onClick={() => void retry(row.id)}>
                      {t('outbox.action.retry')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void discard(row.id)}>
                    {t('outbox.action.discard')}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}
