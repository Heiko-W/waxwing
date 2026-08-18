import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'

/**
 * M4.7 — target size (WCAG 2.2 SC 2.5.8 Target Size (Minimum), Level AA), against the live fixture.
 *
 * This cannot be a unit test, and that is the whole reason it exists: jsdom computes no layout, so
 * `getBoundingClientRect()` there returns zeroes for everything. The size of a control is decided by
 * padding, line-height, flex sizing and the icon inside it — four things only a real engine resolves.
 * Every check in the repo that could see a too-small button is structurally blind to it.
 *
 * **The threshold is 24 × 24 CSS px, not 44.** SC 2.5.8 (AA, the project's stated conformance target)
 * asks for 24; the 44 px figure is SC 2.5.5 Target Size (Enhanced), which is Level AAA. The
 * implementation plan said 44 — corrected there, because quietly measuring against a AAA number and
 * reporting AA conformance is the wrong direction, and quietly measuring against AA while the plan
 * says 44 is the other wrong direction. 44 is measured too and REPORTED, never asserted.
 *
 * The exceptions in SC 2.5.8 are honoured explicitly rather than by omission:
 *
 * - **Inline** — a target in a sentence, sized by the text flow (a link inside message body text).
 * - **User-agent** — a control the page does not style (none here; native `<select>` etc. would be).
 * - **Essential** — where a specific presentation is legally required or the only way to convey the
 *   information. Nothing in Waxwing claims this.
 * - **Spacing** — a target smaller than 24 px still passes if a 24 px circle centred on it overlaps
 *   no other target's circle. This is IMPLEMENTED (see `spacingPasses`), because it is the exception
 *   real toolbars actually rely on, and skipping it would mean either false failures or a weaker rule.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }
/** SC 2.5.8, Level AA — the bar this suite enforces. */
const MIN_AA = 24
/** SC 2.5.5, Level AAA — measured and reported, never asserted. */
const MIN_AAA = 44

interface Target {
  readonly name: string
  readonly role: string
  /** Lower-cased tag, so the design check can isolate real `<button>`s from checkboxes and links. */
  readonly tag: string
  readonly width: number
  readonly height: number
  readonly cx: number
  readonly cy: number
  /** True when the element sits in a run of text — the SC's "inline" exception. */
  readonly inline: boolean
}

// `exact` is load-bearing: the default substring match also matches the live region labelled
// "Status messages", so the loose form is a strict-mode violation the moment anything asks for this
// region while both are mounted. Same collision CONTRIBUTING.md documents for /Archive/.
const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
}

/**
 * Every VISIBLE interactive target on the current screen, with its rendered box.
 *
 * Runs in the page rather than through locators because it has to consider every candidate at once —
 * the spacing exception is a question about the whole set, not about one element.
 */
async function targets(page: Page): Promise<Target[]> {
  return page.evaluate(() => {
    const SELECTOR =
      'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [role=option], [role=treeitem]'
    const out: {
      name: string
      role: string
      tag: string
      width: number
      height: number
      cx: number
      cy: number
      inline: boolean
    }[] = []
    for (const element of document.querySelectorAll(SELECTOR)) {
      if (!(element instanceof HTMLElement)) continue
      const box = element.getBoundingClientRect()
      // Not rendered at all (a closed drawer, a collapsed panel): nothing to size.
      if (box.width === 0 || box.height === 0) continue
      const style = getComputedStyle(element)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      if (element.hasAttribute('disabled') || element.getAttribute('aria-hidden') === 'true')
        continue

      // The SC's "inline" exception, decided the way the SC words it — a target whose size is
      // determined by the line of text it sits in. `display: inline` on a link inside a paragraph is
      // exactly that; an inline-FLEX icon button is not, so only true inline boxes qualify.
      const parentText = element.parentElement?.textContent?.trim() ?? ''
      const ownText = element.textContent?.trim() ?? ''
      const inline = style.display === 'inline' && parentText.length > ownText.length

      out.push({
        name: (element.getAttribute('aria-label') ?? ownText ?? element.tagName).slice(0, 60),
        role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
        tag: element.tagName.toLowerCase(),
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
        cx: box.x + box.width / 2,
        cy: box.y + box.height / 2,
        inline,
      })
    }
    return out
  })
}

/**
 * The SC 2.5.8 spacing exception: an undersized target passes if a 24 px-diameter circle centred on
 * it does not intersect the circle of any other target. Two circles of radius 12 intersect when
 * their centres are closer than 24 px — so the test is a plain centre-distance check.
 */
function spacingPasses(target: Target, all: readonly Target[]): boolean {
  return all.every((other) => {
    if (other === target) return true
    const dx = other.cx - target.cx
    const dy = other.cy - target.cy
    return Math.hypot(dx, dy) >= MIN_AA
  })
}

function undersized(all: readonly Target[]): string[] {
  return all
    .filter((t) => !t.inline)
    .filter((t) => t.width < MIN_AA || t.height < MIN_AA)
    .filter((t) => !spacingPasses(t, all))
    .map((t) => `${t.role} "${t.name}" — ${t.width}×${t.height}`)
}

/**
 * The DESIGN promise, which is a different and much sharper question than conformance.
 *
 * SC 2.5.8's spacing exception is broad enough that it exonerates almost anything a real toolbar
 * does — measured: shrinking `--waxwing-control-min` from 34 px to 16 px leaves every conformance
 * assertion above GREEN, because the gaps between buttons keep their 24 px circles apart. That is a
 * correct reading of the SC and a useless regression test.
 *
 * So the sizes the design actually commits to are asserted separately, against the token itself:
 * `--waxwing-control-min` is 34 px on pointer devices and 44 px on touch (tokens.css), and every
 * BUTTON is supposed to reach it. Reading the token at runtime rather than hardcoding 34 means the
 * touch project checks 44 with no second copy of this rule.
 */
const DESIGN_EXEMPT = new Map<string, string>([
  // The masthead link is text, sized by its own line box — it is not a control with a hit area.
  ['Waxwing home', 'a text wordmark, not a control'],
  // Disclosure toggles inside the recipient row: deliberately small text buttons, kept apart by the
  // row's own spacing (SC 2.5.8's spacing exception genuinely applies to these two).
  ['Show Cc field', 'inline text disclosure inside the recipient row'],
  ['Show Bcc field', 'inline text disclosure inside the recipient row'],
  // Row checkboxes: a native control at the browser's own size, one per 54–76 px row.
  ['Select message', 'native checkbox, one per row, spacing exception applies'],
])

/** Buttons that fall short of `--waxwing-control-min` without a recorded reason. */
function belowToken(all: readonly Target[], token: number): string[] {
  return all
    .filter((t) => t.tag === 'button' && !t.inline)
    .filter((t) => !DESIGN_EXEMPT.has(t.name))
    .filter((t) => t.height < token - 0.5 || t.width < token - 0.5)
    .map((t) => `"${t.name}" — ${t.width}×${t.height}, below the ${token}px control minimum`)
}

/**
 * `--waxwing-control-min` in CSS pixels, as the running browser resolves it — floored at the SC's
 * own 24 px. The floor is what makes this a real check: measuring buttons against a token that has
 * itself been shrunk would go green at any size, which is exactly what the first draft of this file
 * did (verified by shrinking the token to 16 px: every assertion stayed green).
 */
async function controlMin(page: Page): Promise<number> {
  const resolved = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.blockSize = 'var(--waxwing-control-min)'
    probe.style.position = 'absolute'
    document.body.append(probe)
    const size = probe.getBoundingClientRect().height
    probe.remove()
    return size
  })
  return Math.max(resolved, MIN_AA)
}

/** Reported, not asserted: how far the screen is from Level AAA. */
function report(screen: string, all: readonly Target[]): void {
  const small = all.filter((t) => !t.inline && (t.width < MIN_AAA || t.height < MIN_AAA))
  console.log(
    `[target-size] ${screen}: ${all.length} targets, ${small.length} below the AAA 44 px bar` +
      (small.length > 0
        ? ` — ${small.map((t) => `${t.name} ${t.width}×${t.height}`).join(', ')}`
        : ''),
  )
}

test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('M4.7 target size (SC 2.5.8, Level AA)', () => {
  test('the message list and its chrome meet 24 px', async ({ page }) => {
    await login(page)
    const found = await targets(page)
    // B22: a selector that stops matching would make every assertion below vacuously true.
    expect(found.length, 'no interactive targets found — the sweep is broken').toBeGreaterThan(10)
    report('list', found)
    expect(undersized(found), 'targets below 24 px with no spacing exemption').toEqual([])
    expect(
      belowToken(found, await controlMin(page)),
      'buttons smaller than the design commits to',
    ).toEqual([])
  })

  test('the reading pane and its action bar meet 24 px', async ({ page }) => {
    await login(page)
    await messageList(page).getByText(READ_SUBJECTS.plain).click()
    await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeVisible({
      timeout: 30_000,
    })
    const found = await targets(page)
    expect(found.length).toBeGreaterThan(10)
    report('reading', found)
    expect(belowToken(found, await controlMin(page))).toEqual([])
    expect(undersized(found)).toEqual([])
  })

  test('the composer meets 24 px', async ({ page }) => {
    await login(page)
    await page.getByRole('button', { name: /New message|Compose/ }).click()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
      timeout: 30_000,
    })
    const found = await targets(page)
    expect(found.length).toBeGreaterThan(10)
    report('composer', found)
    expect(belowToken(found, await controlMin(page))).toEqual([])
    expect(undersized(found)).toEqual([])
  })

  // The list checkboxes render at 18.4 px and pass ONLY through the spacing exception — the row
  // pitch keeps their 24 px circles apart. Compact density shortens exactly that pitch, so it is the
  // one setting that can flip them from conforming to failing. Asserting the comfortable default
  // alone would call the screen conformant while a one-click preference makes it not.
  test('the list still meets 24 px at COMPACT density', async ({ page }) => {
    await login(page)

    // Density is set in Settings now, not in the list toolbar. It used to be offered in BOTH, both
    // writing `list.density` — one setting behind two doors — and the toolbar copy was the one that
    // cost 156 px above every folder on a phone. Going through the real surface also means this
    // test exercises the path a user actually takes.
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByLabel('List density').selectOption('compact')
    await expect(page.getByLabel('List density')).toHaveValue('compact')
    await page.getByRole('link', { name: 'Mail', exact: true }).click()

    // The row pitch is what the exception depends on, so wait for the LIST to actually reflow
    // rather than for the control to report its new value.
    await expect(messageList(page)).toBeVisible()
    const found = await targets(page)
    // The floor is a "did the sweep run at all" guard, not a control count — and the count
    // legitimately dropped to exactly 10 when the list toolbar's four permanently visible controls
    // moved (three behind a disclosure, density into Settings), which is what left 156 px of a
    // phone back to the mail. Still far from empty: eight seeded rows and their checkboxes are here.
    expect(found.length, 'no interactive targets found — the sweep is broken').toBeGreaterThan(5)
    report('list (compact)', found)
    expect(belowToken(found, await controlMin(page))).toEqual([])
    expect(undersized(found), 'compact density collapses the spacing exemption').toEqual([])
  })

  test('settings meets 24 px', async ({ page }) => {
    await login(page)
    // Navigate through the UI rather than `goto('/settings')`: a fresh load lands on the sign-in
    // screen, and the sweep would then measure the login form under the name "settings".
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({
      timeout: 30_000,
    })
    const found = await targets(page)
    expect(found.length).toBeGreaterThan(10)
    report('settings', found)
    expect(belowToken(found, await controlMin(page))).toEqual([])
    expect(undersized(found)).toEqual([])
  })
})
