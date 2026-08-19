/**
 * Sending one read receipt (M5.22, RFC 8098).
 *
 * Not through the outbox, deliberately. That machinery exists for drafts — Sent refiling, `$draft`
 * clearing, the undo window, conflict adoption — and a receipt is none of those. It is a single
 * small message the reader has just explicitly asked for, so it goes straight out, the way
 * `scheduled-client.ts` and `sieve-client.ts` already handle their own small operations.
 *
 * The receipt leaves no copy behind. It is machinery, not correspondence — the reader did not write
 * it — so it is created in Drafts, submitted, and destroyed by `onSuccessDestroyEmail` in the same
 * request. What IS recorded is `$mdnsent` on the original (RFC 3503), server-side, so every device
 * agrees this was answered and nobody is asked twice.
 *
 * **It has to be created somewhere**, which is a measurement rather than a design choice: Stalwart
 * refuses an `Email/set` with no `mailboxIds`, and with an empty one, both with "Message has to
 * belong to at least one mailbox". A draft that exists for the length of one round trip is the
 * price of that rule. The whole flow was verified end to end against the fixture (2026-08-19):
 * created, submitted, destroyed, nothing left in the sender's account, and the receipt delivered.
 */

import type { EmailAddress, Id, JmapClient } from '@waxwing/jmap'
import { creationRef, Methods } from '@waxwing/jmap'
import { buildMdnEmail, MDN_SENT_KEYWORD } from './mdn'

export interface SendReceiptInput {
  /** The message being acknowledged. */
  readonly emailId: Id
  readonly notifyTo: string
  readonly identityId: Id
  /** Where the receipt lives for the length of one request. See the module note. */
  readonly draftsMailboxId: Id
  /** The reader's own address, for `Final-Recipient` and the envelope. */
  readonly from: EmailAddress
  readonly originalMessageId: string | null
  readonly originalSubject: string | null
  readonly reportingUa: string
  /** Localized by the caller. */
  readonly humanReadable: string
  readonly subject: string
}

export interface MdnClient {
  /** Sends the receipt and marks the original `$mdnsent`. Throws if the server refuses. */
  send(input: SendReceiptInput): Promise<void>
}

export function makeMdnClient(client: JmapClient, accountId: Id): MdnClient {
  return {
    async send(input) {
      const email = buildMdnEmail({
        notifyTo: input.notifyTo,
        finalRecipient: input.from.email,
        originalMessageId: input.originalMessageId,
        originalSubject: input.originalSubject,
        reportingUa: input.reportingUa,
        humanReadable: input.humanReadable,
        subject: input.subject,
      })

      const builder = client.request()
      const created = builder.invoke(Methods.emailSet, {
        accountId,
        create: {
          mdn: {
            ...email,
            from: [input.from],
            // Measured: the server refuses an email in no mailbox. This one is destroyed again in
            // the same request, so it is never a draft the reader can encounter.
            mailboxIds: { [input.draftsMailboxId]: true },
            keywords: { $seen: true },
          },
        },
      })
      const submitted = builder.invoke(Methods.emailSubmissionSet, {
        accountId,
        create: {
          send: {
            emailId: creationRef('mdn'),
            identityId: input.identityId,
            envelope: {
              mailFrom: { email: input.from.email },
              rcptTo: [{ email: input.notifyTo }],
            },
          },
        },
        // Once it is out, the local copy has done its job.
        // Refers to the SUBMISSION's creation id — the server resolves it to the email it sent.
        onSuccessDestroyEmail: [creationRef('send')],
      })
      // Recording this server-side is what stops a second device asking the reader again.
      const marked = builder.invoke(Methods.emailSet, {
        accountId,
        update: { [input.emailId]: { [`keywords/${MDN_SENT_KEYWORD}`]: true } },
      })

      const responses = await builder.send()
      const submission = responses.get(submitted)
      const refusal = Object.values(submission.notCreated ?? {})[0]
      if (refusal !== undefined) {
        throw new Error(refusal.description ?? refusal.type)
      }
      // A create failure on the Email itself surfaces the same way — the submission would have
      // failed too, but the message is clearer from here.
      const emailRefusal = Object.values(responses.get(created).notCreated ?? {})[0]
      if (emailRefusal !== undefined) {
        throw new Error(emailRefusal.description ?? emailRefusal.type)
      }
      // The keyword failing is NOT fatal: the receipt went out, which is what the reader asked
      // for. The cost is being asked again on another device, which is better than claiming the
      // send failed when it did not.
      void responses.get(marked)
    },
  }
}
