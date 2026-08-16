import { expect, type Page, test } from '@playwright/test'
import { LARGE_MAILBOX_NAME } from '../stalwart/seed-large.mjs'

/**
 * M4.8 — the 100 000-message mailbox, end to end (NFR-PERF-02, FR-LST-01).
 *
 * The list is virtualized over a `queryCache` window with visible-slice hydration, and every claim
 * that follows from that — "opening a huge folder is as fast as a small one", "scrolling does not
 * degrade", "select-all does not hydrate 100 000 rows" — is a claim about a real browser with real
 * layout. jsdom computes none of it, so nothing in the unit suite can check any of them.
 *
 * Separate from `perf.spec.ts` and from the `read` config's own fixture because it needs a **100 k
 * seeded mailbox** (`pnpm seed:large`), which takes ~8 minutes to build and would make every other
 * suite that shares a fixture pay for it. Run with `pnpm e2e:large`.
 *
 * The budgets come from the M1.9 measurements recorded in the plan (cached open ≈ 75 ms, folder
 * switch ≈ 100 ms) with room for a slower machine — not from what this run happens to produce.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

/** NFR-PERF-02: switching into the large folder must not scale with its size. */
const OPEN_BUDGET_MS = 2_000
/** A scroll far into the list re-hydrates a new slice; that must stay interactive. */
const SCROLL_BUDGET_MS = 1_000

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages' })
const grid = (page: Page) => page.getByRole('grid', { name: 'Messages' })

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 60_000 })
}

/** How many rows are in the DOM right now — the number virtualization exists to keep small. */
const renderedRows = (page: Page) => page.getByRole('row').count()

test.describe('M4.8 — a 100 000-message mailbox (NFR-PERF-02)', () => {
  test('opens the large folder promptly and renders only a window of it', async ({ page }) => {
    await login(page)

    const started = Date.now()
    await page.getByRole('treeitem', { name: new RegExp(LARGE_MAILBOX_NAME) }).click()
    await expect(messageList(page).getByRole('row').first()).toBeVisible({ timeout: 60_000 })
    const elapsed = Date.now() - started

    const rows = await renderedRows(page)
    console.log(`[perf-large] open: ${elapsed} ms, ${rows} rows in the DOM`)

    expect(elapsed).toBeLessThan(OPEN_BUDGET_MS)
    // THE virtualization assertion. Without it the timing above proves nothing: a list that rendered
    // all 100 000 rows could still open quickly on a fast machine and then be unusable.
    expect(rows, 'the list rendered far more rows than a viewport holds').toBeLessThan(100)
    expect(rows, 'no rows at all — the measurement is vacuous').toBeGreaterThan(1)
  })

  test('stays responsive scrolling deep into the list', async ({ page }) => {
    await login(page)
    await page.getByRole('treeitem', { name: new RegExp(LARGE_MAILBOX_NAME) }).click()
    await expect(messageList(page).getByRole('row').first()).toBeVisible({ timeout: 60_000 })

    const first = await messageList(page).getByRole('row').first().textContent()

    const started = Date.now()
    // A long way down: far enough that the window must be rebuilt from a different offset, not
    // merely extended by an overscan row or two.
    await page.mouse.move(400, 400)
    for (let step = 0; step < 40; step++) await page.mouse.wheel(0, 2_000)
    await expect(async () => {
      expect(await messageList(page).getByRole('row').first().textContent()).not.toBe(first)
    }).toPass({ timeout: 30_000 })
    const elapsed = Date.now() - started

    const rows = await renderedRows(page)
    console.log(`[perf-large] scroll: ${elapsed} ms, ${rows} rows in the DOM`)

    expect(elapsed).toBeLessThan(SCROLL_BUDGET_MS)
    // The window size must not GROW as we scroll — a virtualizer that appends instead of replacing
    // looks fine for the first screenful and degrades steadily from there.
    expect(rows).toBeLessThan(100)
  })

  test('select-all over 100 000 messages does not hydrate 100 000 rows', async ({ page }) => {
    await login(page)
    await page.getByRole('treeitem', { name: new RegExp(LARGE_MAILBOX_NAME) }).click()
    await expect(messageList(page).getByRole('row').first()).toBeVisible({ timeout: 60_000 })

    await grid(page).click()
    const started = Date.now()
    await page.keyboard.press('ControlOrMeta+a')
    // The bulk bar appearing is the app acknowledging the selection.
    await expect(page.getByRole('button', { name: /Archive/ }).first()).toBeVisible({
      timeout: 30_000,
    })
    const elapsed = Date.now() - started

    const rows = await renderedRows(page)
    console.log(`[perf-large] select-all: ${elapsed} ms, ${rows} rows in the DOM`)

    expect(elapsed).toBeLessThan(OPEN_BUDGET_MS)
    expect(rows, 'select-all forced every row into the DOM').toBeLessThan(100)
  })
})
