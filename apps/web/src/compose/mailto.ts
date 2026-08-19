/**
 * `mailto:` URI parsing (RFC 6068) — the payload a registered protocol handler hands us.
 *
 * The app registers `mailto` in its manifest, so a link anywhere on the system can open a composer
 * here. What arrives is a whole URI in a query parameter, and it is **untrusted input from another
 * origin**: a link on a web page decides its contents. Two consequences shape this file.
 *
 * - **Only the header fields RFC 6068 §5 calls safe are honoured.** `to`, `cc`, `bcc`, `subject`
 *   and `body`, and nothing else. The RFC permits arbitrary headers (`&in-reply-to=…`,
 *   `&from=…`); honouring those would let a link forge a reply relationship, choose the sender, or
 *   set headers the user cannot see in the composer before pressing send.
 * - **The body is plain text, always.** It is inserted as text, never as HTML, so a link cannot
 *   inject markup into the message the user is about to send.
 */

import type { EmailAddress } from '@waxwing/jmap'
import { parseAddressList } from './address-validation'

/** What a `mailto:` URI asked for. Every field is optional — `mailto:` alone is valid. */
export interface MailtoRequest {
  readonly to: EmailAddress[]
  readonly cc: EmailAddress[]
  readonly bcc: EmailAddress[]
  readonly subject: string
  readonly body: string
}

const EMPTY: MailtoRequest = { to: [], cc: [], bcc: [], subject: '', body: '' }

/**
 * Decodes one percent-encoded component of a `mailto:` URI.
 *
 * `decodeURIComponent` throws on a malformed escape (`%zz`), and a malformed link must not take the
 * app down — an undecodable field is dropped instead.
 */
function decodeField(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return ''
  }
}

/**
 * Parses a `mailto:` URI into the fields a composer can be seeded with.
 *
 * Returns an empty request for anything that is not a `mailto:` URI, so a caller can hand it a
 * query parameter without pre-checking. Never throws.
 */
export function parseMailto(uri: string): MailtoRequest {
  const trimmed = uri.trim()
  // Scheme comparison is case-insensitive (RFC 3986 §3.1).
  if (!/^mailto:/i.test(trimmed)) return EMPTY

  const withoutScheme = trimmed.slice('mailto:'.length)
  const queryStart = withoutScheme.indexOf('?')
  const pathPart = queryStart === -1 ? withoutScheme : withoutScheme.slice(0, queryStart)
  const queryPart = queryStart === -1 ? '' : withoutScheme.slice(queryStart + 1)

  const to = parseAddressList(decodeField(pathPart))
  const cc: EmailAddress[] = []
  const bcc: EmailAddress[] = []
  let subject = ''
  let body = ''

  for (const [rawKey, rawValue] of new URLSearchParams(queryPart)) {
    // `URLSearchParams` has already percent-decoded; `decodeField` is only for the path part.
    const value = rawValue
    switch (rawKey.toLowerCase()) {
      case 'to':
        // RFC 6068 §2: a `to` in the query ADDS to the addresses in the path.
        to.push(...parseAddressList(value))
        break
      case 'cc':
        cc.push(...parseAddressList(value))
        break
      case 'bcc':
        bcc.push(...parseAddressList(value))
        break
      case 'subject':
        subject = value
        break
      case 'body':
        body = value
        break
      default:
        // Every other header is ignored on purpose — see the note at the top of this file.
        break
    }
  }

  return { to, cc, bcc, subject, body }
}

/** Whether a parsed request carries anything worth opening a composer for. */
export function isEmptyMailto(request: MailtoRequest): boolean {
  return (
    request.to.length === 0 &&
    request.cc.length === 0 &&
    request.bcc.length === 0 &&
    request.subject === '' &&
    request.body === ''
  )
}

/**
 * Wraps plain text as the composer's HTML body.
 *
 * The composer is a rich-text editor, so the text has to arrive as markup — and a `mailto:` body
 * comes from a link, so escaping is not cosmetic. Newlines become paragraph breaks because that is
 * what a link author writing `body=Line%201%0ALine%202` means.
 */
export function mailtoBodyToHtml(text: string): string {
  if (text === '') return ''
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return escaped
    .split(/\r\n|\r|\n/)
    .map((line) => `<p>${line === '' ? '<br>' : line}</p>`)
    .join('')
}
