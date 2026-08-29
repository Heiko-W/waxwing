/**
 * "You mentioned an attachment but attached none" heuristic (M2.8, FR-CMP-10). Scans the NEW message
 * text — quoted replies (`<blockquote>`) and the signature (`[data-waxwing-signature]`) are excluded,
 * so a reply to a mail that itself said "see attached" does not false-positive — for any of the
 * localized attachment keywords. Prefix match on a word boundary, so "attach" also catches "attached"
 * / "attachment". Pure (DOMParser only), so it unit-tests without a browser.
 *
 * ── WHY THE BOUNDARY IS NOT `\b` (found when twelve languages landed, v0.21.0) ─────────────────
 *
 * It was, and `\b` is defined against ASCII `\w`. So a keyword that BEGINS with a non-ASCII letter
 * can never sit on one: at the start of a string `\b` needs the first character to be a word
 * character, and `в`, `附` and `添` are not. Every Russian, Ukrainian, Japanese and Chinese keyword
 * was therefore unmatchable — the heuristic was not weaker in those languages, it was **off**, and
 * silently: the check runs, finds nothing, and the composer sends. Measured against the shipped
 * bundles, 19 of 19 keywords in those four languages were dead.
 *
 * `(^|[^\p{L}\p{N}])` with the `u` flag says the same thing about every alphabet, and without a
 * lookbehind (Safari only learned those in 16.4, and this is not the file to find that out in).
 *
 * ── AND WHY CJK IS EXEMPT FROM IT ─────────────────────────────────────────────────────────────
 *
 * Chinese and Japanese do not put spaces between words, so there is nothing for a boundary to be:
 * `附件` inside `请见附件` is preceded by a letter and would be rejected by any boundary rule at all.
 * For a keyword that starts in Han or kana the match is therefore a plain substring — which is what
 * "word boundary" means in a script that has no word gaps. The trade-off is real and is the right
 * way round: the cost is a possible false positive, and the alternative was no check.
 *
 * ── AND WHY THE CASE FOLD TAKES A LANGUAGE ────────────────────────────────────────────────────
 *
 * `toLowerCase()` folds Turkish `İ` to `i` + U+0307 (a combining dot), because without a language it
 * has to use the Unicode default. So a mail opening "İlişikte…" lowercased to something the keyword
 * `ilişikte` does not match, and the check went quiet on the one position it matters most — the
 * first word of the message. `toLocaleLowerCase(language)` gets it right, and gets `I` → `ı` right
 * too, which is the same bug in the other direction.
 */

import { SIGNATURE_ATTR } from './signature'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A keyword whose first character belongs to a script written without word gaps. Only the FIRST
 * character matters: the boundary rule is about what may precede the needle.
 */
const SCRIPT_WITHOUT_WORD_GAPS = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

function matcher(needle: string): RegExp {
  if (SCRIPT_WITHOUT_WORD_GAPS.test(needle)) return new RegExp(escapeRegExp(needle), 'u')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}`, 'u')
}

export function mentionsAttachment(
  bodyHtml: string,
  keywords: readonly string[],
  language = 'en',
): boolean {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')
  for (const excluded of Array.from(doc.body.querySelectorAll(`blockquote, [${SIGNATURE_ATTR}]`))) {
    excluded.remove()
  }
  const text = (doc.body.textContent ?? '').toLocaleLowerCase(language)
  if (text.trim() === '') return false
  return keywords.some((keyword) => {
    // Both sides folded the same way, or the fold itself becomes the mismatch.
    const needle = keyword.trim().toLocaleLowerCase(language)
    return needle !== '' && matcher(needle).test(text)
  })
}
