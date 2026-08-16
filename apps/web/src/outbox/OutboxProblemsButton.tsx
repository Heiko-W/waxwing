/**
 * The persistent "some actions didn't go through" affordance in the header (M3.3). Hidden entirely
 * while the dead-letter queue is empty — it appears only when there is something to act on, which is
 * what makes it a gentle notice rather than permanent chrome.
 *
 * The dialog behind it is `lazy`-imported (mirroring `ComposerHost`): a surface most users never
 * open must not sit in the entry chunk.
 */

import { TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, IconButton } from '../ui'
import styles from './outbox.module.css'
import { useOutboxProblems } from './use-outbox-problems'

const OutboxProblemsDialog = lazy(() => import('./OutboxProblemsDialog'))

export function OutboxProblemsButton() {
  const { t } = useTranslation()
  // Counts the ROWS, not `useEngineStatus().failedActions` (B32). That counter is the PRIMARY
  // engine's scalar — shared engines are handed a discarding status sink — so this one line was why
  // the button stayed blind to a refused action on a delegated account. The rows are already in the
  // replica, keyed by account; counting them needs no change to the status model at all.
  const { rows } = useOutboxProblems()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  if (rows.length === 0) return null
  const failedActions = rows.length

  return (
    <>
      <IconButton
        label={t('outbox.problems.open', { count: failedActions })}
        className={styles.problemsButton}
        onClick={() => setOpen(true)}
      >
        <span className={styles.problemsIconWrap}>
          <TriangleAlert aria-hidden="true" className={styles.problemsIcon} />
          <span className={styles.problemsBadge}>
            <Badge tone="warning">{failedActions}</Badge>
          </span>
        </span>
      </IconButton>
      {open && (
        <Suspense fallback={null}>
          <OutboxProblemsDialog onClose={close} />
        </Suspense>
      )}
    </>
  )
}
