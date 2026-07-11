/**
 * Search-snippet sanitization (M3.1, FR-SRCH-01). `SearchSnippet/get` returns subject/preview with
 * the matched terms wrapped in server-produced `<mark>` markup (SP.4). It is UNTRUSTED markup, so it
 * is escaped-then-re-marked: {@link escapeHtml} neutralizes ALL html + attributes (so any
 * `<img onerror>` / `<mark onclick>` / stray `<`/`&` is inert), then ONLY the two exact bare tag
 * sequences `<mark>` / `</mark>` are re-allowed. No attacker markup or attribute can survive.
 */

import { escapeHtml } from '@waxwing/mail-html'

export function sanitizeSnippet(raw: string): string {
  return escapeHtml(raw)
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>')
}
