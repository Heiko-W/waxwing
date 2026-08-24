import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { revealPasswordForm, SYNC_BUDGET_MS } from './helpers'
import { noOverflow } from './no-overflow'

/**
 * The two viewport tiers nothing else in this directory asserts at.
 *
 * Of the nine Playwright configs here, every project runs at 1280 × 720 except the two phone ones
 * at 390 × 844. That leaves the TABLET tier — 40em to 64em, where the folder drawer coexists with
 * the split panes — with no assertions pointed at it at all, and the widescreen desktop covered only
 * by screenshot capture, which asserts nothing.
 *
 * It is not a theoretical gap. The German label "Einstellungen" measures 72 px at
 * `--waxwing-text-xs` while the 4.5rem navigation rail gave it 40, so it spilled past both edges of
 * its own box and started at x = -1, clipped by the viewport. It shipped, in the second of two
 * supported languages, on the app's top-level navigation — and the existing overflow sweep could
 * never have seen it, because at 390 px that nav is a bottom bar with 88 px per item. The bug lived
 * exactly in the band no test looked at.
 *
 * Resizing one context rather than adding two projects: the assertion is about LAYOUT at a width,
 * and a width is the only thing that needs to vary. Touch behaviour has its own projects already.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

/** Tablet portrait, and a widescreen desktop. Both outside every other suite's viewport. */
const TIERS = [
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 900 },
] as const

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })

test.beforeEach(async ({ page }) => {
  await seedReadMail()
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(messageList(page)).toBeVisible({ timeout: SYNC_BUDGET_MS })
})

/**
 * B49 — the reading pane's action bar is ONE row at every width, and nothing is lost to make it one.
 *
 * This is the defect the first tablet photograph found: eleven controls at the 44px a touch target
 * must be (WCAG 2.5.5) into a 270px pane is three rows, and the container-query pass that preceded
 * this only got it down to two. The fix is the overflow menu, so the assertion has two halves —
 * the row, and the actions that left it still being reachable. Either alone would pass while the
 * feature was broken: a bar that dropped five buttons on the floor is also one row.
 *
 * `hasTouch` is what makes this the real case. Without it the controls are 34px and more of them
 * fit, so the run would measure a pane that is not the one an iPad gets.
 */
test.use({ hasTouch: true, isMobile: true })

/** Every action the bar can offer, whether it is currently in the bar or behind the ⋯. */
const ALL_ACTIONS = [
  'Reply',
  'Reply all',
  'Forward',
  'Move to Trash',
  'Archive',
  'Move to…',
  'Label',
  'Mark as junk',
  'Flag',
  'Mark as unread',
] as const

test('the reading pane keeps its actions on one row, and none of them out of reach', async ({
  page,
}) => {
  await page.setViewportSize({ width: 834, height: 1112 })
  await messageList(page).getByText(READ_SUBJECTS.newsletter, { exact: true }).click()
  await expect(page.getByRole('heading', { name: READ_SUBJECTS.newsletter })).toBeVisible()

  const toolbar = page.getByRole('toolbar', { name: 'Message actions' })
  const buttons = toolbar.getByRole('button')
  const boxes = await buttons.evaluateAll((nodes) =>
    nodes.map((node) => ({
      label: node.getAttribute('aria-label') ?? '',
      // Rounded: sub-pixel differences within a row are not a second row.
      top: Math.round(node.getBoundingClientRect().top),
    })),
  )
  expect(boxes.length, 'the bar renders something').toBeGreaterThan(1)
  expect(new Set(boxes.map((box) => box.top)).size, 'rows the action bar occupies').toBe(1)

  // Priority order, from the owner's call on B49: reply is what survives longest.
  expect(boxes[0]?.label).toBe('Reply')
  expect(boxes.at(-1)?.label, 'the overflow trigger is the last thing in the row').toBe(
    'More actions',
  )

  // The half that makes the first half honest. Whatever left the bar has to be IN the menu.
  const inBar = new Set(boxes.map((box) => box.label))
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  const inMenu = await page
    .getByRole('menuitem')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''))
  for (const action of ALL_ACTIONS) {
    const reachable = inBar.has(action) || inMenu.some((item) => item.startsWith(action))
    expect(reachable, `${action} is reachable somewhere`).toBe(true)
  }
  // Something actually moved — otherwise this test would pass on a pane wide enough to need no
  // overflow at all, which is not the pane B49 is about.
  expect(inBar.size, 'the bar is shorter than the full action list').toBeLessThan(
    ALL_ACTIONS.length,
  )
})

for (const tier of TIERS) {
  test(`the shell fits a ${tier.name} viewport (${tier.width}px) on every screen`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: tier.width, height: tier.height })

    // The Inbox resolves itself now — `/mail` with no folder used to render "choose a folder".
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
    await noOverflow(page, `${tier.name}: message list`)

    await messageList(page).getByText(READ_SUBJECTS.newsletter, { exact: true }).click()
    await expect(page.getByRole('heading', { name: READ_SUBJECTS.newsletter })).toBeVisible()
    await noOverflow(page, `${tier.name}: reading`)

    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    await noOverflow(page, `${tier.name}: settings`)

    await page.getByRole('link', { name: 'Contacts', exact: true }).click()
    await noOverflow(page, `${tier.name}: contacts`)

    /*
     * Files, which this sweep has never covered — and which on 2026-08-21 gained a search field, a
     * selection bar and a third control in its header.
     *
     * The phone header is the tight one: below 40em the screen's own bar is PORTALLED into it
     * (`ScreenBar` / `SCREEN_BAR_ID`), so the breadcrumb, the folder title and every control share
     * one 390px row with the palette and account buttons. Nothing else in the suite would notice a
     * box crossing that edge, which is precisely the silence the same day's B-6 finding was about.
     */
    await page.getByRole('link', { name: 'Files', exact: true }).click()
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
    await noOverflow(page, `${tier.name}: files`)
  })
}

/**
 * The rail label defect itself, named rather than merely swept up — in the two shapes it now has.
 *
 * The original rule was "a navigation label stays inside the rail that holds it", and the defect it
 * came from was German: "Einstellungen" measures 72px at `--waxwing-text-xs` against the 40px text
 * area the rail gave it, so it spilled past both edges of its own box and shipped that way.
 *
 * The rail no longer PRINTS its labels — it is icons at 40em and up, and the span is
 * visually-hidden. That retires half the rule and makes the other half load-bearing: a label nobody
 * can see is exactly the kind of thing a later refactor deletes, and deleting it would take the
 * link's accessible name with it and leave the top-level navigation unusable by a screen reader
 * with no visible symptom at all. So both are asserted at both widths: nothing printed spills, and
 * every link is named either way.
 */
/**
 * Read every navigation link: its accessible name, whether the label is PRINTED, and whether a
 * printed one fits the bar that holds it.
 */
async function readNav(
  page: Page,
): Promise<{ name: string; printed: boolean; spilling: boolean }[]> {
  const nav = page.getByRole('navigation', { name: 'Primary navigation' })
  await expect(nav).toBeVisible()
  const measured = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Primary navigation"]')
    if (nav === null) return null
    const rail = nav.getBoundingClientRect()
    return Array.from(nav.querySelectorAll('a')).map((link) => {
      const span = link.querySelector('span')
      const box = span?.getBoundingClientRect()
      const printed = span !== null && getComputedStyle(span).clipPath === 'none'
      return {
        name: (link.getAttribute('aria-label') ?? span?.textContent ?? '').trim(),
        printed,
        spilling:
          printed && box !== undefined
            ? box.left < rail.left - 1 || box.right > rail.right + 1
            : false,
      }
    })
  })
  expect(measured, 'no main navigation').not.toBeNull()
  return measured ?? []
}

test('every navigation link keeps its name, and a printed label fits its bar', async ({ page }) => {
  for (const width of [1440, 834, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const links = await readNav(page)
    expect(links.length, `${width}px: the nav has no links`).toBeGreaterThan(0)
    expect(
      links.filter((link) => link.name === ''),
      `${width}px: a navigation link has no accessible name — the label span is what supplies it, ` +
        'and in the rail it is visually-hidden rather than absent for exactly this reason.',
    ).toEqual([])
    expect(
      links.filter((link) => link.spilling).map((link) => link.name),
      `${width}px: a printed navigation label is wider than the bar that holds it. German exposed ` +
        'this first ("Einstellungen" at 72px in a 40px text area); any language with long ' +
        'compounds can.',
    ).toEqual([])
  }
})

/**
 * WHO gets the word, and who gets the glyph alone (T-02).
 *
 * The rail became icons-only at 40em in v0.18.0, and the CSS comment named the compensation: "its
 * `title` shows it to a pointer". On a touchscreen there is no pointer — `hover: none`, so the
 * title never appears — and the top level of the app's navigation was five unlabelled glyphs with
 * no way at all to find out what they were. HIG `tab-bars`: "Include tab labels to help with
 * navigation."
 *
 * The rule is therefore not about WIDTH but about whether the fallback exists, and these two blocks
 * are the same viewport with the two answers. Both matter: dropping the first would let the rail
 * quietly go back to 96px on a desktop, which is the regression v0.18.0 was about.
 */
test.describe('with a pointer', () => {
  test.use({ hasTouch: false, isMobile: false })

  test('the rail is glyphs alone — the tooltip carries the name', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const links = await readNav(page)
    expect(
      links.filter((link) => link.printed).map((link) => link.name),
      'a pointer device prints no rail labels — see the (hover: hover) block in shell.module.css',
    ).toEqual([])
    // …and the name is still there for everything that reads names.
    expect(links.filter((link) => link.name === '')).toEqual([])
  })
})

test.describe('with a finger', () => {
  test('the tablet rail prints the labels, because nothing else can show them', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 834, height: 1112 })
    const links = await readNav(page)
    expect(
      links.filter((link) => link.printed).length,
      'a touch device has no hover, so the rail must say what its icons mean',
    ).toBeGreaterThan(0)
  })

  test('the phone bottom bar prints them too', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const links = await readNav(page)
    expect(links.filter((link) => link.printed).length).toBeGreaterThan(0)
  })
})

/**
 * The two things the tablet and phone tiers were measured to get wrong, named rather than swept up.
 *
 * `noOverflow` cannot see either: nothing overflows in either case. A filename shortened to two
 * characters fits its box perfectly, and a 36px button is inside the viewport. Both are failures of
 * a rule the app states elsewhere and broke in exactly one place.
 */
test('the attachment filename keeps more than a stub of itself on a tablet (M7)', async ({
  page,
}) => {
  // Measured at 820x1180: `quarterly-report.pdf` rendered as `qu…` while "Hide preview" stood at
  // full length beside it. The name is the only thing in that row that is not a fixed label, and it
  // was the only thing allowed to shrink.
  await page.setViewportSize({ width: 834, height: 1112 })
  await messageList(page).getByText(READ_SUBJECTS.pdf, { exact: true }).click()
  const name = page.getByText('quarterly-report.pdf')
  await expect(name).toBeVisible({ timeout: SYNC_BUDGET_MS })

  const width = await name.evaluate((node) => node.getBoundingClientRect().width)
  // 8rem is the floor the stylesheet commits to; anything at or below the two-character case is the
  // defect returning.
  expect(width, 'the filename box on a tablet').toBeGreaterThanOrEqual(120)
})

test('every tap target in the reading pane meets the coarse-pointer size on a phone (M11)', async ({
  page,
}) => {
  /*
   * The sender avatar doubles as the contact-card trigger and measured 36x36 — the one control in
   * the reading pane below `--waxwing-control-min`, which `tokens.css` raises to 2.75rem under
   * `pointer: coarse`. Everything around it (header buttons, folder actions, "Back to messages")
   * met it, which is what makes this worth naming: the app keeps this promise everywhere else.
   *
   * The token is read from the page rather than hardcoded, so this follows the design rather than
   * a copy of it.
   */
  await page.setViewportSize({ width: 390, height: 844 })
  await messageList(page).getByText(READ_SUBJECTS.plain, { exact: true }).click()
  await expect(page.getByRole('button', { name: /Show contact card for/ })).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })

  const minimum = await page.evaluate(() => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--waxwing-control-min')
    return Number.parseFloat(raw) * (raw.includes('rem') ? 16 : 1)
  })
  expect(minimum, 'a coarse pointer raises the control minimum to 44px').toBeGreaterThanOrEqual(44)

  const trigger = page.getByRole('button', { name: /Show contact card for/ })
  const box = await trigger.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  expect(box.width, 'contact-card trigger width').toBeGreaterThanOrEqual(minimum)
  expect(box.height, 'contact-card trigger height').toBeGreaterThanOrEqual(minimum)
})

/**
 * The folder rail can be put away on a desktop, and stays away (D-05, T-07).
 *
 * HIG `sidebars`: "Consider letting people hide the sidebar. People sometimes want to hide the
 * sidebar to create more room for content details or to reduce distraction … in macOS, you can
 * include a show/hide button." And `split-views`: "Provide multiple ways to reveal hidden panes.
 * For example, you might provide a toolbar button or a menu command — including a keyboard
 * shortcut."
 *
 * The toggle existed and was rendered only below 64em (`drawerCapable = tier !== 'desktop'`), so on
 * the tier where the rail is permanent there was no way to move it — and a web app has no menu bar
 * to fall back on, which makes the missing button the missing second way as well. The registry's 22
 * actions contained nothing about the sidebar either.
 *
 * The reload is the half that would otherwise be easy to get wrong: a toggle that forgets is worse
 * than no toggle, because the reader has to redo it on every visit.
 */
test('the folder rail hides on a desktop, by button and by shortcut, and stays hidden', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const folders = page.getByRole('navigation', { name: 'Folders' })
  await expect(folders).toBeVisible()

  const toggle = page.getByRole('button', { name: 'Hide folders' })
  await expect(toggle, 'no show/hide control on the tier where the rail is permanent').toBeVisible()
  await toggle.click()
  await expect(folders).toBeHidden()
  // The name follows the state — it used to read "Show folders" while `aria-expanded` said true.
  await expect(page.getByRole('button', { name: 'Show folders' })).toBeVisible()

  await page.reload()
  await expect(messageList(page)).toBeVisible({ timeout: SYNC_BUDGET_MS })
  await expect(folders, 'the choice did not survive a reload').toBeHidden()

  // …and the second way back, which is what `split-views` asks for by name.
  await page.locator('body').press('b')
  await expect(folders).toBeVisible()
})
