/**
 * Recipient address parsing + validation (M2.4, FR-CMP-05). Pure, no network — the pill fields
 * commit typed text through {@link parseAddressList}, flag pills that fail {@link isPlausibleEmail},
 * and render them via {@link formatAddress}. The check is pragmatic (one `@`, a dotted domain), not
 * full RFC 5322 — deliberately lenient so unusual-but-valid addresses aren't rejected.
 */

import type { EmailAddress } from '@waxwing/jmap'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Pragmatic plausibility (NOT RFC 5322): a non-space local part, `@`, and a dotted domain. */
export function isPlausibleEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim())
}

/** Pill / edit-back text: `Name <email>` when named, else the bare address. */
export function formatAddress(address: EmailAddress): string {
  return address.name !== null && address.name !== ''
    ? `${address.name} <${address.email}>`
    : address.email
}

function dequote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value
}

/**
 * Split a typed recipient string into addresses. Separators are `,`/`;` OUTSIDE angle brackets;
 * each token is `Name <email>` or a bare `email`. Empty tokens are dropped; an unparseable token is
 * kept as `{ name: null, email: token }` so it surfaces as an invalid pill rather than vanishing.
 */
export function parseAddressList(input: string): EmailAddress[] {
  const tokens: string[] = []
  let depth = 0
  let inQuotes = false
  let current = ''
  for (const character of input) {
    if (character === '"') {
      inQuotes = !inQuotes
      current += character
    } else if (character === '<') {
      depth += 1
      current += character
    } else if (character === '>') {
      depth = Math.max(0, depth - 1)
      current += character
    } else if ((character === ',' || character === ';') && depth === 0 && !inQuotes) {
      tokens.push(current)
      current = ''
    } else {
      current += character
    }
  }
  tokens.push(current)

  const out: EmailAddress[] = []
  for (const raw of tokens) {
    const token = raw.trim()
    if (token === '') continue
    const match = token.match(/^(.*)<([^<>]+)>$/)
    if (match) {
      const name = dequote((match[1] ?? '').trim())
      out.push({ name: name === '' ? null : name, email: (match[2] ?? '').trim() })
    } else {
      out.push({ name: null, email: token })
    }
  }
  return out
}
