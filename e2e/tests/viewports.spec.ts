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
