/**
 * Assembling everything a read receipt needs (M5.22).
 *
 * The reading pane knows the message; it does not know which identity to send as, which mailbox
 * this account calls Drafts, or how to talk to the server. This gathers those and hands back a
 * single `send` — or `null` when the receipt cannot be sent at all, so the banner is never offered
 * with a button that would fail.
 *
 * Returning `null` rather than a disabled button is deliberate. "The sender asked to be told" with
 * no way to answer is a worse thing to show than nothing: it tells the reader they are being
 * tracked and offers them no move.
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigOptional } from '../app/config-context'
import { useSessionOptional } from '../app/session/context'
import { type EmailBodyRow, type EmailRow, useIdentities, useMailboxes } from '../sync'
import { alreadySent, type MdnRequest, mdnRequest } from './mdn'
import { makeMdnClient } from './mdn-client'

export interface ReadReceiptOffer {
  readonly request: MdnRequest
  readonly alreadySent: boolean
  send(): Promise<void>
}

export function useReadReceipt(
  email: Pick<EmailRow, 'id' | 'subject' | 'from' | 'keywords'> | undefined,
  body: Pick<EmailBodyRow, 'mdnRequestTo'> | undefined,
): ReadReceiptOffer | null {
  const { t } = useTranslation()
  const connected = useSessionOptional()
  const identities = useIdentities()
  const mailboxes = useMailboxes()
  const config = useConfigOptional()

  const request = useMemo(
    () => mdnRequest(body?.mdnRequestTo, email?.from?.[0]?.email ?? null),
    [body?.mdnRequestTo, email?.from],
  )

  // The identity to answer as. The first is the account's own; a smarter choice would need the
  // message's To/Cc, which is more machinery than a receipt is worth.
  const identity = identities?.[0] ?? null
  const draftsId = mailboxes?.find((mailbox) => mailbox.role === 'drafts')?.id ?? null

  const client = useMemo(
    () =>
      connected === null || connected === undefined
        ? null
        : makeMdnClient(connected.client, connected.accountId),
    [connected],
  )

  const emailId = email?.id ?? null
  const subject = email?.subject ?? null
  const send = useCallback(async (): Promise<void> => {
    if (client === null || identity === null || draftsId === null || emailId === null) return
    if (request === null) return
    await client.send({
      emailId,
      notifyTo: request.notifyTo,
      identityId: identity.id,
      draftsMailboxId: draftsId,
      from: { name: identity.name ?? null, email: identity.email },
      // Not fetched today: the reading pane has no use for `messageId` otherwise, and the receipt
      // is still valid without it (RFC 8098 §3.1 makes Original-Message-ID optional). `mdn.ts`
      // omits the field rather than emitting an empty one.
      originalMessageId: null,
      originalSubject: subject,
      reportingUa: config?.branding.productName ?? 'Waxwing',
      humanReadable: t('reading.receipt.body'),
      subject: t('reading.receipt.subject', { subject: subject ?? '' }),
    })
  }, [client, identity, draftsId, emailId, request, subject, config, t])

  if (request === null) return null
  // Everything needed to answer must be present, or the offer is not made.
  if (client === null || identity === null || draftsId === null || emailId === null) return null

  return { request, alreadySent: alreadySent(email?.keywords), send }
}
