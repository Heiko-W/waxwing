/**
 * One fully-rendered message (M1.8): header (sender, recipients, date, an expandable details
 * disclosure — FR-RD-06), the remote-content banner (FR-RD-04), the sanitized body in the sandboxed
 * frame (FR-RD-01), attachments (FR-RD-05), and an action bar (archive/junk/trash/move/flag/mark
 * unread via the outbox; reply/reply-all/forward seed a composer draft — M2.3, FR-CMP-02). Bodies are
 * fetched on open and the message is auto-marked read after a short dwell unless disabled or already
 * read (FR-RD-07). Remote content is allowed when the deployment default is `allow`, the sender is on
 * the local allowlist, or the reader clicks "Load images".
 *
 * M3.9 rounds the details disclosure out to the full set a reader ever needs to judge a message —
 * Reply-To, Bcc, Sender, the sent/received divergence, the Message-ID and the authentication report
 * (reported, never judged: `auth-results.ts` explains why) — and adds the raw .eml behind the
 * overflow menu, lazily.
 */

import { renderPlainText, sanitize } from '@waxwing/mail-html'
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronUp,
  Forward,
  MailMinus,
  MailWarning,
  MoreHorizontal,
  Reply,
  ReplyAll,
  Star,
  Trash2,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { Avatar, Button, Dialog, IconButton, Menu, type MenuItemSpec, Spinner } from '../ui'
import { AttachmentList } from './AttachmentList'
import { topmostAuthResults } from './auth-results'
import { LabelMenu } from './labels/LabelMenu'
import { LabelMenuButton } from './labels/LabelMenuButton'
import { MailBodyFrame } from './MailBodyFrame'
import { MoveDialog } from './MoveDialog'
import {
  formatAddressList,
  nameLooksLikeAddress,
  sameAddresses,
  senderAddress,
  senderName,
} from './message-body'
import { RemoteContentBanner } from './RemoteContentBanner'
import styles from './reading.module.css'
import {
  READING_PREF_KEYS,
  useAutoMarkRead,
  useRemoteAllowList,
  useRemoteContentDefault,
} from './reading-prefs'
import { type ReadingHandlers, useReadingStore } from './reading-store'
import { useLinkOpener } from './use-link-opener'
import { useMessageActions } from './use-message-actions'
import { useTriage } from './use-triage'
import { useInlineImages } from './useInlineImages'
import { useMessageBody } from './useMessageBody'

/** How long an opened message must stay open before it is auto-marked read (FR-RD-07). */
export const AUTO_MARK_READ_DELAY_MS = 1500

/**
 * How far `sentAt` must sit from `receivedAt` before the details list shows BOTH. Every message
 * differs by a second or two, and a "Sent" row that always restates "Date" is pure noise; a genuine
 * gap (a queued/backdated/delayed message) is worth seeing.
 */
const SENT_AT_DIVERGENCE_MS = 5 * 60 * 1000

/** The raw-source dialog is a route nobody takes twice a day — code-split it (NFR-PERF-03). */
const MessageSourceDialog = lazy(() => import('./MessageSourceDialog'))
/** Likewise the link interstitial: most readers never meet a link that lies (M3.9, FR-RD-08). */
const LinkWarningDialog = lazy(() => import('./LinkWarningDialog'))

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
  // Moves go through the shared triage seam (M3.8): same dispatch, plus the undo toast — and it is the
  // very seam the `e` / `#` / `!` chords call, so a click and a keystroke cannot drift apart.
  const triage = useTriage()
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
  /** Which overflow action opened the raw-source dialog; `null` = closed (and never mounted). */
  const [sourceOpen, setSourceOpen] = useState<'view' | 'save' | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)
  // The `l` chord's picker, anchored to the action bar (the mouse path is the LabelMenuButton below).
  const [labelsOpen, setLabelsOpen] = useState(false)
  const actionBarRef = useRef<HTMLDivElement>(null)

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

  // Link clicks out of the body go through the host check first (FR-RD-08).
  const links = useLinkOpener()

  const name = senderName(email.from, t('list.noSender'))
  /**
   * The sender's real address, shown ALWAYS — dimmed, next to the name, never on hover. The spec
   * says "on hover/tap"; a phone has no hover, and phishing friction a phone user cannot get is not
   * friction. Suppressed only when it would be a literal duplicate of the name (a sender with no
   * display name, where `senderName` already returns the address).
   */
  const showFromAddress = fromAddress !== null && fromAddress !== name
  /** `From: "security@bank.test" <attacker@evil.tld>` — the one shape a dimmed address can't answer. */
  const nameIsAddressLike = nameLooksLikeAddress(email.from)
  const dateLabel = formatDate(new Date(email.receivedAt), {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  // ---- header details (M3.9, FR-RD-06). Each row earns its place or is not rendered. ----

  /** A Reply-To that merely repeats From is what most mail carries; only a DIFFERENT one is news. */
  const replyTo =
    email.replyTo !== null && email.replyTo.length > 0 && !sameAddresses(email.replyTo, email.from)
      ? email.replyTo
      : null
  const bcc = body?.bcc !== undefined && body.bcc !== null && body.bcc.length > 0 ? body.bcc : null
  /** RFC 5322 `Sender`: the mailbox that actually sent it, on behalf of `From`. */
  const sender =
    body?.sender !== undefined &&
    body.sender !== null &&
    body.sender.length > 0 &&
    !sameAddresses(body.sender, email.from)
      ? body.sender
      : null
  const messageId = email.messageId?.[0]
  const sentLabel = useMemo(() => {
    if (email.sentAt === null) return null
    const sent = new Date(email.sentAt).getTime()
    const received = new Date(email.receivedAt).getTime()
    if (Number.isNaN(sent) || Number.isNaN(received)) return null
    if (Math.abs(sent - received) <= SENT_AT_DIVERGENCE_MS) return null
    return formatDate(new Date(sent), { dateStyle: 'medium', timeStyle: 'short' })
  }, [email.sentAt, email.receivedAt])
  // Reported, never judged — no verdict, no colour, no tick. See `auth-results.ts` for the why.
  const authReport = useMemo(() => topmostAuthResults(body?.authResults), [body?.authResults])

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

  // Both overflow actions route through the SAME lazy dialog: it is the only place that holds the
  // downloaded bytes, and a visible loading/error surface beats a save that fails silently.
  const overflowItems = useMemo<MenuItemSpec[]>(
    () => [
      { id: 'viewSource', label: t('reading.source.view'), onSelect: () => setSourceOpen('view') },
      { id: 'saveEml', label: t('reading.source.save'), onSelect: () => setSourceOpen('save') },
    ],
    [t],
  )

  const onAlwaysAllow =
    fromAddress !== null
      ? () => {
          setLoadedOnce(true)
          void setPref(db, accountId, READING_PREF_KEYS.remoteAllow, [...remoteAllow, fromAddress])
        }
      : undefined

  const inTrash = trashBox !== undefined && inThisMailbox === trashBox.id
  /**
   * A move whose target is the mailbox being read IN is not a move: `useTriage` refuses it (the patch
   * would order the mail out of the only mailbox it is in), so an enabled Archive button while
   * reading a message in Archive clicked through to nothing at all — no dispatch, no toast, no undo.
   * Trash already had this, as the `inTrash` swap to "Delete"; Archive and Junk did not. The `e`/`!`
   * chords gate on the same comparison in `canMove`, so button and keystroke cannot drift apart.
   */
  const inArchive = archiveBox !== undefined && inThisMailbox === archiveBox.id
  const inJunk = junkBox !== undefined && inThisMailbox === junkBox.id

  // Publish the action-bar callbacks so the keyboard layer can invoke them (M3.8). The buttons below
  // use the SAME object, which is the point: `r` and the Reply icon are one code path. Reply/forward
  // in particular CANNOT be reconstructed from outside — they close over the sanitized body, the
  // account's own addresses and four localized strings.
  const handlers = useMemo<ReadingHandlers>(
    () => ({
      emailId: email.id,
      mailboxId: inThisMailbox,
      bodyReady: !loading,
      compose: onCompose,
      archive: () => triage.archive([email.id], inThisMailbox),
      junk: () => triage.junk([email.id], inThisMailbox),
      trash: () => triage.trash([email.id], inThisMailbox),
      toggleFlag: () => triage.setFlagged([email.id], email.keywords.$flagged !== true),
      markUnread: () => triage.setSeen([email.id], false),
      openMove: () => setMoveOpen(true),
      openLabels: () => setLabelsOpen(true),
      requestDelete: () => setConfirmDelete(true),
    }),
    [email.id, email.keywords.$flagged, inThisMailbox, loading, onCompose, triage],
  )

  // Only the message the reader actually OPENED registers — `autoMark` already means precisely that
  // (a thread's auto-expanded newest sibling gets `autoMark={false}`). The unmount clear is guarded by
  // id so a thread re-render can never null out another message's entry.
  const registerReading = useReadingStore((state) => state.set)
  const clearReading = useReadingStore((state) => state.clear)
  useEffect(() => {
    if (!autoMark) return
    registerReading(handlers)
    return () => clearReading(handlers.emailId)
  }, [autoMark, handlers, registerReading, clearReading])

  return (
    <article className={styles.message} aria-label={email.subject || t('list.noSubject')}>
      <header className={styles.header}>
        <Avatar name={name} size="md" />
        <div className={styles.headerMain}>
          <div className={styles.headerTop}>
            {/* Not inside the action bar or any other @media print-hidden chrome: the address is
                part of who the message is from, and it SHOULD appear on a printed copy. */}
            <span className={styles.fromLine}>
              <span className={styles.from}>{name}</span>
              {showFromAddress && <span className={styles.fromAddress}>{fromAddress}</span>}
              {nameIsAddressLike && (
                <span className={styles.nameWarning}>
                  <AlertTriangle className={styles.nameWarningIcon} aria-hidden="true" />
                  {t('reading.nameLooksLikeAddress')}
                </span>
              )}
            </span>
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
              {replyTo !== null && (
                <>
                  <dt>{t('reading.replyTo')}</dt>
                  <dd>{formatAddressList(replyTo, t('reading.noRecipients'))}</dd>
                </>
              )}
              <dt>{t('reading.to')}</dt>
              <dd>{formatAddressList(email.to, t('reading.noRecipients'))}</dd>
              {email.cc !== null && email.cc.length > 0 && (
                <>
                  <dt>{t('reading.cc')}</dt>
                  <dd>{formatAddressList(email.cc, t('reading.noRecipients'))}</dd>
                </>
              )}
              {bcc !== null && (
                <>
                  <dt>{t('reading.bcc')}</dt>
                  <dd>{formatAddressList(bcc, t('reading.noRecipients'))}</dd>
                </>
              )}
              {sender !== null && (
                <>
                  <dt>{t('reading.sender')}</dt>
                  <dd>
                    {t('reading.senderOnBehalfOf', {
                      sender: formatAddressList(sender, t('list.noSender')),
                      from: formatAddressList(email.from, t('list.noSender')),
                    })}
                  </dd>
                </>
              )}
              <dt>{t('reading.date')}</dt>
              <dd>{dateLabel}</dd>
              {sentLabel !== null && (
                <>
                  <dt>{t('reading.sentAt')}</dt>
                  <dd>{sentLabel}</dd>
                </>
              )}
              {messageId !== undefined && (
                <>
                  <dt>{t('reading.messageId')}</dt>
                  <dd>{messageId}</dd>
                </>
              )}
              {authReport !== null && (
                <>
                  <dt>{t('reading.authResults.label')}</dt>
                  <dd>
                    {t('reading.authResults.reportedBy', { host: authReport.authservId })}{' '}
                    {authReport.results
                      .map((result) => `${result.method}=${result.result}`)
                      .join(' · ')}
                    <span className={styles.authNote}>{t('reading.authResults.unverified')}</span>
                  </dd>
                </>
              )}
            </dl>
          )}
        </div>
      </header>

      <div
        className={styles.actionBar}
        role="toolbar"
        aria-label={t('reading.actions')}
        ref={actionBarRef}
      >
        <IconButton
          label={t('list.actions.archive')}
          variant="ghost"
          disabled={archiveBox === undefined || inArchive}
          onClick={handlers.archive}
        >
          <Archive />
        </IconButton>
        <IconButton
          label={t('list.actions.junk')}
          variant="ghost"
          disabled={junkBox === undefined || inJunk}
          onClick={handlers.junk}
        >
          <MailWarning />
        </IconButton>
        <IconButton
          label={inTrash ? t('list.actions.delete') : t('list.actions.trash')}
          variant="ghost"
          disabled={!inTrash && trashBox === undefined}
          onClick={() => (inTrash ? handlers.requestDelete() : handlers.trash())}
        >
          <Trash2 />
        </IconButton>
        <IconButton
          label={
            email.keywords.$flagged === true ? t('list.actions.unflag') : t('list.actions.flag')
          }
          variant="ghost"
          onClick={handlers.toggleFlag}
        >
          <Star className={email.keywords.$flagged === true ? styles.flagOn : undefined} />
        </IconButton>
        <IconButton label={t('reading.markUnread')} variant="ghost" onClick={handlers.markUnread}>
          <MailMinus />
        </IconButton>
        <LabelMenuButton ids={[email.id]} />
        {/* Without a source mailbox `move` keeps the other memberships — that is a COPY, not the
            move this button promises. The `v` chord gates on the same value (the shortcut context
            reads this very `mailboxId` back off the registered handlers), so the two cannot drift. */}
        <Button
          size="sm"
          variant="ghost"
          disabled={inThisMailbox === null}
          onClick={handlers.openMove}
        >
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
        {/* Wrapped rather than given `className` directly — the same shape FolderTreeView uses, and
            the span is what the `@media print` rule hides. */}
        <span className={styles.overflowMenu}>
          <Menu
            triggerLabel={t('reading.more')}
            trigger={<MoreHorizontal aria-hidden="true" />}
            align="end"
            items={overflowItems}
          />
        </span>
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
            onOpenLink={links.onOpenLink}
          />
        )}
      </div>

      {links.pending !== null && (
        <Suspense fallback={null}>
          <LinkWarningDialog
            claimedHost={links.pending.claimedHost}
            targetHost={links.pending.targetHost}
            onConfirm={links.confirm}
            onCancel={links.cancel}
          />
        </Suspense>
      )}

      {body !== undefined && (
        <AttachmentList accountId={accountId} attachments={body.attachments} />
      )}

      {moveOpen && (
        <MoveDialog
          open={moveOpen}
          currentMailboxId={inThisMailbox}
          onClose={() => setMoveOpen(false)}
          onMove={(target, label) => {
            triage.moveTo([email.id], inThisMailbox, target, label)
            setMoveOpen(false)
          }}
        />
      )}

      {labelsOpen && (
        <LabelMenu ids={[email.id]} anchorRef={actionBarRef} onClose={() => setLabelsOpen(false)} />
      )}

      {sourceOpen !== null && (
        <Suspense fallback={null}>
          <MessageSourceDialog
            open
            accountId={accountId}
            email={email}
            autoSave={sourceOpen === 'save'}
            onClose={() => setSourceOpen(null)}
          />
        </Suspense>
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
