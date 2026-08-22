import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { revealPasswordForm } from './helpers'
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
  await expect(messageList(page)).toBeVisible({ timeout: 30_000 })
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
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
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
      timeout: 30_000,
    })
    await noOverflow(page, `${tier.name}: files`)
  })
}

/**
 * The rail label defect itself, named rather than merely swept up.
 *
 * `noOverflow` above would catch it, but only as an anonymous entry in a list of boxes; this states
 * the rule that was broken — a navigation label stays inside the rail that holds it — so a future
 * change that narrows the rail fails with a message that says what is wrong rather than what moved.
 */
test('every navigation label stays inside the rail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()

  const spilling = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Primary navigation"]')
    if (nav === null) return ['no main navigation']
    const rail = nav.getBoundingClientRect()
    return Array.from(nav.querySelectorAll('a')).flatMap((link) => {
      const span = link.querySelector('span')
      if (span === null) return []
      const box = span.getBoundingClientRect()
      const clipped = box.left < rail.left - 1 || box.right > rail.right + 1
      return clipped
        ? [`${span.textContent?.trim()} [${Math.round(box.left)}…${Math.round(box.right)}]`]
        : []
    })
  })

  expect(
    spilling,
    'a navigation label is wider than the rail that holds it — widen `.primaryNav`, or shorten the ' +
      'label. German exposed this first ("Einstellungen" at 72px in a 40px text area); any language ' +
      'with long compounds can.',
  ).toEqual([])
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
  await expect(name).toBeVisible({ timeout: 30_000 })

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
    timeout: 30_000,
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
