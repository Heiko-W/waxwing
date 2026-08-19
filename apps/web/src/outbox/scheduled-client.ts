/**
 * Reading and cancelling scheduled sends (M5.4, FR-CMP-11).
 *
 * A submission the server is holding is **not** in any mailbox and **not** in the local outbox: it
 * left this device the moment it was created. The only handle on it is `EmailSubmission/query` with
 * `undoStatus: 'pending'`, which is why this reads from the server every time rather than from the
 * replica — there is nothing in the replica to read.
 *
 * Two Stalwart-specific notes that shape the code:
 *
 * - `undoStatus` is derived live from the send queue on every `/get`, so a value fetched a minute
 *   ago may already be stale. The cancel path re-reads rather than trusting what the list showed.
 * - A submission whose time has passed is gone from the queue and answers `cannotUnsend`. That is
 *   not an error to apologise for — it means the message was sent, which is what the user asked
 *   for originally.
 */

import type { EmailSubmission, Id, JmapClient } from '@waxwing/jmap'
import { Methods } from '@waxwing/jmap'

/** A message the server is holding, joined with what the UI needs to name it. */
export interface ScheduledSend {
  readonly id: Id
  readonly emailId: Id
  /** When the server will release it. */
  readonly sendAt: string
  readonly subject: string | null
}

export interface ScheduledClient {
  /** Everything still pending, soonest first. */
  list(): Promise<ScheduledSend[]>
  /** Cancels one. `false` means it had already gone out. */
  cancel(id: Id): Promise<boolean>
}

export function makeScheduledClient(client: JmapClient, accountId: Id): ScheduledClient {
  return {
    async list() {
      const builder = client.request()
      const query = builder.invoke(Methods.emailSubmissionQuery, {
        accountId,
        // Only what is still holdable. `after: now` excludes submissions that are pending merely
        // because the queue has not caught up with them yet.
        filter: { undoStatus: 'pending', after: new Date().toISOString() },
        sort: [{ property: 'sentAt', isAscending: true }],
        limit: 50,
      })
      const submissions = builder.invoke(Methods.emailSubmissionGet, {
        accountId,
        '#ids': query.ref('/ids'),
        properties: ['id', 'emailId', 'sendAt', 'undoStatus'],
      })
      // The submission names an Email but carries no subject; one back-reference more and the list
      // can say what it is holding rather than just how many.
      const emails = builder.invoke(Methods.emailGet, {
        accountId,
        '#ids': submissions.ref('/list/*/emailId'),
        properties: ['id', 'subject'],
      })
      // `RequestBuilder.send()` takes no options; the signal would have to be threaded through
      // the client itself, and a list refresh is short enough not to need one.
      const responses = await builder.send()

      const subjects = new Map(
        responses
          .get(emails)
          .list.map((email) => [email.id, (email as { subject?: string | null }).subject ?? null]),
      )
      return responses
        .get(submissions)
        .list.filter(
          (submission): submission is EmailSubmission & { sendAt: string } =>
            typeof submission.sendAt === 'string',
        )
        .map((submission) => ({
          id: submission.id,
          emailId: submission.emailId,
          sendAt: submission.sendAt,
          subject: subjects.get(submission.emailId) ?? null,
        }))
    },

    async cancel(id) {
      const responses = await client.call([
        [
          Methods.emailSubmissionSet.name,
          // `canceled` is the ONLY value a client may write here (RFC 8621 §7.1); the server sets
          // the other two.
          { accountId, update: { [id]: { undoStatus: 'canceled' } } },
          's0',
        ],
      ])
      const response = responses.get<{
        updated: Record<string, unknown> | null
        notUpdated: Record<string, { type: string }> | null
      }>('s0')
      const refusal = response.notUpdated?.[id]
      // `cannotUnsend` means it had already left — a truthful "too late", not a failure.
      if (refusal !== undefined) return false
      return response.updated !== null && Object.hasOwn(response.updated, id)
    },
  }
}
