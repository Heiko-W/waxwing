/**
 * The reading pane's conversation (M1.8, FR-RD-09). Loads the opened message and, when it belongs to
 * a thread, the whole thread in stored order (oldest → newest). The opened message and the newest are
 * expanded to full {@link MessageView}s; the rest are collapsed one-line envelopes that expand on
 * demand. A single subject heading sits above the thread so it is not repeated per message.
 *
 * Thread members whose envelope was never backfilled (a collapsed-threads sync stores only the anchor
 * id) are hydrated on demand via {@link useEnsureEnvelopes}, so an older reply or a Sent message does
 * not render as a permanent skeleton; a deep link to a message that genuinely does not exist resolves
 * to an explicit "not available" state rather than an endless spinner.
 */

import { type Ref, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDraftOpener } from '../compose'
import { type EmailRow, useEmail, useThread } from '../sync'
import { Avatar, Button, Skeleton } from '../ui'
import { formatMessageTime } from './format-message-time'
import { MessageView } from './MessageView'
import { senderName } from './message-body'
import styles from './reading.module.css'
import { useEnsureEnvelopes } from './useMessageBody'

export interface ConversationProps {
  readonly emailId: string
  readonly mailboxId: string | undefined
}

export function Conversation({ emailId, mailboxId }: ConversationProps) {
  const { t } = useTranslation()
  const opened = useEmail(emailId)
  const thread = useThread(opened?.threadId ?? '')

  const ids = thread !== undefined && thread.emailIds.length > 0 ? thread.emailIds : [emailId]
  const newestId = thread?.emailIds.at(-1)

  // Hydrate any thread members the replica does not yet hold (envelopes not backfilled). `settled`
  // flips true once the fetch attempt completes, distinguishing "loading" from "no such message".
  const { settled } = useEnsureEnvelopes(ids.join(','))

  // Expand the opened message and the newest. Reset the baseline only when the OPENED message
  // changes; when a new message merely arrives (newestId changes) merge it in rather than
  // collapsing whatever the reader is currently looking at.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([emailId]))
  const openedRef = useRef(emailId)
  useEffect(() => {
    if (openedRef.current !== emailId) {
      openedRef.current = emailId
      const next = new Set([emailId])
      if (newestId !== undefined) next.add(newestId)
      setExpanded(next)
    } else if (newestId !== undefined) {
      setExpanded((prev) => (prev.has(newestId) ? prev : new Set(prev).add(newestId)))
    }
  }, [emailId, newestId])

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (opened === undefined) {
    if (settled) {
      // The fetch completed but produced no row — a deep link to a message we cannot see.
      return (
        <div className={styles.conversation}>
          <p className={styles.emptyReading}>{t('reading.notAvailable')}</p>
        </div>
      )
    }
    return (
      <div className={styles.conversation} aria-busy="true">
        <Skeleton width="60%" height={20} />
        <Skeleton width="100%" height={120} />
      </div>
    )
  }

  const collapsible = ids.length > 1

  return (
    <div className={styles.conversation}>
      <h2 className={styles.subject}>{opened.subject || t('list.noSubject')}</h2>
      {ids.length > 1 && (
        <p className={styles.threadCount}>{t('reading.threadCount', { count: ids.length })}</p>
      )}
      <ol className={styles.thread}>
        {ids.map((id) => (
          <li key={id} className={styles.threadItem}>
            <ThreadItem
              id={id}
              mailboxId={mailboxId}
              expanded={expanded.has(id)}
              isOpened={id === emailId}
              collapsible={collapsible}
              onToggle={() => toggle(id)}
            />
          </li>
        ))}
      </ol>
    </div>
  )
}

interface ThreadItemProps {
  readonly id: string
  readonly mailboxId: string | undefined
  readonly expanded: boolean
  /** True for the message the reader actually opened (gates auto-mark-read). */
  readonly isOpened: boolean
  /** True when this message is part of a multi-message thread and may be collapsed again. */
  readonly collapsible: boolean
  readonly onToggle: () => void
}

function ThreadItem({ id, mailboxId, expanded, isOpened, collapsible, onToggle }: ThreadItemProps) {
  const email = useEmail(id)
  const collapsedRef = useRef<HTMLButtonElement>(null)
  const expandedRef = useRef<HTMLDivElement>(null)
  const prevExpanded = useRef(expanded)

  // When a message toggles, move focus to the surface that replaced the control the user activated,
  // so keyboard/SR focus is never dropped to document.body (WCAG 2.4.3). Never on the initial mount.
  useEffect(() => {
    if (prevExpanded.current === expanded) return
    prevExpanded.current = expanded
    if (expanded) expandedRef.current?.focus()
    else collapsedRef.current?.focus()
  }, [expanded])

  if (email === undefined) return <Skeleton width="100%" height={48} />
  // A draft opens back into the composer rather than rendering as a read-only message (FR-CMP-03).
  if (email.keywords.$draft === true) {
    return (
      <div ref={expandedRef} tabIndex={-1} className={styles.expandedItem}>
        <DraftCallout id={id} />
      </div>
    )
  }
  if (expanded) {
    return (
      <div ref={expandedRef} tabIndex={-1} className={styles.expandedItem}>
        <MessageView
          email={email}
          mailboxId={mailboxId}
          autoMark={isOpened}
          onCollapse={collapsible ? onToggle : undefined}
        />
      </div>
    )
  }
  return <CollapsedMessage ref={collapsedRef} email={email} onExpand={onToggle} />
}

/** Deep-link affordance for a draft reached in the reading pane: edit it in the composer. */
function DraftCallout({ id }: { readonly id: string }) {
  const { t } = useTranslation()
  const draftOpener = useDraftOpener()
  return (
    <div className={styles.draftCallout}>
      <p className={styles.draftCalloutLead}>{t('reading.draftLead')}</p>
      <Button variant="primary" onClick={() => void draftOpener.open(id)}>
        {t('reading.editDraft')}
      </Button>
    </div>
  )
}

function CollapsedMessage({
  email,
  onExpand,
  ref,
}: {
  readonly email: EmailRow
  readonly onExpand: () => void
  readonly ref?: Ref<HTMLButtonElement>
}) {
  const { t } = useTranslation()
  const name = senderName(email.from, t('list.noSender'))
  const unread = email.keywords.$seen !== true
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.collapsed}${unread ? ` ${styles.collapsedUnread}` : ''}`}
      onClick={onExpand}
      aria-expanded={false}
    >
      <Avatar name={name} size="sm" />
      <span className={styles.collapsedFrom}>{name}</span>
      <span className={styles.collapsedPreview}>{email.preview}</span>
      <time className={styles.collapsedTime} dateTime={email.receivedAt}>
        {formatMessageTime(email.receivedAt)}
      </time>
    </button>
  )
}
