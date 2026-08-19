/**
 * Read receipts — MDN (M5.22, RFC 8098).
 *
 * A sender can ask to be told when their message is displayed. Waxwing answers only when the
 * reader presses a button, never on open. That is not a preference: NFR-PRIV-01 says the app makes
 * no network request the reader did not ask for, and a read receipt is precisely a request the
 * SENDER made on the reader's behalf. Opening a message is not consent to tell anyone.
 *
 * **The address that gets told is not necessarily the sender.** `Disposition-Notification-To` is a
 * separate header and may name anyone at all — which is the whole trick behind using receipts to
 * confirm a live mailbox. {@link mdnRequest} therefore reports the address that would actually be
 * written to, and whether it matches `From`, so the button can say who is about to be told rather
 * than implying it is the person whose name is on the message.
 *
 * **The wire shape is measured, not guessed** (Stalwart 0.16, 2026-08-19). RFC 8098 requires
 * `Content-Type: multipart/report; report-type=disposition-notification`, and JMAP has no field for
 * a content-type parameter. Three encodings were tried against the live server:
 *   - `header:Content-Type:asText` alone → refused, "Expected a partId or blobId field".
 *   - a `headers: [...]` array → refused, "Headers have to be set individually".
 *   - `type` AND `header:Content-Type:asText` together → correct, parameter and all.
 * The third is what {@link buildMdnEmail} emits.
 */

import type { EmailBodyPartCreate } from '@waxwing/jmap'

/** The IMAP keyword RFC 3503 §3.2 reserves for "an MDN has been sent for this message". */
export const MDN_SENT_KEYWORD = '$mdnsent'

/** What a message asks for, and of whom. */
export interface MdnRequest {
  /** Where the receipt would be sent. */
  readonly notifyTo: string
  /**
   * Whether that address is also the message's `From`.
   *
   * False is not an error and not a refusal — it is a fact the reader should see before deciding,
   * because a receipt addressed away from the sender is the shape used to confirm that a mailbox
   * is live.
   */
  readonly matchesFrom: boolean
}

function normaliseAddress(raw: string): string {
  const trimmed = raw.trim()
  // `Name <local@host>` → `local@host`. The bare form is left alone.
  const angled = /<([^<>]+)>\s*$/.exec(trimmed)
  return (angled?.[1] ?? trimmed).trim().toLowerCase()
}

/**
 * What this message asks for, or `null` if it asks for nothing.
 *
 * Only the FIRST address is honoured when the header lists several. RFC 8098 §2.1 allows a list,
 * but sending to several parties multiplies the disclosure from one act of consent, and a reader
 * pressing one button has agreed to tell one party.
 */
export function mdnRequest(
  notificationHeader: string | null | undefined,
  from: string | null | undefined,
): MdnRequest | null {
  const raw = (notificationHeader ?? '').trim()
  if (raw === '') return null
  const first = raw.split(',')[0] ?? ''
  const notifyTo = normaliseAddress(first)
  // A header that is present but holds nothing addressable is not a request.
  if (notifyTo === '' || !notifyTo.includes('@')) return null
  return { notifyTo, matchesFrom: notifyTo === normaliseAddress(from ?? '') }
}

/** Whether a receipt has already been sent for this message. */
export function alreadySent(
  keywords: Readonly<Record<string, boolean>> | null | undefined,
): boolean {
  return keywords?.[MDN_SENT_KEYWORD] === true
}

/**
 * The `message/disposition-notification` part's fields (RFC 8098 §3.1).
 *
 * `manual-action/MDN-sent-manually` is the honest action-mode here and the reason this feature is
 * defensible at all: it states that a human decided, not that software noticed. Reporting
 * `automatic-action` would be a lie about how the receipt came to exist.
 */
export function buildDispositionNotification(options: {
  readonly reportingUa: string
  readonly finalRecipient: string
  readonly originalMessageId: string | null
}): string {
  const lines = [
    `Reporting-UA: ${sanitizeHeaderValue(options.reportingUa)}`,
    `Final-Recipient: rfc822;${sanitizeHeaderValue(options.finalRecipient)}`,
  ]
  if (options.originalMessageId !== null && options.originalMessageId.trim() !== '') {
    lines.push(`Original-Message-ID: ${sanitizeHeaderValue(options.originalMessageId)}`)
  }
  lines.push('Disposition: manual-action/MDN-sent-manually;displayed')
  // CRLF: this is a header block inside a MIME part, not prose.
  return `${lines.join('\r\n')}\r\n`
}

/**
 * A header value with anything that could end the field removed.
 *
 * The inputs here are the sender's: `Message-ID` and the notification address come off a message a
 * stranger wrote. A CR or LF in either would close the field and start a new one — header
 * injection into a message this app then sends on the reader's behalf.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** Everything needed to compose the receipt. */
export interface MdnInput {
  readonly notifyTo: string
  /** The reader's own address — what `Final-Recipient` states. */
  readonly finalRecipient: string
  readonly originalMessageId: string | null
  readonly originalSubject: string | null
  /** Product name (FR-THEME-02), for `Reporting-UA`. */
  readonly reportingUa: string
  /** Already localized by the caller: this is prose a person reads. */
  readonly humanReadable: string
  readonly subject: string
}

/**
 * The `Email/set` create object for the receipt.
 *
 * Mutable arrays, not `readonly` ones: `EmailCreate` in `@waxwing/jmap` mirrors the wire shape,
 * which is mutable, and a `readonly` field here would not assign to it. The builder returns a fresh
 * object every call, so there is nothing to protect.
 */
export interface MdnEmail {
  /** `name: null` is required by `EmailAddress`, and an MDN addresses a mailbox, not a person. */
  to: { name: string | null; email: string }[]
  subject: string
  inReplyTo: string[] | null
  bodyValues: Record<string, { value: string }>
  bodyStructure: EmailBodyPartCreate
}

/**
 * The receipt, as JMAP `Email/set` create properties.
 *
 * `from`, `mailboxIds` and `keywords` are the caller's: they depend on the identity chosen and on
 * which mailbox this account calls Sent, neither of which belongs in a pure builder.
 */
export function buildMdnEmail(input: MdnInput): MdnEmail {
  const notification = buildDispositionNotification({
    reportingUa: input.reportingUa,
    finalRecipient: input.finalRecipient,
    originalMessageId: input.originalMessageId,
  })
  return {
    to: [{ name: null, email: input.notifyTo }],
    subject: input.subject,
    // Threads the receipt onto the message it answers, where the sender's client can find it.
    inReplyTo:
      input.originalMessageId === null || input.originalMessageId.trim() === ''
        ? null
        : [input.originalMessageId],
    bodyValues: {
      human: { value: input.humanReadable },
      mdn: { value: notification },
    },
    bodyStructure: {
      // BOTH, and in this order — see the module note. `type` alone drops the RFC 8098 parameter;
      // the header alone is refused outright.
      type: 'multipart/report',
      'header:Content-Type:asText': 'multipart/report; report-type=disposition-notification',
      subParts: [
        { partId: 'human', type: 'text/plain' },
        { partId: 'mdn', type: 'message/disposition-notification' },
      ],
    },
  }
}
