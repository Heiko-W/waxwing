/**
 * Output hygiene for the editor's HTML (M2.1, FR-CMP-01 "clean, mail-compatible HTML").
 *
 * Squire styles colour/font/size/highlight by adding BOTH an inline `style` AND an editor-only
 * `class` token (its default class names: `color`/`font`/`size`/`highlight`). Those classes carry
 * no meaning outside the editor and reference nothing in a sent message, so `getHTML()` strips them
 * while keeping the inline `style`. It also drops selection-bookmark nodes, `contenteditable`
 * attributes, and zero-width spaces Squire uses internally. Pure (DOMParser only) so it unit-tests.
 */

/** Squire's default `classNames` (color/font/size/highlight) — editor-only, safe to drop. */
const EDITOR_CLASSES = new Set(['color', 'font', 'size', 'highlight'])

/** U+200B zero-width space — Squire's internal cursor filler; must never ship. */
const ZERO_WIDTH_SPACE = /\u200B/g

export function cleanOutgoingHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const body = doc.body

  // Squire's collapsed-selection bookmarks (ids `squire-selection-*`) must never ship.
  for (const node of Array.from(body.querySelectorAll('[id^="squire-selection"]'))) node.remove()

  for (const el of Array.from(body.querySelectorAll('*'))) {
    el.removeAttribute('contenteditable')
    if (el.classList.length > 0) {
      for (const cls of Array.from(el.classList)) {
        if (EDITOR_CLASSES.has(cls)) el.classList.remove(cls)
      }
      if (el.classList.length === 0) el.removeAttribute('class')
    }
  }

  return body.innerHTML.replace(ZERO_WIDTH_SPACE, '')
}
