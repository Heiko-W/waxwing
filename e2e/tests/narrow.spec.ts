import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'

/**
 * The narrow (phone) layout — 390 × 844, touch, below both shell breakpoints.
 *
 * WHY THIS EXISTS. Of the nine Playwright configs in this directory, exactly one ran on a phone
 * viewport before this file: the swipe suite, which drives a gesture in the message list. axe,
 * target size, read, keyboard, settings and perf all run at 1280 × 720. So the narrow layout —
 * the one this project ships a "works on your phone" claim about — was never looked at by
 * anything, and it showed:
 *
 *   - the header measured 412 px against a 390 px viewport, so the account button sat off-screen
 *     on EVERY screen and the whole shell could be dragged sideways;
 *   - the remote-content banner gave its explanatory text ~40 px, one word per line, behind the
 *     buttons — the visible half of a privacy claim the README makes;
 *   - the search input rendered 18 px wide, too small for one character;
 *   - selecting a folder left the 80 vw drawer covering the list it had just loaded;
 *   - two composer buttons (minimise, restore) were inert on a phone by construction.
 *
 * Same structural blindness CONTRIBUTING.md describes for jsdom, one level up: a suite cannot
 * report what its viewport never renders. The generic assertion here is `noOverflow`, which would
 * have caught the first and third of those on the day they landed.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })
const folders = (page: Page) => page.getByRole('navigation', { name: 'Folders' })

test.beforeEach(async ({ page }) => {
  await seedReadMail()
  await page.goto('/')
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(messageList(page)).toBeVisible({ timeout: 30_000 })
})

/** Open the Inbox the way a phone user does: through the drawer. */
async function openInbox(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show folders' }).click()
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
}

/**
 * Nothing rendered may cross the viewport's edges.
 *
 * Measured over every element rather than a named few, because the defect this replaces was in the
 * header — a component no phone test would have thought to name. An element ENTIRELY outside is
 * fine and is how the closed drawer works (`transform: translateX(-100%)`); the failure is a box
 * that is partly on screen and partly not, which is what a cut-off control is.
 */
async function noOverflow(page: Page, where: string): Promise<void> {
  // Transitions move boxes. A rect read mid-slide is neither where it was nor where it is going.
  await page.waitForTimeout(400)
  const escaping = await page.evaluate(() => {
    window.scrollTo(0, 0)
    const w = window.innerWidth
    const out: string[] = []
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0')
        continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.right <= 0 || r.left >= w) continue // entirely off-canvas: by design
      if (r.right > w + 1 || r.left < -1) {
        const cls = typeof el.className === 'string' ? el.className.split(/\s+/)[0] : ''
        const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''
        out.push(
          `${el.tagName.toLowerCase()}.${cls} "${label}" [${Math.round(r.left)}…${Math.round(r.right)}]`,
        )
      }
    }
    return [...new Set(out)]
  })
  expect(escaping, `${where}: elements cross the 390px viewport edge`).toEqual([])
}

test('the shell fits the viewport on every screen', async ({ page }) => {
  await openInbox(page)
  await noOverflow(page, 'message list')

  await page.getByText(READ_SUBJECTS.newsletter, { exact: true }).click()
  await expect(page.getByRole('heading', { name: READ_SUBJECTS.newsletter })).toBeVisible()
  await noOverflow(page, 'reading')

  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await noOverflow(page, 'settings')

  await page.getByRole('link', { name: 'Contacts', exact: true }).click()
  await noOverflow(page, 'contacts')
})

test('the account name gives up its pixels but not its meaning', async ({ page }) => {
  // It is the one thing in the header that is not a control, and at 390 px it was ~180 px of the
  // 390 available — enough to push the account button off-screen. It is visually hidden here, NOT
  // removed: `display: none` would take it out of the accessibility tree as well, so a screen
  // reader user on a phone would lose which account they are in.
  const name = page.getByText(/Signed in as/)
  await expect(name).toHaveCount(1)
  const box = await name.boundingBox()
  expect(box?.width ?? 99, 'the account name still occupies header width').toBeLessThanOrEqual(1)
  await expect(name).toHaveText(/alice@waxwing\.test/)
})

test('the remote-content banner stays readable', async ({ page }) => {
  await openInbox(page)
  await page.getByText(READ_SUBJECTS.newsletter, { exact: true }).click()
  await expect(page.getByRole('heading', { name: READ_SUBJECTS.newsletter })).toBeVisible()

  const banner = page.getByRole('region', { name: 'Remote content blocked' })
  await expect(banner).toBeVisible()
  // The note explains WHY remote content is blocked. It shares a flex row with an action whose
  // width is the sender's display name — unbounded — so without wrapping it was squeezed to ~40 px
  // and broke one word per line. 150 px is well below comfortable and well above broken.
  const note = banner.getByText(/can track when you open/)
  const box = await note.boundingBox()
  expect(box?.width ?? 0, 'the privacy note is squeezed').toBeGreaterThan(150)
})

test('the search input is wide enough to type in', async ({ page }) => {
  await openInbox(page)
  // The scope select is `flex: none`, so before the field wrapped it took the row and left the
  // input 18 px — narrower than one character, and below the WCAG 2.2 target-size minimum.
  const box = await page.getByRole('searchbox', { name: 'Search' }).boundingBox()
  expect(box?.width ?? 0, 'the search input is collapsed').toBeGreaterThan(150)
})

test('choosing a folder closes the drawer', async ({ page }) => {
  await page.getByRole('button', { name: 'Show folders' }).click()
  await expect(folders(page)).toBeVisible()
  await page.getByRole('treeitem', { name: /Archive/ }).click()
  // Until this was wired up, Escape and the backdrop were the only ways out — so a tap on a folder
  // left the drawer (min(80vw, 18rem)) sitting on top of the list it had just loaded.
  await expect(folders(page), 'the drawer stayed open over the list').toBeHidden()
})

test('the composer offers no controls that do nothing here', async ({ page }) => {
  await openInbox(page)
  await page.getByRole('button', { name: 'New message', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Message body' })).toBeVisible({ timeout: 15_000 })

  // On a phone `fullscreen` is `tier === 'phone' || …` and `minimized` is `… && tier !== 'phone'`,
  // so both of these set a mode that is then ignored: the window did not move, and Restore
  // reported a state it could not leave. They are not rendered here any more.
  await expect(page.getByRole('button', { name: 'Minimize' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Full screen' })).toHaveCount(0)
  // The ones that do something are still there.
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible()

  // And the thing you came here to do has room. The editor used to stop at its 8rem minimum with
  // the rest of the full-screen window left blank below it — over half the screen on a phone.
  const editor = await page.getByRole('textbox', { name: 'Message body' }).boundingBox()
  const viewport = page.viewportSize()
  expect(editor?.height ?? 0, 'the editor does not fill the composer').toBeGreaterThan(
    (viewport?.height ?? 844) * 0.3,
  )

  await noOverflow(page, 'composing')
})
