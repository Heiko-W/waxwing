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

/**
 * How long the FIRST window of the large folder may take to arrive.
 *
 * Not a budget — the budgets are the constants above, and they time operations that start once the
 * data is there. This is the wait for a cold replica to be filled from a Stalwart holding 100 000
 * messages, with every test in this file starting from an empty IndexedDB. Running the four tests
 * back to back puts the fixture under sustained load and that first fill stretches well past the
 * 60 s the suite originally allowed, which failed three tests that pass individually.
 */
const FIRST_WINDOW_MS = 180_000

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('treeitem', { name: new RegExp(LARGE_MAILBOX_NAME) })).toBeVisible({
    timeout: 60_000,
  })
}

/** The folder route with no message open — `/mail/<mailboxId>`, no trailing message id. */
const FOLDER_URL = /\/mail\/[^/]+$/

/** How many rows are in the DOM right now — the number virtualization exists to keep small. */
const renderedRows = (page: Page) => page.getByRole('row').count()

test.describe('M4.8 — a 100 000-message mailbox (NFR-PERF-02)', () => {
  test('opens the large folder promptly and renders only a window of it', async ({ page }) => {
    await login(page)

    const started = Date.now()
    await page.getByRole('treeitem', { name: new RegExp(LARGE_MAILBOX_NAME) }).click()
    await expect(messageList(page).getByRole('row').first()).toBeVisible({
      timeout: FIRST_WINDOW_MS,
    })
    const elapsed = Date.now() - started

    const rows = await renderedRows(page)
    console.log(`[perf-large] open: ${elapsed} ms, ${rows} rows in the DOM`)

    expect(elapsed).toBeLessThan(OPEN_BUDGET_MS)
    // THE virtualization assertion. Without it the timing above proves nothing: a list that rendered
    // all 100 000 rows could still open quickly on a fast machine and then be unusable.
    expect(rows, 'the list rendered far more rows than a viewport holds').toBeLessThan(100)
    expect(rows, 'no rows at all — the measurement is vacuous').toBeGreaterThan(1)
  })

  test('stays responsive scrolling deep into the list, and the window does not grow', async ({
    page,
  }) => {
    await login(page)
    await page.getByRole('treeitem', { name: new RegExp(LARGE_MAILBOX_NAME) }).click()
    await expect(messageList(page).getByRole('row').first()).toBeVisible({
      timeout: FIRST_WINDOW_MS,
    })
    const atRest = await renderedRows(page)
    const first = await messageList(page).getByRole('row').first().textContent()

    const started = Date.now()
    await page.mouse.move(400, 400)
    for (let step = 0; step < 40; step++) await page.mouse.wheel(0, 2_000)
    await expect(async () => {
      expect(await messageList(page).getByRole('row').first().textContent()).not.toBe(first)
    }).toPass({ timeout: 30_000 })
    const elapsed = Date.now() - started

    // SETTLE before counting. Counting mid-scroll measures a transient — rows on their way out
    // alongside the ones coming in — and reports it as the window size: an early draft of this test
    // read 750 rows that way and called it a leak, while the same page at rest holds 50.
    await expect(async () => {
      expect(await renderedRows(page)).toBe(atRest)
    }).toPass({ timeout: 15_000 })
    const rows = await renderedRows(page)

    console.log(
      `[perf-large] scroll: ${elapsed} ms to the first new row, ${rows} rows at rest (was ${atRest})`,
    )

    expect(elapsed).toBeLessThan(SCROLL_BUDGET_MS)
    // The window must not GROW: a virtualizer that appends instead of replacing looks fine for the
    // first screenful and degrades steadily from there.
    expect(rows).toBe(atRest)
    expect(rows).toBeLessThan(100)
  })

  test('select-all over 100 000 messages does not hydrate 100 000 rows', async ({ page }) => {
    await login(page)
    await page.getByRole('treeitem', { name: new RegExp(LARGE_MAILBOX_NAME) }).click()
    await expect(messageList(page).getByRole('row').first()).toBeVisible({
      timeout: FIRST_WINDOW_MS,
    })

    await grid(page).click()
    const started = Date.now()
    await page.keyboard.press('ControlOrMeta+a')
    // The COUNT is the app acknowledging the selection — the same signal `keyboard.spec.ts` uses.
    // Not the bulk bar's Archive button: `getByRole('button', {name: /Archive/})` also matches the
    // Archive FOLDER's row menu, so it would pass whether or not anything was selected.
    await expect(page.getByText(/\d+ selected/)).toBeVisible({ timeout: 30_000 })
    const elapsed = Date.now() - started

    const rows = await renderedRows(page)
    console.log(`[perf-large] select-all: ${elapsed} ms, ${rows} rows in the DOM`)

    expect(elapsed).toBeLessThan(OPEN_BUDGET_MS)
    expect(rows, 'select-all forced every row into the DOM').toBeLessThan(100)
  })

  /**
   * The long-session leak check M4.8 asks for: open and close 100 conversations, then see whether
   * the heap came back down.
   *
   * Every opened message mounts a reading pane, a sandboxed body frame, inline-image blob URLs and a
   * set of liveQuery subscriptions. A leak in any of them is invisible in ordinary use — the tab is
   * simply slower an hour in — and no unit test can see it at all, because the thing that leaks is
   * the browser's own retention, not a value any assertion can reach.
   *
   * `JSHeapUsedSize` after a forced GC is the honest measure. The threshold is a RATIO rather than a
   * byte count: absolute heap size depends on the machine and the Chromium build, but "the heap
   * after 100 opens is more than twice what it was after the first" is a leak on any of them.
   */
  test('opening and closing 100 conversations does not grow the heap without bound', async ({
    page,
  }) => {
    const client = await page.context().newCDPSession(page)
    await client.send('HeapProfiler.enable')

    async function heapBytes(): Promise<number> {
      await client.send('HeapProfiler.collectGarbage')
      const { metrics } = await client.send('Performance.getMetrics')
      return metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0
    }
    await client.send('Performance.enable')

    await login(page)
    await page.getByRole('treeitem', { name: new RegExp(LARGE_MAILBOX_NAME) }).click()
    await expect(messageList(page).getByRole('row').first()).toBeVisible({
      timeout: FIRST_WINDOW_MS,
    })

    await grid(page).click()
    const reply = page.getByRole('button', { name: 'Reply', exact: true })
    // One open/close first, so the baseline includes the reading pane's one-off cost (its chunk,
    // the sanitizer, the frame) rather than counting it as growth.
    await page.keyboard.press('o')
    await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await page.keyboard.press('u')
    await expect(reply).toBeHidden({ timeout: 30_000 })
    await expect(page).toHaveURL(FOLDER_URL, { timeout: 30_000 })
    const baseline = await heapBytes()

    for (let opened = 0; opened < 100; opened++) {
      // `j` then `o`, RETRIED as a unit. Sent back to back the two race the list's own re-render
      // after the previous message closed, and an `o` that lands mid-render is simply dropped — the
      // test then waits 30 s for a reading pane nobody asked to open, which looks exactly like the
      // app failing to open a message. Retrying the pair is honest here: the measurement is 100
      // mount/unmount cycles, and it does not care which message each one used.
      await page.keyboard.press('j')
      await page.keyboard.press('o')
      await expect(reply, `no reading pane on iteration ${opened}`).toBeVisible({ timeout: 30_000 })

      await page.keyboard.press('u')
      await expect(reply).toBeHidden({ timeout: 30_000 })
      // Wait for the ROUTE to be back on the folder before the next `j`. `u` navigates
      // asynchronously, and a `j`/`o` pair sent while the URL still names the open message is
      // dropped — the test then sits waiting for a reading pane nobody asked for, which reads
      // exactly like the app failing to open a message. (It died at iteration 5 that way.)
      //
      // Two preconditions that look right and are not: the grid holding DOM focus — measured, it
      // does not after `u`, and the chords keep working anyway because the dispatcher is
      // document-level — and the first row being visible, which is true throughout and so waits for
      // nothing at all.
      await expect(page).toHaveURL(FOLDER_URL, { timeout: 30_000 })
    }

    const after = await heapBytes()
    const ratio = after / baseline
    console.log(
      `[perf-large] heap: baseline ${Math.round(baseline / 1024)} KB → after 100 opens ${Math.round(
        after / 1024,
      )} KB (×${ratio.toFixed(2)})`,
    )

    expect(baseline, 'no baseline heap reading — the measurement is vacuous').toBeGreaterThan(0)
    expect(ratio).toBeLessThan(2)
  })
})
