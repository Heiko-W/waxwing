/**
 * One fully-rendered message (M1.8): header (sender, recipients, date, an expandable details
 * disclosure — FR-RD-06), the remote-content banner (FR-RD-04), the sanitized body in the sandboxed
 * frame (FR-RD-01), attachments (FR-RD-05), and an action bar (archive/junk/trash/move/flag/mark
 * unread via the outbox; reply/reply-all/forward seed a composer draft — M2.3, FR-CMP-02). Bodies are
 * fetched on open and the message is auto-marked read after a short dwell unless disabled or already
 * read (FR-RD-07). Remote content is allowed when the deployment default is `allow`, the sender is on
 * the local allowlist, or the reader clicks "Load images".
 */

import { renderPlainText, sanitize } from '@waxwing/mail-html'
import {
  Archive,
  ChevronDown,
  ChevronUp,
  Forward,
  MailMinus,
  MailWarning,
  Reply,
  ReplyAll,
  Star,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSession } from '../app/session/context'
import {
  buildReplyDraft,
  forwardAttachments,
  ownAddresses,
  type ReplyKind,
  useComposerStore,
} from '../compose'
import { formatDate } from '../i18n/formatters'
import { type EmailRow, setPref, useMailboxByRole, useReplica } from '../sync'
import { Avatar, Button, Dialog, IconButton, Spinner } from '../ui'
import { AttachmentList } from './AttachmentList'
import { LabelMenuButton } from './labels/LabelMenuButton'
import { MailBodyFrame } from './MailBodyFrame'
import { MoveDialog } from './MoveDialog'
import { formatAddressList, senderAddress, senderName } from './message-body'
import { RemoteContentBanner } from './RemoteContentBanner'
import styles from './reading.module.css'
import {
  READING_PREF_KEYS,
  useAutoMarkRead,
  useRemoteAllowList,
  useRemoteContentDefault,
} from './reading-prefs'
import { useMessageActions } from './use-message-actions'
import { useInlineImages } from './useInlineImages'
import { useMessageBody } from './useMessageBody'

/** How long an opened message must stay open before it is auto-marked read (FR-RD-07). */
export const AUTO_MARK_READ_DELAY_MS = 1500

export interface MessageViewProps {
  readonly email: EmailRow
  /** The mailbox the message is being read in (source for a move); undefined = unknown. */
  readonly mailboxId: string | undefined
  /**
   * Whether this message may auto-mark itself read on dwell (FR-RD-07). Defaults to `true`; a
   * conversation passes `false` for every message except the one the reader actually opened, so
   * an auto-expanded sibling (the thread's newest) is not silently marked read.
   */
  readonly autoMark?: boolean
  /** When set, render a collapse control (this message is an expandable thread member). */
  readonly onCollapse?: (() => void) | undefined
}

export function MessageView({ email, mailboxId, autoMark = true, onCollapse }: MessageViewProps) {
  const { t } = useTranslation()
  const { db, accountId } = useReplica()
  const actions = useMessageActions()
  const openDraft = useComposerStore((state) => state.openDraft)
  const { connected } = useSession()
  const own = useMemo(
    () => (connected ? ownAddresses(connected.jmapSession, accountId) : []),
    [connected, accountId],
  )
  const { body, htmlParts, textBody, loading } = useMessageBody(email.id)
  const { resolveCid, ready } = useInlineImages(accountId, body)

  const archiveBox = useMailboxByRole('archive')
  const junkBox = useMailboxByRole('junk')
  const trashBox = useMailboxByRole('trash')
  const inThisMailbox = mailboxId ?? null

  const [detailsOpen, setDetailsOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)

  // Remote content: deployment default, sender allowlist, or an explicit "Load images" this session.
  const remoteAllow = useRemoteAllowList()
  const fromAddress = senderAddress(email.from)
  const trustedSender = fromAddress !== null && remoteAllow.includes(fromAddress)
  const allowRemote = useRemoteContentDefault() === 'allow' || trustedSender || loadedOnce

  // Auto-mark-read after a dwell (FR-RD-07), unless disabled, already read, or this is a sibling
  // message the reader did not open (a conversation passes autoMark=false for those).
  const autoMarkRead = useAutoMarkRead()
  useEffect(() => {
    if (!autoMark || !autoMarkRead || email.keywords.$seen === true) return
    const timer = window.setTimeout(
      () => actions.setSeen([email.id], true),
      AUTO_MARK_READ_DELAY_MS,
    )
    return () => window.clearTimeout(timer)
  }, [autoMark, autoMarkRead, email.id, email.keywords.$seen, actions])

  // Sanitize only once inline images are downloaded, so `cid:` refs resolve synchronously.
  const joinedHtml = useMemo(
    () => (htmlParts !== null ? htmlParts.map((part) => part.value).join('') : null),
    [htmlParts],
  )
  const sanitized = useMemo(() => {
    if (joinedHtml === null || !ready) return null
    return sanitize(joinedHtml, { allowRemote, resolveCid })
  }, [joinedHtml, allowRemote, ready, resolveCid])

  const isHtml = htmlParts !== null
  const bodyHtml = isHtml
    ? (sanitized?.html ?? null)
    : renderPlainText(textBody, { quotedLabel: t('reading.quotedLabel') })
  const hasRemoteContent = sanitized?.hasRemoteContent ?? false

  const onOpenLink = useCallback((href: string) => {
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [])

  const name = senderName(email.from, t('list.noSender'))
  const dateLabel = formatDate(new Date(email.receivedAt), {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  // Open a reply / reply-all / forward draft seeded from this message (M2.3, FR-CMP-02/10).
  const onCompose = useCallback(
    (kind: ReplyKind): void => {
      const bodyHtml = isHtml ? (sanitized?.html ?? joinedHtml) : null
      const forwardHeaderBlock = [
        `${t('compose.forwardLabelFrom')}: ${formatAddressList(email.from, t('list.noSender'))}`,
        `${t('compose.forwardLabelDate')}: ${dateLabel}`,
        `${t('compose.forwardLabelSubject')}: ${email.subject ?? ''}`,
        `${t('compose.forwardLabelTo')}: ${formatAddressList(email.to, t('reading.noRecipients'))}`,
      ].join('\n')
      const init = buildReplyDraft({
        kind,
        source: email,
        bodyHtml,
        textBody,
        ownAddresses: own,
        attribution: t('compose.replyAttribution', { date: dateLabel, name }),
        forwardSeparator: t('compose.forwardSeparator'),
        forwardHeaderBlock,
      })
      const attachments = kind === 'forward' && body !== undefined ? forwardAttachments(body) : []
      openDraft({
        ...init,
        attachments,
        sourceEmailId: init.sourceEmailId,
        sourceFlag: init.sourceKind === 'forward' ? '$forwarded' : '$answered',
      })
    },
    [isHtml, sanitized, joinedHtml, email, textBody, own, t, dateLabel, name, body, openDraft],
  )

  const onAlwaysAllow =
    fromAddress !== null
      ? () => {
          setLoadedOnce(true)
          void setPref(db, accountId, READING_PREF_KEYS.remoteAllow, [...remoteAllow, fromAddress])
        }
      : undefined

  const inTrash = trashBox !== undefined && inThisMailbox === trashBox.id

  return (
    <article className={styles.message} aria-label={email.subject || t('list.noSubject')}>
      <header className={styles.header}>
        <Avatar name={name} size="md" />
        <div className={styles.headerMain}>
          <div className={styles.headerTop}>
            <span className={styles.from}>{name}</span>
            <time className={styles.date} dateTime={email.receivedAt}>
              {dateLabel}
            </time>
            {onCollapse !== undefined && (
              <IconButton
                label={t('reading.collapse')}
                variant="ghost"
                size="sm"
                aria-expanded={true}
                onClick={onCollapse}
              >
                <ChevronUp />
              </IconButton>
            )}
          </div>
          <div className={styles.headerSub}>
            <span className={styles.recipients}>
              {t('reading.to')}: {formatAddressList(email.to, t('reading.noRecipients'))}
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              {detailsOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              {t('reading.details')}
            </Button>
          </div>
          {detailsOpen && (
            <dl className={styles.details}>
              <dt>{t('reading.from')}</dt>
              <dd>{formatAddressList(email.from, t('list.noSender'))}</dd>
              <dt>{t('reading.to')}</dt>
              <dd>{formatAddressList(email.to, t('reading.noRecipients'))}</dd>
              {email.cc !== null && email.cc.length > 0 && (
                <>
                  <dt>{t('reading.cc')}</dt>
                  <dd>{formatAddressList(email.cc, t('reading.noRecipients'))}</dd>
                </>
              )}
              <dt>{t('reading.date')}</dt>
              <dd>{dateLabel}</dd>
            </dl>
          )}
        </div>
      </header>

      <div className={styles.actionBar} role="toolbar" aria-label={t('reading.actions')}>
        <IconButton
          label={t('list.actions.archive')}
          variant="ghost"
          disabled={archiveBox === undefined}
          onClick={() => archiveBox && actions.move([email.id], inThisMailbox, archiveBox.id)}
        >
          <Archive />
        </IconButton>
        <IconButton
          label={t('list.actions.junk')}
          variant="ghost"
          disabled={junkBox === undefined}
          onClick={() => junkBox && actions.move([email.id], inThisMailbox, junkBox.id)}
        >
          <MailWarning />
        </IconButton>
        <IconButton
          label={inTrash ? t('list.actions.delete') : t('list.actions.trash')}
          variant="ghost"
          disabled={!inTrash && trashBox === undefined}
          onClick={() =>
            inTrash
              ? setConfirmDelete(true)
              : trashBox && actions.move([email.id], inThisMailbox, trashBox.id)
          }
        >
          <Trash2 />
        </IconButton>
        <IconButton
          label={
            email.keywords.$flagged === true ? t('list.actions.unflag') : t('list.actions.flag')
          }
          variant="ghost"
          onClick={() => actions.setFlagged([email.id], email.keywords.$flagged !== true)}
        >
          <Star className={email.keywords.$flagged === true ? styles.flagOn : undefined} />
        </IconButton>
        <IconButton
          label={t('reading.markUnread')}
          variant="ghost"
          onClick={() => actions.setSeen([email.id], false)}
        >
          <MailMinus />
        </IconButton>
        <LabelMenuButton ids={[email.id]} />
        <Button size="sm" variant="ghost" onClick={() => setMoveOpen(true)}>
          {t('list.actions.move')}
        </Button>
        <span className={styles.actionSpacer} />
        <IconButton
          label={t('reading.reply')}
          variant="ghost"
          disabled={loading}
          onClick={() => onCompose('reply')}
        >
          <Reply />
        </IconButton>
        <IconButton
          label={t('reading.replyAll')}
          variant="ghost"
          disabled={loading}
          onClick={() => onCompose('replyAll')}
        >
          <ReplyAll />
        </IconButton>
        <IconButton
          label={t('reading.forward')}
          variant="ghost"
          disabled={loading}
          onClick={() => onCompose('forward')}
        >
          <Forward />
        </IconButton>
      </div>

      {hasRemoteContent && !allowRemote && (
        <RemoteContentBanner
          sender={name}
          onLoad={() => setLoadedOnce(true)}
          onAlwaysAllow={onAlwaysAllow}
        />
      )}

      <div className={styles.bodyWrap}>
        {loading || bodyHtml === null ? (
          <div className={styles.bodyLoading}>
            <Spinner label={t('ui.spinner.label')} />
          </div>
        ) : (
          <MailBodyFrame
            bodyHtml={bodyHtml}
            allowRemote={allowRemote}
            title={t('reading.frameTitle', { subject: email.subject || t('list.noSubject') })}
            onOpenLink={onOpenLink}
          />
        )}
      </div>

      {body !== undefined && (
        <AttachmentList accountId={accountId} attachments={body.attachments} />
      )}

      {moveOpen && (
        <MoveDialog
          open={moveOpen}
          currentMailboxId={inThisMailbox}
          onClose={() => setMoveOpen(false)}
          onMove={(target) => {
            actions.move([email.id], inThisMailbox, target)
            setMoveOpen(false)
          }}
        />
      )}

      {confirmDelete && (
        <Dialog
          open
          onClose={() => setConfirmDelete(false)}
          title={t('list.actions.delete')}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                {t('mailbox.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  actions.destroy([email.id])
                  setConfirmDelete(false)
                }}
              >
                {t('list.actions.delete')}
              </Button>
            </>
          }
        >
          <p>{t('reading.confirmDeleteBody')}</p>
        </Dialog>
      )}
    </article>
  )
}
