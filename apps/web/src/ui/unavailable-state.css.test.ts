import { describe, expect, it } from 'vitest'
import { readAppFile } from './css-sources'

/**
 * A CONTROL THAT SAYS IT CANNOT ACT MUST LOOK LIKE IT CANNOT ACT.
 *
 * `aria-disabled="true"` is a claim, and it is the only one this app makes about a control it has
 * refused while keeping it focusable (FR-A11Y-01: `disabled` would take the explanation out of
 * reach of the reader who needs it most). Made to a screen reader and to nobody else, that claim
 * is half a promise: the sign-in buttons on an offline cold start announced themselves as
 * unavailable and rendered in full primary blue, opacity 1, `cursor: pointer`. A sighted reader
 * pressed them and nothing happened. Every one of ~5900 unit tests was green; it took looking at
 * a phone.
 *
 * The component half is pinned in `Button.test.tsx` (the `unavailable` prop renders the same class
 * as `unavailableReason` always did). THIS pins the other half — that the class and the attribute
 * actually change how the button is painted — which no jsdom test can see, because jsdom computes
 * no styles and stubs `.css` imports to empty.
 *
 * Runs in the Node "unit" project, like every other `*.css.test.ts`: it reads the shipped
 * stylesheet from disk.
 */

const BUTTON_CSS = 'src/ui/Button.module.css'

/**
 * The declaration block of the first rule that SELECTS `needle` — `:not(...)` stripped first.
 *
 * Without the strip, `.button:active:not([aria-disabled='true'])` answers a search for
 * `[aria-disabled='true']` and hands back the press animation, which is the opposite rule.
 */
function ruleSelecting(text: string, needle: string): string | null {
  for (const match of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, selectors, body] = match
    if (
      unquote(selectors ?? '')
        .replace(/:not\([^)]*\)/g, '')
        .includes(needle)
    )
      return body ?? ''
  }
  return null
}

/** Attribute quoting is the formatter's business, not this test's. */
function unquote(selector: string): string {
  return selector.replace(/['"]/g, '')
}

describe('the unavailable button state is visible, not only announced', () => {
  const css = readAppFile(BUTTON_CSS).text

  it('dims the button and refuses the pointer', () => {
    const body = ruleSelecting(css, '.button.unavailable')
    expect(body, `no .button.unavailable rule in ${BUTTON_CSS}`).not.toBeNull()
    // The same two declarations `:disabled` uses — mirroring it is the point, so the two states
    // cannot read as different degrees of the same thing.
    expect(body).toMatch(/cursor:\s*not-allowed/)
    expect(body).toMatch(/opacity:\s*var\(--waxwing-disabled-opacity\)/)
  })

  it('THE SAFETY NET: the attribute alone is enough, however it was set', () => {
    // The defect was a caller passing `aria-disabled` straight through `...rest`: the attribute
    // arrived and the class did not. Every OTHER control in this app already keys off the
    // attribute (`Menu.module.css`, `labels.module.css`); this one was the exception, which is why
    // it was the one that broke. Deleting this selector re-opens exactly that door.
    const body = ruleSelecting(css, '.button[aria-disabled=true]')
    expect(body, `no [aria-disabled] rule in ${BUTTON_CSS}`).not.toBeNull()
    expect(body).toMatch(/opacity:\s*var\(--waxwing-disabled-opacity\)/)
  })

  it('and the press animation does not fire on a control that cannot be pressed', () => {
    // `:active` scales the button by 0.97 as its "something happened" answer. On a refused control
    // that is a second, louder promise than the colour — it says the press LANDED.
    const active = /\.button:active([^{]*)\{/.exec(css)
    expect(active, 'no .button:active rule').not.toBeNull()
    const guard = unquote(active?.[1] ?? '')
    expect(guard).toContain(':not(.unavailable)')
    expect(guard).toContain(':not([aria-disabled=true])')
  })
})
