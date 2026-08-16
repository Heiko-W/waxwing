import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'

/**
 * M4.7 — axe across the real screens, in a real engine, in BOTH themes (FR-A11Y-01).
 *
 * The component suite already runs axe in 57 files, so the obvious question is what this adds. Three
 * classes of defect, all of which are invisible to a component test by construction:
 *
 * 1. **Colour contrast (WCAG 1.4.3, 1.4.11).** jsdom has no layout and no canvas, so `color-contrast`
 *    cannot run there at all — `apps/web/src/test/axe.ts` disables it explicitly and says so. It has
 *    never been checked against the composed, rendered app in either theme. That is the single
 *    biggest hole in the a11y story and the reason this file exists.
 * 2. **Whole-document rules.** `landmark-unique`, `region`, `page-has-heading-one`, duplicate
 *    landmark names — every one of these is a question about the assembled page. A component mounted
 *    alone is trivially unique and trivially the only region on the page, so it passes them for
 *    reasons that say nothing about the shipped shell. B13 (two regions both named "Notifications")
 *    is exactly this shape and went unnoticed through a full component suite.
 * 3. **Real state.** Live data, a real virtualized list, a real reading pane with sanitized foreign
 *    HTML inside it.
 *
 * Same rule set as the component helper — WCAG 2.x A/AA, no "best-practice" rules, since those are
 * advisory rather than conformance failures and the project's target is WCAG 2.2 AA.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }
const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages' })

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
}

/**
 * Force a theme without going through Settings — `data-theme` is what the theme module writes and
 * what the CSS keys off (`:root:not([data-theme="light"])`), so setting it directly renders exactly
 * what a user who picked that theme sees.
 */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

interface Violation {
  readonly id: string
  readonly impact?: string | null | undefined
  readonly nodes: readonly { readonly target: readonly unknown[] }[]
}

/** A readable one-liner per violation — the selector is what makes a failure actionable. */
function describe(violations: readonly Violation[]): string[] {
  return violations.flatMap((violation) =>
    violation.nodes.map(
      (node) => `${violation.id} (${violation.impact}) at ${node.target.join(' ')}`,
    ),
  )
}

/**
 * Rules run IN ADDITION to the WCAG tags. Both are axe "best-practice" rules, so the tag filter
 * excludes them — and both describe defects this app has actually shipped:
 *
 * - `landmark-unique` — B13: the toast region and the settings push-preferences section were both
 *   called "Notifications", which is two indistinguishable entries in a screen-reader rotor.
 * - `landmark-one-main` — a shell that loses its `<main>` in one route and not another is exactly
 *   the kind of drift a per-screen sweep is for.
 */
const EXTRA_RULES = ['landmark-unique', 'landmark-one-main']

async function scan(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze()
  // B22: axe silently reports zero violations if it never ran against anything. A page that produced
  // no PASSES either is a broken scan, not a clean one.
  expect(results.passes.length, 'axe found nothing to check — the scan is broken').toBeGreaterThan(
    5,
  )
  // A SECOND run, because `withRules` REPLACES the tag selection rather than adding to it — chaining
  // them silently reduced the sweep to two rules, which the guard above caught.
  const extra = await new AxeBuilder({ page }).withRules(EXTRA_RULES).analyze()
  return [...describe(results.violations), ...describe(extra.violations)]
}

/** Every screen worth scanning, as a name and the navigation that reaches it. */
const SCREENS: readonly { name: string; open: (page: Page) => Promise<void> }[] = [
  { name: 'message list', open: async () => {} },
  {
    name: 'reading pane',
    open: async (page) => {
      await messageList(page).getByText(READ_SUBJECTS.plain).click()
      await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeVisible({
        timeout: 30_000,
      })
    },
  },
  {
    name: 'composer',
    open: async (page) => {
      await page.getByRole('button', { name: 'New message', exact: true }).click()
      await expect(page.getByRole('textbox', { name: 'Message body' })).toBeVisible({
        timeout: 30_000,
      })
    },
  },
  {
    name: 'settings',
    open: async (page) => {
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
    },
  },
  {
    name: 'contacts',
    open: async (page) => {
      await page.getByRole('link', { name: 'Contacts', exact: true }).click()
      // The address-book rail, the same landmark `contacts.spec.ts` waits for — the Contacts area
      // has no level-1 heading of its own.
      await expect(page.getByRole('navigation', { name: 'Address books' })).toBeVisible({
        timeout: 30_000,
      })
    },
  },
  {
    name: 'command palette',
    open: async (page) => {
      await page.keyboard.press('ControlOrMeta+k')
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible({
        timeout: 30_000,
      })
    },
  },
]

test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('M4.7 axe sweep — real screens, both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const screen of SCREENS) {
      test(`${screen.name} has no WCAG A/AA violations (${theme})`, async ({ page }) => {
        await login(page)
        await setTheme(page, theme)
        await screen.open(page)
        expect(await scan(page), `${screen.name} / ${theme}`).toEqual([])
      })
    }
  }

  // The sign-in screen is the one surface a logged-in sweep can never reach, and the only one every
  // user without exception passes through.
  for (const theme of ['light', 'dark'] as const) {
    test(`the sign-in screen has no WCAG A/AA violations (${theme})`, async ({ page }) => {
      await page.goto('/')
      await expect(page.getByLabel('Username', { exact: true })).toBeVisible({ timeout: 30_000 })
      await setTheme(page, theme)
      expect(await scan(page), `sign-in / ${theme}`).toEqual([])
    })
  }
})
