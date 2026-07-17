/**
 * A parsed `message/rfc822` attachment, rendered inline (M3.9, FR-RD-07).
 *
 * The body flows through the SAME pipeline the outer message uses — the pure {@link pickHtmlBody} /
 * {@link pickTextBody} transforms, {@link sanitize}, and {@link MailBodyFrame} — never a parallel
 * renderer. Two things differ from the outer message, both on purpose:
 *
 *  - `allowRemote` is HARD false and `resolveCid` is omitted, so the inner message's remote content
 *    AND its inline `cid:` images stay blocked. The inner sender is not the outer sender: a shared
 *    remote-content allowlist would let an outer phish smuggle tracking pixels through an attached
 *    inner message.
 *  - It renders header + body only, and surfaces NO further open affordance, so an inner
 *    message/rfc822 cannot itself be opened — nesting is bounded to one level, structurally.
 */

import type { Id } from '@waxwing/jmap'
import { renderPlainText, sanitize } from '@waxwing/mail-html'
import { lazy, Suspense, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '../i18n/formatters'
import { Spinner } from '../ui'
import { MailBodyFrame } from './MailBodyFrame'
import { formatAddressList, pickHtmlBody, pickTextBody } from './message-body'
import styles from './reading.module.css'
import { useLinkOpener } from './use-link-opener'
import { useParsedMessage } from './use-parsed-message'

const LinkWarningDialog = lazy(() => import('./LinkWarningDialog'))

export interface NestedMessageViewProps {
  readonly accountId: Id
  readonly blobId: Id
}

export function NestedMessageView({ accountId, blobId }: NestedMessageViewProps) {
  const { t } = useTranslation()
  const { message, loading, error } = useParsedMessage(accountId, blobId)
  const links = useLinkOpener()

  const htmlParts = message !== null ? pickHtmlBody(message) : null
  const isHtml = htmlParts !== null
  const joinedHtml = htmlParts !== null ? htmlParts.map((part) => part.value).join('') : ''
  // allowRemote:false and no resolveCid — the inner sender is untrusted independently of the outer.
  const sanitized = useMemo(
    () => (isHtml ? sanitize(joinedHtml, { allowRemote: false }) : null),
    [isHtml, joinedHtml],
  )
  const textBody = message !== null ? pickTextBody(message) : ''
  const bodyHtml = isHtml
    ? (sanitized?.html ?? '')
    : renderPlainText(textBody, { quotedLabel: t('reading.quotedLabel') })

  // The error string shows ONLY on a real error. `message === null` with no error is the pre-fetch
  // transition frame (the hook's effect is passive, so it fires after the first paint) — that is a
  // spinner, not a failure. Showing the error there flashed "couldn't be opened" on every open.
  if (error !== null) {
    return <p className={styles.nestedError}>{t(`reading.nested.error.${error}`)}</p>
  }
  if (loading || message === null) {
    return (
      <div className={styles.nestedLoading}>
        <Spinner label={t('ui.spinner.label')} />
      </div>
    )
  }

  const subject = message.subject || t('list.noSubject')
  const from = formatAddressList(message.from, t('list.noSender'))
  const date =
    message.sentAt !== null
      ? formatDate(new Date(message.sentAt), { dateStyle: 'medium', timeStyle: 'short' })
      : null
  // The body value is capped (maxBodyValueBytes); say so rather than show a silently clipped message
  // — the same honesty the .eml source view applies. The whole message is in the downloadable blob.
  const truncated = Object.values(message.bodyValues).some((value) => value.isTruncated)

  return (
    <div className={styles.nested}>
      <dl className={styles.nestedHeader}>
        <div className={styles.nestedRow}>
          <dt>{t('reading.from')}</dt>
          <dd>{from}</dd>
        </div>
        <div className={styles.nestedRow}>
          <dt>{t('reading.nested.subjectLabel')}</dt>
          <dd>{subject}</dd>
        </div>
        {date !== null && (
          <div className={styles.nestedRow}>
            <dt>{t('reading.sentAt')}</dt>
            <dd>{date}</dd>
          </div>
        )}
      </dl>
      {truncated && <p className={styles.nestedError}>{t('reading.nested.truncated')}</p>}
      <MailBodyFrame
        bodyHtml={bodyHtml}
        allowRemote={false}
        title={t('reading.nested.frameTitle', { subject })}
        onOpenLink={links.onOpenLink}
      />
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
    </div>
  )
}
