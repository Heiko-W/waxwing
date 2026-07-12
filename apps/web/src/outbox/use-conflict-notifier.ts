/**
 * Live conflict surfacing (M3.3, FR-OFF-03: "conflicts surface as gentle, actionable notices —
 * never silent data loss"). The moment an action is dead-lettered, this raises ONE warning toast
 * with the single action that makes sense for it (Keep in <folder> / OK / Try again). A toast alone
 * would not be enough — it auto-dismisses — so the persistent {@link OutboxProblemsButton} keeps
 * every unresolved problem reachable; this hook is the "you should know now" half.
 *
 * `warning`, not `danger`: an undone move is not an emergency. `danger` stays reserved for a failed
 * SEND — which is owned by {@link useSendErrorNotifier} (it reopens the draft), so `sendEmail` rows
 * are skipped here rather than double-toasted.
 *
 * Mounted once in the connected shell, next to `useDraftRestore`/`useSendErrorNotifier`.
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../ui'
import { describeConflict } from './describe-conflict'
import { useOutboxProblems } from './use-outbox-problems'

const ACTION_LABEL = {
  retry: 'outbox.action.retry',
  keepHere: 'outbox.action.keepHere',
  dismiss: 'outbox.action.dismiss',
} as const

export function useConflictNotifier(): void {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { rows, folderNames, ready, retry, discard } = useOutboxProblems()
  // Dedup by row id: the liveQuery re-emits the same dead letter on every unrelated outbox write.
  const surfaced = useRef<Set<string>>(new Set())

  useEffect(() => {
    // A toast is fired ONCE and never re-rendered, so it must not be built from half-loaded data:
    // until the mailbox names are in, `describeConflict` cannot tell "still loading" from "folder is
    // gone" and degrades a "Keep in Inbox" offer to a bare "OK" — permanently, because the dedup
    // below then skips the row forever. Wait; the row is not going anywhere.
    if (!ready) return
    for (const row of rows) {
      if (row.conflict == null) continue
      if (surfaced.current.has(row.id)) continue
      surfaced.current.add(row.id)
      const description = describeConflict(row, folderNames)
      if (description.action === 'none') continue // a send — the send notifier owns it
      const label = ACTION_LABEL[description.action]
      toast({
        tone: 'warning',
        title: t(description.titleKey, description.params),
        action: {
          label: t(label, description.params),
          onAction: () => {
            // "Keep in <folder>" and "OK" both mean *accept the rollback* — the message is already
            // back where it was, so accepting is exactly discarding the dead letter.
            void (description.action === 'retry' ? retry(row.id) : discard(row.id))
          },
        },
      })
    }
  }, [rows, folderNames, ready, retry, discard, t, toast])
}
