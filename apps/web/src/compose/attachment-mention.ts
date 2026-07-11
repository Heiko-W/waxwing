/**
 * "You mentioned an attachment but attached none" heuristic (M2.8, FR-CMP-10). Scans the NEW message
 * text — quoted replies (`<blockquote>`) and the signature (`[data-waxwing-signature]`) are excluded,
 * so a reply to a mail that itself said "see attached" does not false-positive — for any of the
 * localized attachment keywords. Prefix match on a word boundary, so "attach" also catches "attached"
 * / "attachment". Pure (DOMParser only), so it unit-tests without a browser.
 */

import { SIGNATURE_ATTR } from './signature'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function mentionsAttachment(bodyHtml: string, keywords: readonly string[]): boolean {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')
  for (const excluded of Array.from(doc.body.querySelectorAll(`blockquote, [${SIGNATURE_ATTR}]`))) {
    excluded.remove()
  }
  const text = (doc.body.textContent ?? '').toLowerCase()
  if (text.trim() === '') return false
  return keywords.some((keyword) => {
    const needle = keyword.trim().toLowerCase()
    return needle !== '' && new RegExp(`\\b${escapeRegExp(needle)}`).test(text)
  })
}
