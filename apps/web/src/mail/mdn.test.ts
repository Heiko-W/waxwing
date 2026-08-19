/**
 * Read receipts (M5.22, RFC 8098).
 *
 * Two assertions carry the weight. The disposition must say `manual-action/MDN-sent-manually` —
 * anything else claims software decided, which would be a lie about how this receipt came to
 * exist and the reason the feature is defensible at all. And header values taken off the
 * sender's message must not be able to close their field: `Message-ID` and the notification
 * address are a stranger's strings, and this app is about to put them in a message it sends.
 */

import { describe, expect, it } from 'vitest'
import {
  alreadySent,
  buildDispositionNotification,
  buildMdnEmail,
  MDN_SENT_KEYWORD,
  mdnRequest,
} from './mdn'

describe('recognising the request', () => {
  it('reads a bare address', () => {
    expect(mdnRequest('sender@example.com', 'sender@example.com')).toEqual({
      notifyTo: 'sender@example.com',
      matchesFrom: true,
    })
  })

  it('reads a display-name form', () => {
    expect(mdnRequest('Alice <alice@example.com>', 'alice@example.com')?.notifyTo).toBe(
      'alice@example.com',
    )
  })

  it('reports when the receipt would go somewhere OTHER than the sender', () => {
    // The shape used to confirm a live mailbox. Not refused — surfaced, so the button can say who
    // is actually about to be told.
    const request = mdnRequest('tracker@harvest.example', 'friend@example.com')
    expect(request?.notifyTo).toBe('tracker@harvest.example')
    expect(request?.matchesFrom).toBe(false)
  })

  it('compares addresses case-insensitively', () => {
    expect(mdnRequest('Sender@Example.COM', 'sender@example.com')?.matchesFrom).toBe(true)
  })

  it('honours only the first of several addresses', () => {
    // One button press is consent to tell one party. A list would multiply the disclosure from a
    // single act of consent.
    const request = mdnRequest('one@example.com, two@example.com', 'one@example.com')
    expect(request?.notifyTo).toBe('one@example.com')
  })

  it('is not a request when the header is absent, empty or unaddressable', () => {
    expect(mdnRequest(null, 'a@b.test')).toBeNull()
    expect(mdnRequest(undefined, 'a@b.test')).toBeNull()
    expect(mdnRequest('   ', 'a@b.test')).toBeNull()
    expect(mdnRequest('not-an-address', 'a@b.test')).toBeNull()
    expect(mdnRequest('<>', 'a@b.test')).toBeNull()
  })
})

describe('whether it has already been answered', () => {
  it('reads the RFC 3503 keyword', () => {
    expect(alreadySent({ [MDN_SENT_KEYWORD]: true })).toBe(true)
    expect(alreadySent({ $seen: true })).toBe(false)
    expect(alreadySent({})).toBe(false)
    expect(alreadySent(null)).toBe(false)
  })

  it('uses the keyword the standard reserves, so other clients agree', () => {
    expect(MDN_SENT_KEYWORD).toBe('$mdnsent')
  })
})

describe('the notification part', () => {
  const notification = buildDispositionNotification({
    reportingUa: 'Waxwing',
    finalRecipient: 'reader@example.com',
    originalMessageId: '<abc@example.com>',
  })

  it('states that a HUMAN decided', () => {
    // `automatic-action` would claim the software sent it. That is the difference between this
    // feature and the one NFR-PRIV-01 forbids.
    expect(notification).toContain('Disposition: manual-action/MDN-sent-manually;displayed')
    expect(notification).not.toContain('automatic-action')
  })

  it('carries the required fields', () => {
    expect(notification).toContain('Final-Recipient: rfc822;reader@example.com')
    expect(notification).toContain('Original-Message-ID: <abc@example.com>')
    expect(notification).toContain('Reporting-UA: Waxwing')
  })

  it('uses CRLF, because this is a header block and not prose', () => {
    expect(notification).toContain('\r\n')
    expect(notification.endsWith('\r\n')).toBe(true)
  })

  it('omits Original-Message-ID rather than emitting an empty one', () => {
    const without = buildDispositionNotification({
      reportingUa: 'Waxwing',
      finalRecipient: 'reader@example.com',
      originalMessageId: null,
    })
    expect(without).not.toContain('Original-Message-ID')
    expect(without).toContain('Disposition:')
  })
})

describe('a stranger cannot inject a header', () => {
  it('strips CR and LF out of the message id', () => {
    // The attack: a Message-ID ending the field and starting `Bcc:`. The value came off a message
    // someone else wrote, and this app is about to send it.
    const notification = buildDispositionNotification({
      reportingUa: 'Waxwing',
      finalRecipient: 'reader@example.com',
      originalMessageId: '<x@y>\r\nBcc: victim@example.com',
    })
    expect(notification).not.toMatch(/\r\nBcc:/)
    expect(notification.split('\r\n').filter((line) => line !== '')).toHaveLength(4)
  })

  it('strips them out of the recipient and the product name too', () => {
    const notification = buildDispositionNotification({
      reportingUa: 'Evil\nX-Injected: 1',
      finalRecipient: 'reader@example.com\nX-Also: 1',
      originalMessageId: null,
    })
    // The injected text survives as TEXT, folded into the value it was smuggled into — what must
    // not survive is its ability to start a field of its own.
    const lines = notification.split('\r\n').filter((line) => line !== '')
    expect(lines).toHaveLength(3)
    expect(lines.some((line) => line.startsWith('X-Injected:'))).toBe(false)
    expect(lines.some((line) => line.startsWith('X-Also:'))).toBe(false)
  })
})

describe('the message that gets sent', () => {
  const email = buildMdnEmail({
    notifyTo: 'sender@example.com',
    finalRecipient: 'reader@example.com',
    originalMessageId: '<abc@example.com>',
    originalSubject: 'Quarterly report',
    reportingUa: 'Waxwing',
    humanReadable: 'Your message was displayed.',
    subject: 'Read receipt: Quarterly report',
  })

  it('goes to the notification address', () => {
    expect(email.to).toEqual([{ name: null, email: 'sender@example.com' }])
  })

  it('is a multipart/report carrying the RFC 8098 parameter', () => {
    // Measured against Stalwart: `type` alone drops the parameter, and a `headers` array is
    // refused. Both keys together are the only encoding that produces a correct Content-Type.
    expect(email.bodyStructure.type).toBe('multipart/report')
    expect(email.bodyStructure['header:Content-Type:asText']).toBe(
      'multipart/report; report-type=disposition-notification',
    )
  })

  it('has exactly the two parts the RFC defines, in order', () => {
    const parts = email.bodyStructure.subParts as { partId: string; type: string }[]
    expect(parts.map((part) => part.type)).toEqual([
      'text/plain',
      'message/disposition-notification',
    ])
    expect(Object.keys(email.bodyValues).sort()).toEqual(['human', 'mdn'])
  })

  it('threads onto the message it answers', () => {
    expect(email.inReplyTo).toEqual(['<abc@example.com>'])
  })

  it('omits inReplyTo when there is no message id to reference', () => {
    const orphan = buildMdnEmail({
      notifyTo: 'sender@example.com',
      finalRecipient: 'reader@example.com',
      originalMessageId: null,
      originalSubject: null,
      reportingUa: 'Waxwing',
      humanReadable: 'Your message was displayed.',
      subject: 'Read receipt',
    })
    expect(orphan.inReplyTo).toBeNull()
  })
})
