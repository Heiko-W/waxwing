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
 * The unfocused reading is taken by moving focus away and reading the SAME element again, rather
 * than by reading a different element or a cached value: `:focus-visible` is the only thing that
 * may differ between the two readings.
 *
 * Keyboard Tab, not `element.focus()`. That is the whole point of `:focus-visible` — a scripted
 * focus does not necessarily match it, and a sweep built on `.focus()` would report rings that a
 * keyboard user never sees, or miss the ones they do.
 *
 * ## Where the walk starts, and why it is a `tabindex`
 *
 * `document.body.focus()` used to stand for "go back to the top and Tab from there", and in
 * Chromium it is a NO-OP: `<body>` is not a focusable area, so `focus()` returns without touching
 * anything and `document.activeElement` stays on whatever the test last clicked. Measured — the
 * expression `(document.body.focus(), document.activeElement === document.body)` is `false`.
 *
 * So every sweep began wherever the previous interaction had left focus and ran to the END of the
 * document. The header, the account menu, the main navigation and the folder tree were never
 * measured on any screen whose test had already clicked past them: `list` recorded 11 stops where
 * the order has 24, and `reading` recorded 5 where it has 28. The MAX_TAB_STOPS ceiling never came
 * near being the limit — the walk was simply starting three quarters of the way down.
 *
 * It was also ORDER-DEPENDENT, which is how it finally failed rather than merely under-measuring.
 * Chromium's *sequential focus navigation starting point* is not the same thing as
 * `document.activeElement`, and re-renders the test does not control reset it: with the settings
 * panel focused by `SettingsPage`'s "focus follows the navigation" effect, the first Tab went to
 * the top of the document on an idle machine and stayed inside the panel on a loaded one. Same
 * code, opposite starting points — verified by driving the identical test at
 * `Emulation.setCPUThrottlingRate: 8`, which reproduces the CI failure every time.
 *
 * A `tabindex` makes `<body>` a focusable area, and then the same `focus()` does what this line
 * always claimed to do: the walk starts above the first control on every screen, on any machine.
 * It is removed again afterwards — a stray `tabindex` on `<body>` is exactly the sort of thing the
 * next assertion in this repo would trip over.
 *
 * ## Where the walk stops
 *
 * At the end of the document (Tab past the last control leaves `document.activeElement` on the
 * body), or at a genuine cycle. A cycle used to be "a name we have already seen", which is not the
 * same thing: six checkboxes all called "Select message" is an ordinary message list, not a wrap,
 * and keying on the name would end the sweep at the second row. Element IDENTITY is the question
 * being asked, so a `WeakSet` in the page answers it.
 */
async function tabStops(page: Page, max = MAX_TAB_STOPS): Promise<Stop[]> {
  await page.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
    ;(window as unknown as { __focusSweepSeen?: WeakSet<Element> }).__focusSweepSeen =
      new WeakSet<Element>()
  })
  try {
    return await collectStops(page, max)
  } finally {
    await page.evaluate(() => document.body.removeAttribute('tabindex'))
  }
}

/** The loop itself, split out so `tabStops` can guarantee the `tabindex` comes off again. */
async function collectStops(page: Page, max: number): Promise<Stop[]> {
  const stops: Stop[] = []
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(() => {
      const element = document.activeElement
      if (!(element instanceof HTMLElement) || element === document.body) return null
      // Identity, not name — see the note on this function for what keying on the name cost.
      const visited = (window as unknown as { __focusSweepSeen: WeakSet<Element> }).__focusSweepSeen
      const wrapped = visited.has(element)
      visited.add(element)

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
       *
       * ANOTHER control, found by search rather than by taking the first one. The first `a[href]`
       * in this app is "Skip to content" — now the first stop of every walk — so on that one stop
       * `querySelector` handed back the element under test itself and the `else` branch had to
       * carry it. That branch happens to work now, because the body is a focusable area for the
       * length of the walk; it did not before, and relying on it would put the sweep's correctness
       * on the same footing the bug above was on. Measured: reverting this line alone leaves the
       * file green, which is why it is written down as defence and not as a fix.
       */
      const park =
        [...document.querySelectorAll<HTMLElement>('a[href], button')].find(
          (candidate) => candidate !== element,
        ) ?? null
      element.blur()
      if (park !== null) park.focus()
      else document.body.focus()
      const blurred = read()
      // Give it back, so the next Tab continues from here rather than from the top.
      element.focus()
      return { name: name === '' ? tag : name, tag, focused, blurred, behind, own, wrapped }
    })
    if (stop === null) break // past the last control — the end of the order
    const { wrapped, ...appearance } = stop
    if (wrapped) break // back on a control already walked — the order has wrapped
    stops.push(appearance)
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

/**
 * The control a reader's very first Tab reaches, on every screen this app has.
 *
 * The `mustReach` guard below says the walk got FAR enough. Nothing said it started in the right
 * place, and for as long as nothing did, it did not: `document.body.focus()` is a no-op in
 * Chromium, so each sweep began at whatever the test had last clicked and the whole top of the
 * document — header, account menu, main navigation, folder tree — went unmeasured on every screen.
 * The sweeps still passed, and their stop counts drifted between 10 and 12 from run to run, which
 * is what a silently truncated walk looks like from the outside.
 *
 * By NAME rather than by count, for the reason `mustReach` is: a count cannot tell "the walk did
 * not start at the top" from "this build has one control fewer". The skip link is the first thing
 * in the document by construction — it is the one control whose entire purpose is to be first.
 */
const FIRST_STOP = 'Skip to content'

/**
 * @param mustReach - a control this screen certainly has, by accessible name.
 */
async function sweep(page: Page, screen: string, mustReach: string): Promise<void> {
  const stops = await tabStops(page)
  expect(
    stops[0]?.name,
    `the Tab walk on ${screen} did not start at the top of the document — it began at "${stops[0]?.name}", so everything above that was never measured`,
  ).toBe(FIRST_STOP)
  /*
   * B22's lesson, and the one that matters most in a sweep: a Tab walk that finds nothing makes
   * every assertion below vacuously true.
   *
   * By NAME, not by count. The first version demanded more than four stops, which is a number
   * measured on one machine: the reading screen has five here and four on the hosted runner, and
   * the guard failed for being tight rather than for anything being wrong. A count cannot tell "the
   * sweep never reached the surface under test" from "this surface has one control fewer than the
   * developer's did" — naming a control that is certainly there can, and it says which surface it
   * means.
   */
  expect(
    stops.map((stop) => stop.name),
    `the Tab walk on ${screen} never reached "${mustReach}" — the sweep is not measuring this screen`,
  ).toContain(mustReach)
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
    await sweep(page, 'list', 'Search')
  })

  test('the reading pane and its action bar', async ({ page }) => {
    await login(page)
    await messageList(page).getByText(READ_SUBJECTS.plain).click()
    /*
     * ENABLED, not merely visible.
     *
     * Reply, Reply all and Forward gate on `bodyReady` (`!loading && ready`, MessageView) and carry
     * the native `disabled` attribute until the body — and its inline images — have arrived. A
     * natively disabled button is not a tab stop, and `useToolbarRoving` deliberately skips it
     * (`button:not(:disabled)`), so in that window the action bar's single tab stop is "Move to
     * Trash" and no Tab walk on earth reaches "Reply". `toBeVisible` is true throughout it, which
     * is why this read as a mystery: the assertion the sweep makes about the screen was being
     * evaluated against a screen that was still loading.
     *
     * Waiting for the gate the product actually sets is the precondition; it is not a softer
     * assertion, it is the same assertion made once the screen exists.
     */
    await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeEnabled({
      timeout: SYNC_BUDGET_MS,
    })
    await sweep(page, 'reading', 'Reply')
  })

  test('the composer', async ({ page }) => {
    await login(page)
    await page.getByRole('button', { name: /New message|Compose/ }).click()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
    await sweep(page, 'composer', 'Message body')
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
    await sweep(page, 'settings', 'Offline & storage')
  })

  test('the dark theme, where a retuned token is likeliest to disappear', async ({ page }) => {
    // The contrast half of this file is the reason it exists, and dark is where a ring loses its
    // background: the same token over a near-black surface is a different measurement entirely.
    await login(page)
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await sweep(page, 'dark', 'Search')
  })

  test('carries no stale focus exemptions', async ({ page }) => {
    // ADR-015's bargain, in this file's terms: an exemption that no longer suppresses anything is a
    // licence nobody is using, and it would silently pre-approve the next defect on that control.
    // Runs last, over the screens above — so it needs one sweep of its own to have a full picture.
    await login(page)
    await sweep(page, 'list (staleness)', 'Search')
    const declared = [...EXEMPT.keys()]
    expect(
      declared.filter((name) => !used.has(name)),
      'focus exemptions that no longer suppress anything — delete them',
    ).toEqual([])
  })
})
