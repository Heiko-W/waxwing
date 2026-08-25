import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { openSettingsSection, revealPasswordForm, SYNC_BUDGET_MS } from './helpers'

/**
 * B6 — the computed-style focus sweep (WCAG 2.4.7 Focus Visible, 1.4.11 Non-text Contrast).
 *
 * ## Why this exists, given `focus-indicator.css.test.ts`
 *
 * That check reads STYLESHEETS. It proves the CSS no longer *says* the wrong thing — that no rule
 * switches an outline off without leaving a replacement — and it is structurally blind to two whole
 * classes of defect, which is what B5 said when it filed this:
 *
 * 1. **A ring that exists and cannot be seen.** `outline: 2px solid var(--waxwing-focus)` passes the
 *    file scan whatever colour that token resolves to. A token retuned to something close to the
 *    surface behind it is a focus indicator on paper and nothing at all on screen.
 * 2. **A ring nothing renders.** Specificity, cascade layers, a `:focus-visible` rule that never
 *    matches because the element is focused by script — none of that is visible in the text of a
 *    stylesheet, and jsdom computes no styles, so no unit test in this repo can see it either.
 *
 * ## What is measured
 *
 * The element is focused, its appearance recorded, then the focus is taken away and the same
 * properties recorded again. An indicator is a DIFFERENCE — a permanent border is not a focus
 * indicator however thick it is, and comparing the focused state against a threshold rather than
 * against the unfocused one would accept exactly that.
 *
 * "Measurably" is two questions, kept apart on purpose:
 *
 * - **Presence** (2.4.7, Level A, ASSERTED): focusing changes the outline or the box-shadow to
 *   something that renders — a width of at least 1px, a colour that is not fully transparent.
 * - **Contrast** (1.4.11, Level AA, ASSERTED with exemptions): the indicator colour reaches 3:1
 *   against the surface it is drawn on. This is the half that catches a retuned token, and it is
 *   also the half with real measurement error — see `EXEMPT` and the reporting below.
 *
 * ## The opt-out story
 *
 * ADR-015 established `waxwing-focus-exempt: <reason>` as the way a RULE opts out of the static
 * check, with the reason mandatory and its staleness checked (B27). This sweep cannot read comments
 * — it sees rendered elements, not source — so its opt-out is {@link EXEMPT}: keyed by accessible
 * name, reason mandatory, and asserted to be non-stale in its own test, which is the same bargain in
 * the same shape. A hardcoded skip list without either half would be neither.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

/** SC 1.4.11 — the ratio a non-text indicator must reach against what is behind it. */
const MIN_INDICATOR_CONTRAST = 3

/**
 * Tab stops to visit per screen. Generous: the folder tree and a virtualized list can put dozens of
 * controls in the order, and stopping early would quietly narrow the sweep to the chrome.
 */
const MAX_TAB_STOPS = 60

/**
 * Named opt-outs. The REASON is the point — a name alone would let the next person add a skip for
 * "it was red in CI". Checked for staleness by the last test in this file: an entry that no longer
 * suppresses anything is deleted, exactly as ADR-015's marker is.
 */
const EXEMPT = new Map<string, string>([
  // Empty, and that is the finding: the first run of this sweep produced exactly one failure — the
  // message body's sandboxed iframe, a tab stop with no indicator at all — and it was a defect to
  // FIX, not to exempt. See `.frame:focus-within` in `reading.module.css` for why the fix could not
  // be keyed on `:focus-visible`.
])

interface Appearance {
  readonly outlineStyle: string
  readonly outlineWidth: number
  readonly outlineColor: string
  readonly boxShadow: string
}

interface Stop {
  readonly name: string
  readonly tag: string
  readonly focused: Appearance
  readonly blurred: Appearance
  /** The first painted background OUTSIDE the element — what the ring's far edge sits on. */
  readonly behind: string
  /** The element's own painted background — what the ring's near edge sits on. */
  readonly own: string
}

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })
}

/**
 * Walk the Tab order, recording each stop's focused and unfocused appearance.
 *
 * The unfocused reading is taken by moving focus to `document.body` and reading the SAME element
 * again, rather than by reading a different element or a cached value: `:focus-visible` is the only
 * thing that may differ between the two readings.
 *
 * Keyboard Tab, not `element.focus()`. That is the whole point of `:focus-visible` — a scripted
 * focus does not necessarily match it, and a sweep built on `.focus()` would report rings that a
 * keyboard user never sees, or miss the ones they do.
 */
async function tabStops(page: Page, max = MAX_TAB_STOPS): Promise<Stop[]> {
  const stops: Stop[] = []
  const seen = new Set<string>()
  await page.evaluate(() => document.body.focus())
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(() => {
      const element = document.activeElement
      if (!(element instanceof HTMLElement) || element === document.body) return null

      const read = (): {
        outlineStyle: string
        outlineWidth: number
        outlineColor: string
        boxShadow: string
      } => {
        const style = getComputedStyle(element)
        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
          outlineColor: style.outlineColor,
          boxShadow: style.boxShadow,
        }
      }

      /*
       * The two colours a ring is adjacent to, which SC 1.4.11 asks about: what is INSIDE it (the
       * control's own painted background) and what is OUTSIDE it (the first ancestor that paints
       * one). A ring only has to stand out from one of them to be visible — its far edge does the
       * work — and demanding both would fail every design where the focused control fills itself
       * with the accent colour. "Skip to content" is exactly that: focused, it paints itself in the
       * ring's own colour, so measured against the inside alone it scores 1.00:1 while being one of
       * the most conspicuous things on the screen.
       */
      const paintedFrom = (start: Element | null): string => {
        let node: Element | null = start
        while (node !== null) {
          const colour = getComputedStyle(node).backgroundColor
          if (colour !== 'transparent' && !colour.startsWith('rgba(0, 0, 0, 0')) return colour
          node = node.parentElement
        }
        return 'rgb(255, 255, 255)'
      }

      const focused = read()
      const behind = paintedFrom(element.parentElement)
      const own = paintedFrom(element)
      const name =
        element.getAttribute('aria-label') ??
        element.textContent?.trim().slice(0, 40) ??
        element.tagName
      const tag = element.tagName.toLowerCase()

      // Take the focus away and read the same element again. `blur()` alone would leave
      // `:focus-visible` matching in some engines; moving focus to the body is unambiguous.
      /*
       * Take the focus away — by MOVING it to another real control, not by `blur()` plus a body
       * focus.
       *
       * The difference is not cosmetic. Some indicators are driven by an event rather than by a
       * pseudo-class: the message-body frame's ring is set on `window` blur and cleared on
       * `focusin`, because across an iframe boundary there is no pseudo-class to key on. A
       * `document.body.focus()` fires no `focusin`, so the ring stayed on and the frame's
       * "unfocused" reading was identical to its focused one — the element looked like it had a
       * permanent border rather than an indicator. Parking on a control is what a Tab does anyway.
       */
      const park = document.querySelector<HTMLElement>('a[href], button')
      element.blur()
      if (park !== null && park !== element) park.focus()
      else document.body.focus()
      const blurred = read()
      // Give it back, so the next Tab continues from here rather than from the top.
      element.focus()
      return { name: name === '' ? tag : name, tag, focused, blurred, behind, own }
    })
    if (stop === null) break
    const key = `${stop.tag}:${stop.name}`
    if (seen.has(key)) break // the order has wrapped
    seen.add(key)
    stops.push(stop)
  }
  return stops
}

// ---------------------------------------------------------------------------------------------
// Colour maths. The formula is WCAG 2.x's, and `apps/web/src/ui/contrast.ts` is its authority in
// this repo — this is the same computation over `rgb()`/`rgba()` strings, which is what
// `getComputedStyle` returns and what that module (hex-only) cannot take.
// ---------------------------------------------------------------------------------------------

interface Rgba {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

function parseColour(value: string): Rgba | null {
  const match = /rgba?\(([^)]+)\)/.exec(value)
  if (match === null) return null
  const parts = (match[1] as string).split(/[,/]/).map((part) => Number.parseFloat(part.trim()))
  const [r, g, b, a] = parts
  if (r === undefined || g === undefined || b === undefined) return null
  return { r, g, b, a: a ?? 1 }
}

/** `channel` composited over `behind` — a translucent ring is only as visible as what it lets through. */
function over(colour: Rgba, behind: Rgba): Rgba {
  const a = colour.a
  return {
    r: colour.r * a + behind.r * (1 - a),
    g: colour.g * a + behind.g * (1 - a),
    b: colour.b * a + behind.b * (1 - a),
    a: 1,
  }
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number): number => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

/** Does focusing change anything that renders? SC 2.4.7's question, asked as a difference. */
function hasIndicator(stop: Stop): boolean {
  const { focused, blurred } = stop
  const outlineAppeared =
    focused.outlineStyle !== 'none' &&
    focused.outlineWidth >= 1 &&
    (parseColour(focused.outlineColor)?.a ?? 1) > 0 &&
    (blurred.outlineStyle === 'none' ||
      blurred.outlineWidth < 1 ||
      blurred.outlineColor !== focused.outlineColor)
  const shadowAppeared = focused.boxShadow !== 'none' && focused.boxShadow !== blurred.boxShadow
  return outlineAppeared || shadowAppeared
}

/**
 * The indicator's contrast against the BETTER of its two neighbours, or `null` where there is no
 * ring to measure. Better, not worse: a ring is visible if it stands out from either side.
 */
function indicatorContrast(stop: Stop): number | null {
  const behind = parseColour(stop.behind)
  const own = parseColour(stop.own)
  if (behind === null || own === null) return null
  // The outline is the ring this app draws; a box-shadow replacement carries its colour first in
  // the computed value, which is what this picks up.
  const source =
    stop.focused.outlineStyle !== 'none' && stop.focused.outlineWidth >= 1
      ? stop.focused.outlineColor
      : stop.focused.boxShadow
  const ring = parseColour(source)
  if (ring === null) return null
  return Math.max(contrast(over(ring, behind), behind), contrast(over(ring, own), own))
}

function withoutIndicator(stops: readonly Stop[]): string[] {
  return stops
    .filter((stop) => !EXEMPT.has(stop.name))
    .filter((stop) => !hasIndicator(stop))
    .map((stop) => `${stop.tag} "${stop.name}" — focus changes nothing that renders`)
}

function tooFaint(stops: readonly Stop[]): string[] {
  return stops
    .filter((stop) => !EXEMPT.has(stop.name))
    .filter(hasIndicator)
    .map((stop) => ({ stop, ratio: indicatorContrast(stop) }))
    .filter(({ ratio }) => ratio !== null && ratio < MIN_INDICATOR_CONTRAST)
    .map(
      ({ stop, ratio }) =>
        `${stop.tag} "${stop.name}" — ring ${stop.focused.outlineColor} on ${stop.behind} / ${stop.own} is ${(ratio ?? 0).toFixed(2)}:1`,
    )
}

/** Every name this run actually had to skip — the staleness check's input. */
const used = new Set<string>()

function recordExemptions(stops: readonly Stop[]): void {
  for (const stop of stops) {
    if (!EXEMPT.has(stop.name)) continue
    if (!hasIndicator(stop) || (indicatorContrast(stop) ?? 99) < MIN_INDICATOR_CONTRAST) {
      used.add(stop.name)
    }
  }
}

async function sweep(page: Page, screen: string): Promise<void> {
  const stops = await tabStops(page)
  // B22's lesson, and the one that matters most in a sweep: a Tab walk that finds nothing makes
  // every assertion below vacuously true.
  expect(stops.length, `no tab stops found on ${screen} — the sweep is broken`).toBeGreaterThan(4)
  recordExemptions(stops)
  const ratios = stops.map(indicatorContrast).filter((r): r is number => r !== null)
  console.log(
    `[focus] ${screen}: ${stops.length} stops, weakest ring ${
      ratios.length > 0 ? Math.min(...ratios).toFixed(2) : 'n/a'
    }:1`,
  )
  expect(withoutIndicator(stops), `${screen}: focus is not visible (WCAG 2.4.7)`).toEqual([])
  expect(tooFaint(stops), `${screen}: focus ring below 3:1 (WCAG 1.4.11)`).toEqual([])
}

test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('B6 focus is visible, and visible enough', () => {
  test('the message list and its chrome', async ({ page }) => {
    await login(page)
    await sweep(page, 'list')
  })

  test('the reading pane and its action bar', async ({ page }) => {
    await login(page)
    await messageList(page).getByText(READ_SUBJECTS.plain).click()
    await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
    await sweep(page, 'reading')
  })

  test('the composer', async ({ page }) => {
    await login(page)
    await page.getByRole('button', { name: /New message|Compose/ }).click()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
    await sweep(page, 'composer')
  })

  test('settings', async ({ page }) => {
    await login(page)
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
    // "Offline & storage" rather than Appearance: master/detail means the rail plus ONE panel, and
    // Appearance is three selects — four tab stops in total, which is under this sweep's own floor.
    // The richest panel is the one worth walking, and it is the one `target-size.spec.ts` picks for
    // the same reason.
    await openSettingsSection(page, 'Offline & storage')
    await sweep(page, 'settings')
  })

  test('the dark theme, where a retuned token is likeliest to disappear', async ({ page }) => {
    // The contrast half of this file is the reason it exists, and dark is where a ring loses its
    // background: the same token over a near-black surface is a different measurement entirely.
    await login(page)
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await sweep(page, 'dark')
  })

  test('carries no stale focus exemptions', async ({ page }) => {
    // ADR-015's bargain, in this file's terms: an exemption that no longer suppresses anything is a
    // licence nobody is using, and it would silently pre-approve the next defect on that control.
    // Runs last, over the screens above — so it needs one sweep of its own to have a full picture.
    await login(page)
    await sweep(page, 'list (staleness)')
    const declared = [...EXEMPT.keys()]
    expect(
      declared.filter((name) => !used.has(name)),
      'focus exemptions that no longer suppress anything — delete them',
    ).toEqual([])
  })
})
