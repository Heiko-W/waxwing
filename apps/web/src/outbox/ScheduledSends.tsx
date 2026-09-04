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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionOptional } from '../app/session/context'
import { useOnline } from '../app/use-online'
import { formatDate } from '../i18n/formatters'
import { RECONNECT_DEBOUNCE_MS } from '../sync/engine'
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
  const online = useOnline()
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

  /*
   * And again when the line comes back — the same shape `CalendarPage` uses (N-05).
   *
   * This list is fetched once and never refreshed, and its failure state is worse than the
   * calendar's: there is no "Try again" here at all, so a reader who opened Settings offline sat
   * on "The scheduled messages could not be loaded" for the rest of the session, over messages the
   * server is holding and will send whether or not this app is open. That is the one sentence this
   * section must never be wrong about.
   *
   * On the EDGE (`online` was false), so a normally connected visit adds no second request to the
   * one above; and on the engine's own {@link RECONNECT_DEBOUNCE_MS}, imported rather than
   * repeated, so a flapping line asks once.
   */
  const wasOnline = useRef(online)
  useEffect(() => {
    const reconnected = online && !wasOnline.current
    wasOnline.current = online
    if (!reconnected) return
    const timer = window.setTimeout(() => void load(), RECONNECT_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [online, load])

  if (client === null) return null

  const cancel = async (item: ScheduledSend): Promise<void> => {
    setBusy(item.id)
    try {
      const cancelled = await client.cancel(item.id)
      // "Too late" is not a failure to apologise for: the message went out, which is what was
      // asked for in the first place. Saying so plainly beats an error the user cannot act on.
      toast({ title: cancelled ? t('outbox.scheduled.cancelled') : t('outbox.scheduled.tooLate') })
      await load()
    } catch {
      // A refused cancel and an unreachable server are DIFFERENT answers, and only the first one
      // was ever spoken. Without this the spinner just stopped: the row stayed, no toast, and the
      // reader was left not knowing whether the message is still going out (R-55). `load()` is not
      // retried here — the same transport just failed, and its own failure path already owns the
      // "could not be loaded" line.
      toast({ tone: 'danger', title: t('outbox.scheduled.cancelFailed') })
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
