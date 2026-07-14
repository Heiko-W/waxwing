/**
 * The two canonical guards the global key dispatcher runs before it looks at the registry (M3.8).
 * Both are DOM-only and dependency-free so they unit-test directly.
 *
 * These are the single copies: the ad-hoc "am I in a field?" check that used to live inline in
 * `AppShell` (the `/` handler) was deleted in favour of {@link isTextEntryTarget}.
 */

/**
 * `<input type=…>` values that accept NO text. A checkbox is an `<input>`, and every message row has
 * one (plus the bulk bar's select-all), so treating all inputs as text entry would kill every
 * single-letter shortcut for the most natural hybrid flow there is: tick three rows with the mouse
 * (focus lands on the last checkbox), then press `e`.
 */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/**
 * True when the keystroke belongs to a text-entry surface — a text field, a native combobox/search
 * box, or a `contenteditable` (Squire's message body carries `role="textbox"`). Typing `e` in a search
 * box must never archive a message; pressing `e` with a CHECKBOX focused must.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  // `HTMLInputElement.type` is the normalized, lowercase type (`text` when absent or unknown).
  if (tag === 'INPUT') {
    return !NON_TEXT_INPUT_TYPES.has((target as HTMLInputElement).type)
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.closest('[role="textbox"],[role="combobox"],[role="searchbox"]') !== null
}

/**
 * True when the keystroke happened inside a portalled overlay. Every Waxwing portal host is marked
 * `data-waxwing-portal` (`ui/internal/Portal.tsx`) — Dialog, Menu, Tooltip, Toast, the queued-sends
 * bar AND the composer host — so this single check implements "no single-letter shortcut fires while
 * a modal or the composer is up", with no special case per overlay.
 */
export function isInOverlay(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('[data-waxwing-portal]') !== null
}
