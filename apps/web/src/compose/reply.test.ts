import type { EmailAddress, EmailBodyPart } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import {
  deriveRecipients,
  forwardAttachments,
  forwardBody,
  inferFromIdentity,
  ownAddresses,
  quoteBody,
  type ReplyKind,
  type ReplySource,
  replySubject,
  stripSubjectPrefix,
  threadingHeaders,
} from './reply'

const addr = (email: string, name: string | null = null): EmailAddress => ({ name, email })

function source(over: Partial<ReplySource> = {}): ReplySource {
  return {
    from: null,
    to: null,
    cc: null,
    replyTo: null,
    subject: null,
    messageId: null,
    inReplyTo: null,
    references: null,
    ...over,
  }
}

describe('subject prefix', () => {
  it.each([
    ['Hello', 'reply', 'Re: Hello'],
    ['Re: Hello', 'reply', 'Re: Hello'],
    ['Re: Re: Hello', 'reply', 'Re: Hello'],
    ['RE:hello', 'reply', 'Re: hello'],
    ['Re[2]: x', 'reply', 'Re: x'],
    ['AW: Hallo', 'reply', 'Re: Hallo'],
    ['Fwd: Hello', 'reply', 'Re: Hello'],
    ['Hello', 'forward', 'Fwd: Hello'],
    ['Fwd: Hello', 'forward', 'Fwd: Hello'],
    ['WG: Hallo', 'forward', 'Fwd: Hallo'],
    ['Re: WG: x', 'forward', 'Fwd: x'],
  ] as const)('replySubject(%j, %s) → %j', (subject, kind, expected) => {
    expect(replySubject(subject, kind as ReplyKind)).toBe(expected)
  })

  it('handles empty/null subjects', () => {
    expect(replySubject('', 'reply')).toBe('Re:')
    expect(replySubject(null, 'reply')).toBe('Re:')
    expect(replySubject(null, 'forward')).toBe('Fwd:')
  })

  it('strips a bare prefix to nothing', () => {
    expect(stripSubjectPrefix('Re: Fwd: ')).toBe('')
  })
})

describe('deriveRecipients', () => {
  const A = addr('a@x.test', 'A')
  const Me = addr('me@x.test', 'Me')
  const B = addr('b@x.test', 'B')
  const C = addr('c@x.test', 'C')
  const R = addr('r@x.test', 'R')
  const own = ['me@x.test']
  const src = source({ from: [A], to: [Me, B], cc: [C] })

  it('reply → sender only', () => {
    expect(deriveRecipients(src, 'reply', own)).toEqual({ to: [A], cc: [] })
  })
  it('reply-all → sender in To, others in Cc, self dropped', () => {
    expect(deriveRecipients(src, 'replyAll', own)).toEqual({ to: [A], cc: [B, C] })
  })
  it('reply-all honours Reply-To and does not re-add it to Cc', () => {
    const withReplyTo = source({ ...src, replyTo: [R] })
    expect(deriveRecipients(withReplyTo, 'replyAll', own)).toEqual({ to: [R], cc: [B, C] })
  })
  it('reply honours Reply-To over From', () => {
    expect(deriveRecipients(source({ from: [A], replyTo: [R] }), 'reply', own)).toEqual({
      to: [R],
      cc: [],
    })
  })
  it('forward → empty', () => {
    expect(deriveRecipients(src, 'forward', own)).toEqual({ to: [], cc: [] })
  })
})

describe('threadingHeaders', () => {
  it('builds In-Reply-To + References from the source', () => {
    const src = source({ messageId: ['<m3>'], references: ['<m1>', '<m2>'] })
    expect(threadingHeaders(src)).toEqual({
      inReplyTo: ['<m3>'],
      references: ['<m1>', '<m2>', '<m3>'],
    })
  })
  it('falls back to inReplyTo when references is absent', () => {
    expect(threadingHeaders(source({ messageId: ['<m2>'], inReplyTo: ['<m1>'] }))).toEqual({
      inReplyTo: ['<m2>'],
      references: ['<m1>', '<m2>'],
    })
  })
  it('returns null when there are no headers', () => {
    expect(threadingHeaders(source())).toEqual({ inReplyTo: null, references: null })
  })
})

describe('body seeds', () => {
  it('quoteBody wraps the source in a blockquote with an attribution', () => {
    const html = quoteBody({ bodyHtml: '<p>hi</p>', textBody: '', attribution: 'On X, A wrote:' })
    expect(html).toContain('On X, A wrote:')
    expect(html).toContain('<blockquote><p>hi</p></blockquote>')
  })
  it('quoteBody falls back to the text body when there is no HTML', () => {
    const html = quoteBody({ bodyHtml: null, textBody: 'plain line', attribution: 'a' })
    expect(html).toContain('plain line')
    expect(html).toContain('<blockquote>')
  })
  it('quoteBody escapes the attribution', () => {
    const html = quoteBody({ bodyHtml: '', textBody: '', attribution: 'A <b> & c' })
    expect(html).toContain('A &lt;b&gt; &amp; c')
  })
  it('forwardBody emits the separator + header block, not blockquoted', () => {
    const html = forwardBody({
      bodyHtml: '<p>orig</p>',
      textBody: '',
      separator: '--- Forwarded ---',
      headerBlock: 'From: A\nSubject: S',
    })
    expect(html).toContain('--- Forwarded ---')
    expect(html).toContain('<div>From: A</div>')
    expect(html).toContain('<div>Subject: S</div>')
    expect(html).toContain('<p>orig</p>')
    expect(html).not.toContain('<blockquote>')
  })
})

describe('identity', () => {
  it('infers From from the addressed own address', () => {
    const src = source({ to: [addr('other@x.test')], cc: [addr('ME@x.test')] })
    expect(inferFromIdentity(src, ['me@x.test'])).toBe('me@x.test')
  })
  it('falls back to the first own address', () => {
    expect(inferFromIdentity(source(), ['me@x.test'])).toBe('me@x.test')
    expect(inferFromIdentity(source(), [])).toBeUndefined()
  })
  it('ownAddresses lowercases, dedups, and drops non-personal accounts', () => {
    const session = {
      username: 'Me@x.test',
      accounts: {
        a: { name: 'Me@x.test', isPersonal: true },
        b: { name: 'shared@x.test', isPersonal: false },
        c: { name: 'alias@x.test', isPersonal: true },
      },
    }
    const result = ownAddresses(session, 'a')
    expect(result).toContain('me@x.test')
    expect(result).toContain('alias@x.test')
    expect(result).not.toContain('shared@x.test')
    expect(new Set(result).size).toBe(result.length)
  })
})

describe('forwardAttachments', () => {
  const part = (over: Partial<EmailBodyPart>): EmailBodyPart =>
    ({
      partId: null,
      blobId: null,
      size: 0,
      name: null,
      type: 'application/octet-stream',
      charset: null,
      disposition: null,
      cid: null,
      language: null,
      location: null,
      headers: [],
      subParts: null,
      ...over,
    }) as EmailBodyPart

  it('maps parts with a blobId to draft attachments, skipping blobless parts', () => {
    const result = forwardAttachments({
      attachments: [
        part({ blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 10, cid: null }),
        part({ blobId: null, name: 'skip' }),
      ],
    })
    expect(result).toEqual([
      { blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 10, cid: null },
    ])
  })
})
