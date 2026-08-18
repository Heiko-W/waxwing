import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'

/**
 * M3.9 step 5 — swipe gestures on touch (FR-LST-06), against the live Stalwart fixture.
 *
 * This suite exists for the things the unit tests are STRUCTURALLY unable to see. jsdom computes no
 * CSS, so it cannot tell whether `touch-action: pan-y` reached the right element, whether the reveal
 * layer has a colour, or whether the transform actually moves the row — and this project has twice
 * shipped CSS defects that every test, the typechecker, Biome and axe all agreed were fine (gap B5:
 * the message list had no selected-row highlight for three milestones because two custom properties
 * were referenced but never defined, so they computed to `transparent`).
 *
 * Playwright has no swipe primitive and `page.touchscreen` only taps, so the gestures are driven
 * through CDP `Input.dispatchTouchEvent` — genuinely trusted input, which is also the only way the
 * browser's own scroll disambiguation is exercised.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()

  // This viewport is a phone, so the shell is single-pane (FR-UI-03): the folder tree lives behind
  // a disclosure instead of beside the list, which is why this suite cannot reuse read.spec's
  // desktop login. Opening it is part of the touch story, not incidental setup.
  const showFolders = page.getByRole('button', { name: 'Show folders' })
  await expect(showFolders).toBeVisible({ timeout: 30_000 })
  await showFolders.click()
  await page.getByRole('treeitem', { name: /Inbox/ }).click()

  // Picking a folder does not close the drawer, and on a phone it covers 288 px of a 390 px screen
  // at z-index 15 — so every touch aimed at a row lands on the drawer instead. Closing it is not
  // test hygiene: this suite's first run failed for exactly this reason, and the two
  // "nothing happened" assertions went green while no gesture was reaching the list at all.
  // Escape rather than the backdrop button: the backdrop spans the whole screen, so a click at its
  // centre is intercepted by the drawer sitting on top of it (MailScreen.tsx:159-172).
  await page.keyboard.press('Escape')
  await expect(page.locator('nav[aria-label="Folders"]')).not.toHaveClass(/folderRegionOpen/)

  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
  // Nothing may overlay the row the gestures target, or a "nothing happened" assertion below would
  // pass for the wrong reason.
  const list = messageList(page)
  await expect(list.getByText(READ_SUBJECTS.plain)).toBeInViewport()
}

/** The row wrapper that owns both `onPointerDown` and `draggable` — the swipe's element. */
function rowWrap(page: Page, subject: string) {
  return page.getByRole('row').filter({ hasText: subject }).locator('xpath=..')
}

/**
 * Drag a finger across an element. Steps the move so the axis lock sees a real trajectory rather
 * than one teleporting delta, exactly as a finger would.
 */
async function touchDrag(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  { dx, dy = 0, steps = 12 }: { dx: number; dy?: number; steps?: number },
): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const point = (px: number, py: number) => [{ x: px, y: py, radiusX: 12, radiusY: 12, force: 1 }]

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: point(x + (dx * i) / steps, y + (dy * i) / steps),
    })
    await page.waitForTimeout(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

async function swipeRow(
  page: Page,
  subject: string,
  // Mirrors `touchDrag`'s options exactly — `opts` is forwarded whole, so a narrower type here only
  // rejects calls the helper already handles (`steps` was passed at runtime but failed to compile).
  opts: { dx: number; dy?: number; steps?: number },
): Promise<void> {
  const box = await rowWrap(page, subject).boundingBox()
  if (box === null) throw new Error(`row "${subject}" has no box`)
  await touchDrag(page, box, opts)
}

test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('M3.9 swipe gestures (touch)', () => {
  test('swiping left archives the row, with an Undo', async ({ page }) => {
    await login(page)
    const list = messageList(page)
    await expect(list.getByText(READ_SUBJECTS.plain)).toBeVisible()

    await swipeRow(page, READ_SUBJECTS.plain, { dx: -220 })

    // The move round-trips through the outbox and prunes the Inbox window.
    await expect(list.getByText(READ_SUBJECTS.plain)).toBeHidden({ timeout: 15_000 })
    // Destructive without confirmation is only defensible because Undo is the safety net.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(list.getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 15_000 })
  })

  test('swiping right toggles read state', async ({ page }) => {
    await login(page)
    const row = page.getByRole('row').filter({ hasText: READ_SUBJECTS.plain })
    // Assert on what a screen reader actually hears, not on the CSS class: unread is announced by a
    // VisuallyHidden "Unread" inside the dot (MessageRow.tsx), and the row carries no aria-label.
    const unreadMark = row.getByText('Unread', { exact: true })
    await expect(unreadMark).toBeAttached()

    await swipeRow(page, READ_SUBJECTS.plain, { dx: 220 })
    await expect(unreadMark).not.toBeAttached({ timeout: 15_000 })

    // …and back: the action is a toggle, not a one-way "mark read" (D2).
    await swipeRow(page, READ_SUBJECTS.plain, { dx: 220 })
    await expect(unreadMark).toBeAttached({ timeout: 15_000 })
  })

  test('a short swipe rubber-bands and does nothing', async ({ page }) => {
    await login(page)
    const list = messageList(page)

    await swipeRow(page, READ_SUBJECTS.plain, { dx: -40 })

    await page.waitForTimeout(500)
    await expect(list.getByText(READ_SUBJECTS.plain)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden()
    // The row returned to rest rather than staying parked open (commit-only, no iOS "peek").
    const offset = await rowWrap(page, READ_SUBJECTS.plain).evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--swipe-x').trim(),
    )
    expect(offset === '' || offset === '0px').toBe(true)

    // POSITIVE CONTROL. Without it this test passes just as happily when the gesture is wired to
    // nothing at all — which is precisely what happened on this suite's first run, where an overlay
    // swallowed every touch and the "nothing happened" tests went green.
    await swipeRow(page, READ_SUBJECTS.plain, { dx: -220 })
    await expect(list.getByText(READ_SUBJECTS.plain)).toBeHidden({ timeout: 15_000 })
  })

  test('a vertical drag scrolls and never triages — the axis lock in a real browser', async ({
    page,
  }) => {
    await login(page)
    const list = messageList(page)

    // Straight down the screen: the browser owns this gesture via `touch-action: pan-y` and fires
    // pointercancel at us. jsdom cannot test this at all — it computes no CSS.
    await swipeRow(page, READ_SUBJECTS.plain, { dx: 0, dy: -300, steps: 15 })

    await page.waitForTimeout(500)
    await expect(list.getByText(READ_SUBJECTS.plain)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden()

    // POSITIVE CONTROL — see the short-swipe test. An absence assertion with no proof that the
    // harness could have observed a presence is worth nothing.
    await swipeRow(page, READ_SUBJECTS.plain, { dx: -220 })
    await expect(list.getByText(READ_SUBJECTS.plain)).toBeHidden({ timeout: 15_000 })
  })

  test('the gesture CSS is real: touch-action, the transform, and a coloured layer', async ({
    page,
  }) => {
    await login(page)
    const wrap = rowWrap(page, READ_SUBJECTS.plain)

    // 1. touch-action must be on the element the finger lands on. If it is missing or on the wrong
    //    node, vertical scrolling of the list breaks on device and every unit test still passes.
    //    It must ALSO still permit pinch-zoom: the grammar is `[pan-x || pan-y || pinch-zoom]`, so
    //    what is not named is disabled, and `.rowWrap` tiles the whole list — a bare `pan-y` turns
    //    the app's primary surface into a zoom-dead zone for low-vision users (WCAG 1.4.4) while
    //    index.html deliberately preserves zoom everywhere else. `pan-x` must stay OUT, or the
    //    browser would claim horizontal panning and the swipe would never lock.
    const touchAction = await wrap.evaluate((el) => getComputedStyle(el).touchAction)
    expect(touchAction).toContain('pan-y')
    expect(touchAction).toContain('pinch-zoom')
    expect(touchAction).not.toContain('pan-x')
    // 2. The wrapper must clip, or a right-swipe extends scrollWidth on two overflow:auto ancestors
    //    and puts a horizontal scrollbar on the grid.
    await expect(wrap).toHaveCSS('overflow-x', 'hidden')

    // 3. The reveal layer must actually have a colour. This is the B5 failure mode verbatim: a
    //    mistyped token name computes to `transparent` and ships, invisible to tsc, Biome, axe and
    //    every unit test. Measured mid-gesture, in the browser, from the real cascade.
    const box = await wrap.boundingBox()
    if (box === null) throw new Error('no box')
    const cdp = await page.context().newCDPSession(page)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const point = (px: number) => [{ x: px, y, radiusX: 12, radiusY: 12, force: 1 }]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x) })
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: point(x - (120 * i) / 8),
      })
      await page.waitForTimeout(16)
    }

    const mid = await wrap.evaluate((el) => {
      const style = getComputedStyle(el)
      const row = el.querySelector('[role="row"]') as HTMLElement | null
      // The layer is the only child that is not the row itself and carries a painted background.
      const layers = [...el.children]
        .filter((child) => child !== row)
        .map((child) => {
          const cs = getComputedStyle(child as HTMLElement)
          return { background: cs.backgroundColor, width: (child as HTMLElement).offsetWidth }
        })
      return {
        swipeX: style.getPropertyValue('--swipe-x').trim(),
        rowTransform: row === null ? '' : getComputedStyle(row).transform,
        layers,
      }
    })

    // The custom property is being written, and the row is genuinely translated by it.
    expect(mid.swipeX).not.toBe('')
    expect(Number.parseFloat(mid.swipeX)).toBeLessThan(-10)
    expect(mid.rowTransform).not.toBe('none')

    const painted = mid.layers.filter(
      (l) => l.width > 0 && l.background !== 'rgba(0, 0, 0, 0)' && l.background !== 'transparent',
    )
    expect(
      painted.length,
      `no revealed layer had both width and a background colour — this is exactly how the ` +
        `selected-row highlight silently vanished for three milestones (gap B5). Layers seen: ` +
        JSON.stringify(mid.layers),
    ).toBeGreaterThan(0)

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  })
})
