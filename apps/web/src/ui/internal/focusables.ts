/**
 * Focusable-element discovery for the focus trap and roving-focus logic.
 *
 * Deliberately does NOT filter on `offsetParent`/computed visibility: jsdom has no layout
 * engine, so those checks would drop every element in component tests. Waxwing's overlays
 * never render hidden focusables inside a trapped region, so filtering on the semantic
 * signals (disabled, `hidden`, `type=hidden`, negative tabindex) is both correct here and
 * test-stable. Order follows DOM order, which is the tab order for our controls.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',')

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  )
}
