/**
 * The list of messages the server is holding for later delivery (M5.4, FR-CMP-11).
 *
 * Separate from {@link QueuedSends}, and the distinction is the point: a queued send is still on
 * this device and cancelling it is local. A scheduled send has already been accepted by the server
 * — cancelling it is a request that can be refused, because the moment may have passed while the
 * list was on screen.
 *
 * Rendered in Settings rather than as a floating chip: these live for hours or days, and something
 * that persists that long belongs somewhere a user goes looking, not somewhere that hovers.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionOptional } from '../app/session/context'
import { formatDate } from '../i18n/formatters'
import { Button, useToast } from '../ui'
import styles from './outbox.module.css'
import { makeScheduledClient, type ScheduledClient, type ScheduledSend } from './scheduled-client'

export interface ScheduledSendsProps {
  /** Injected in tests; defaults to a client built from the live session. */
  readonly client?: ScheduledClient
}

export function ScheduledSends(props: ScheduledSendsProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const connected = useSessionOptional()
  const [items, setItems] = useState<ScheduledSend[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const injected = props.client
  const sessionClient = connected?.client ?? null
  const accountId = connected?.accountId ?? null
  const client = useMemo(
    () =>
      injected ??
      (sessionClient === null || accountId === null
        ? null
        : makeScheduledClient(sessionClient, accountId)),
    [injected, sessionClient, accountId],
  )

  const load = useCallback(async () => {
    if (client === null) return
    try {
      setItems(await client.list())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  if (client === null) return null

  const cancel = async (item: ScheduledSend): Promise<void> => {
    setBusy(item.id)
    try {
      const cancelled = await client.cancel(item.id)
      // "Too late" is not a failure to apologise for: the message went out, which is what was
      // asked for in the first place. Saying so plainly beats an error the user cannot act on.
      toast({ title: cancelled ? t('outbox.scheduled.cancelled') : t('outbox.scheduled.tooLate') })
      await load()
    } finally {
      setBusy(null)
    }
  }

  if (failed) {
    return (
      <p className={styles.scheduledEmpty} role="alert">
        {t('outbox.scheduled.loadFailed')}
      </p>
    )
  }

  if (items === null)
    return <p className={styles.scheduledEmpty}>{t('outbox.scheduled.loading')}</p>
  if (items.length === 0) {
    return <p className={styles.scheduledEmpty}>{t('outbox.scheduled.empty')}</p>
  }

  return (
    <ul className={styles.scheduledList}>
      {items.map((item) => (
        <li key={item.id} className={styles.scheduledRow}>
          <div className={styles.scheduledText}>
            <p className={styles.scheduledSubject}>{item.subject || t('compose.noSubject')}</p>
            <p className={styles.scheduledWhen}>
              {t('outbox.scheduled.willSend', {
                when: formatDate(new Date(item.sendAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === item.id}
            onClick={() => void cancel(item)}
          >
            {t('outbox.scheduled.cancel')}
          </Button>
        </li>
      ))}
    </ul>
  )
}
