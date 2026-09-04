import { expect, type Locator, type Page, test } from '@playwright/test'
import { READ_BULK, READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { revealPasswordForm, SYNC_BUDGET_MS } from './helpers'
import { noOverflow } from './no-overflow'

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

/**
 * The bulk folder's size as the reader sees it — grouped, because that is the point of asserting it
 * (`{{count, number}}`). en-US is what `playwright.read.config.ts` pins for every suite here, so the
 * separator is a comma; a bundle that stopped formatting would render "1200" and fail these.
 */
const GROUPED = READ_BULK.count.toLocaleString('en-US')

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })
const folders = (page: Page) => page.getByRole('navigation', { name: 'Folders' })

test.beforeEach(async ({ page }) => {
  await seedReadMail()
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(messageList(page)).toBeVisible({ timeout: SYNC_BUDGET_MS })
})

/** Open the Inbox the way a phone user does: through the drawer. */
async function openInbox(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show folders' }).click()
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })
}

/** Open a folder the way a phone user does: through the drawer. */
async function openFolder(page: Page, name: string, firstRow: string): Promise<void> {
  await page.getByRole('button', { name: 'Show folders' }).click()
  await page.getByRole('treeitem', { name: new RegExp(name) }).click()
  await expect(messageList(page).getByText(firstRow, { exact: true })).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })
}

/**
 * Select-all over a folder BIGGER than the loaded window, on a phone (FR-LST-04, R-08 stage 2).
 *
 * The bulk bar is where a second step is most likely to go wrong at this width: it does not wrap, it
 * hands its tail to an overflow menu sized by measuring the room the actions have left, and the
 * strings involved are the longest in it. So the step gets a ROW OF ITS OWN, and this measures the
 * three things that can go wrong with that at 390px: nothing crosses the viewport edge in either
 * state, the actions stay on one row, and the step really is BELOW the count rather than beside it.
 *
 * The numbers are asserted WITH their thousands separator ("1,200", en-US being what the config
 * pins). That is not decoration either: `{{count, number}}` is what puts it there, and a
 * three-digit folder could not tell the formatted number from the raw digits it replaced.
 *
 * That last assertion is the one holding the design in place, and it is deliberately not the
 * obvious one. "It does not overflow" cannot tell the two layouts apart: a step rendered INSIDE the
 * bar does not overflow either, because `useActionOverflow` absorbs it — by taking an action off the
 * bar and hiding it behind the ⋯. The bar copes and the reader pays, and no edge measurement sees
 * it. (Measured while writing this: the actions have 242px beside a "1 selected" counter and 199px
 * beside "50 of 60 selected", which is already one action behind the ⋯ — the counter's own cost,
 * from stage 1, and the reason a text button in that line is not affordable.)
 */
test('the second step of select-all fits a phone, in both of its states', async ({ page }) => {
  await openFolder(page, READ_BULK.folder, READ_BULK.subject(1))

  await messageList(page).getByRole('checkbox', { name: 'Select message' }).first().click()
  await expect(page.getByText('1 selected')).toBeVisible()
  expect(await actionRows(page), 'the actions start on one row').toBe(1)

  await page.getByRole('checkbox', { name: 'Select all' }).click()

  // The window is 50 of the folder's 1200, and the bar says both numbers (stage 1)…
  const partial = `50 of ${GROUPED} selected`
  await expect(page.getByText(partial)).toBeVisible()
  // …with the offer to close the gap beside it (stage 2), on its own row.
  const step = page.getByRole('button', { name: `Select all ${GROUPED}` })
  await expect(step).toBeVisible()
  await noOverflow(page, 'bulk bar offering the second step')
  expect(await actionRows(page), 'the actions stay on one row').toBe(1)
  await expectBelowTheCount(page, partial, step)

  await step.click()

  const whole = `${GROUPED} selected`
  await expect(page.getByText(whole, { exact: true })).toBeVisible()
  // The way back is as visible as the way in — same place, same size, same row.
  const back = page.getByRole('button', { name: 'Clear selection' })
  await expect(back).toBeVisible()
  await noOverflow(page, 'bulk bar over the whole folder')
  expect(await actionRows(page), 'the actions stay on one row').toBe(1)
  await expectBelowTheCount(page, whole, back)

  // And whatever the bar could not hold is still reachable, which is what makes "one row" honest.
  await page.getByRole('button', { name: 'More actions for the selection' }).click()
  const inMenu = await page
    .getByRole('menuitem')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''))
  const inBar = await barActionNames(page)
  for (const action of ['Archive', 'Move to Trash', 'Flag', 'Label', 'Mark as junk', 'Move to…']) {
    const reachable = inBar.includes(action) || inMenu.some((item) => item.startsWith(action))
    expect(reachable, `${action} is reachable somewhere`).toBe(true)
  }
})

/** The step sits on its own row under the counter, not in the line the actions are measured from. */
async function expectBelowTheCount(page: Page, countText: string, step: Locator): Promise<void> {
  const count = page.getByText(countText, { exact: true })
  const [countBox, stepBox] = await Promise.all([count.boundingBox(), step.boundingBox()])
  expect(stepBox?.y ?? 0, 'the step is beside the count, not under it').toBeGreaterThanOrEqual(
    (countBox?.y ?? 0) + (countBox?.height ?? 0),
  )
}

/** The bulk bar's action buttons — the ones drawn in the row, not the ones behind the ⋯. */
function barActions(page: Page) {
  return page.getByRole('button', {
    name: /^(Archive|Move to Trash|Mark as read|Mark as unread|Flag|Unflag|Label|Mark as junk)$/,
  })
}

/**
 * How many rows those actions occupy (1 = they all sit beside each other).
 *
 * The names are matched WHOLE. Unanchored, `/Archive/` also matches the folder drawer's "Folder
 * actions: Archive" and `/Label/` its "Label actions: wread" — off-canvas buttons at their own tops,
 * which made this read three rows where the bar has one, except when the measurement happened to
 * follow `noOverflow`'s 400 ms wait and the drawer had left the accessibility tree by then.
 */
async function actionRows(page: Page): Promise<number> {
  const tops = await barActions(page).evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
  )
  expect(tops.length, 'the bulk bar renders actions at all').toBeGreaterThan(0)
  return new Set(tops).size
}

async function barActionNames(page: Page): Promise<string[]> {
  return barActions(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label') ?? ''),
  )
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

test('the compose button belongs to the mail area, not to every screen (B50)', async ({ page }) => {
  // On this viewport the New-message button is a FIXED floating action button, so on a screen that
  // is not mail it did not merely offer the wrong action — it sat on top of the content. The shot
  // that found this (`phone-settings.webp`) has it covering the last row of the Settings list.
  //
  // The assertion runs in both directions on purpose: a button that is broken everywhere would pass
  // the "not on Settings" half on its own.
  const compose = page.getByRole('button', { name: 'New message', exact: true })
  await openInbox(page)
  await expect(compose).toBeVisible()

  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await expect(compose).toBeHidden()

  await page.getByRole('link', { name: 'Contacts', exact: true }).click()
  await expect(compose).toBeHidden()

  // Back where it belongs. `c` and ⌘N never stopped working on any of these screens — what went
  // away is a button, not the action.
  await page.getByRole('link', { name: 'Mail', exact: true }).click()
  await expect(compose).toBeVisible()
})

test('the account name gives up its pixels but not its meaning', async ({ page }) => {
  // It is the one thing in the header that is not a control, and at 390 px it was ~180 px of the
  // 390 available — enough to push the account button off-screen.
  //
  // The construction changed and this assertion outlived it, which is the point: the sentence is no
  // longer a visually-hidden copy of a visible span, it is now the ONLY carrier of that statement
  // (AccountMenu renders it in a `VisuallyHidden` on every viewport, with a separate `aria-hidden`
  // span showing just the address where there is room). What must hold either way is what is
  // written here — the meaning stays reachable, the pixels do not.
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

/**
 * The half the test above could not see.
 *
 * It picks ARCHIVE — a different folder from the open one — and for a long time that was the only
 * case exercised, because the close was inferred from a CHANGE in the selected mailbox. Tapping the
 * folder you are already in produces no change, so the effect returned early and the drawer stayed
 * up: no close button, Escape needing a keyboard, and 102 px of backdrop beside a full-height panel.
 * And it is the likeliest tap of all — you open the drawer to check where you are, see the
 * highlighted row, and touch it.
 */
test('re-choosing the folder already open closes the drawer too', async ({ page }) => {
  await openInbox(page)
  await page.getByRole('button', { name: 'Show folders' }).click()
  await expect(folders(page)).toBeVisible()

  const inbox = page.getByRole('treeitem', { name: /Inbox/ })
  await expect(inbox).toHaveAttribute('aria-selected', 'true')
  await inbox.click()

  await expect(folders(page), 'tapping the open folder left the drawer up').toBeHidden()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible()
})

/**
 * The drawer is an overlay, so it has to behave like one: focus goes in, Tab does not walk out
 * under the scrim, and there is a visible way to close it. Before, focus stayed on the toggle
 * BEHIND the drawer, and the first Tab landed in the search field the scrim was covering.
 */
test('the drawer takes focus and offers a way out', async ({ page }) => {
  await openInbox(page)
  await page.getByRole('button', { name: 'Show folders' }).click()
  await expect(folders(page)).toBeVisible()

  const insideDrawer = await page.evaluate(() => {
    const drawer = document.getElementById('waxwing-folder-region')
    return drawer?.contains(document.activeElement) === true
  })
  expect(insideDrawer, 'focus stayed outside the drawer it opened').toBe(true)

  // Scoped to the drawer: the BACKDROP carries the same accessible name (it is the other way to
  // dismiss), so an unscoped query is a strict-mode violation rather than a missing button.
  await folders(page).getByRole('button', { name: 'Hide folders' }).click()
  await expect(folders(page)).toBeHidden()
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

/**
 * Every settings section is reachable on a phone.
 *
 * The rail IS the screen here, and it is longer than 844px: fourteen destinations behind five group
 * captions. It carried `flex: 0 0 auto` from the two-column layout, where that pins its WIDTH —
 * above the panel it pinned its HEIGHT instead, so the box grew to fit its content, its own
 * `overflow-y: auto` had nothing to scroll, and `.page { overflow: hidden }` cut 146px off without
 * a scrollbar anywhere. "Offline & storage", "Server" and "About" were not below the fold; they
 * were outside the page box — `elementFromPoint` returned null over all three, and wheel events of
 * 300/600/1200/3000px moved nothing at all.
 *
 * The check is the one the reader would make: get to the bottom, then tap the last row.
 */
test('the settings list scrolls to its last section, and that section opens', async ({ page }) => {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()

  const rail = page.getByRole('navigation', { name: 'Settings' })
  const last = rail.getByRole('link', { name: 'About', exact: true })

  // It is in the DOM either way; the question is whether the viewport can ever contain it.
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport()

  // …and whether it is the element actually under that point, rather than something painted over
  // it. `click()` fails on an unhittable target, which is precisely the reported symptom.
  await last.click()
  await expect(page.getByRole('heading', { name: 'About', level: 1 })).toBeVisible()

  await noOverflow(page, 'settings — a section on a phone')
})

/**
 * Opening a section must not scroll its own way out off the top (G5).
 *
 * Focus follows the navigation into the `<section>`, which sits BELOW the "‹ Settings" link inside
 * the scrolling panel — so a plain `focus()` scrolled the panel to reveal it and pushed the link
 * out of the box. Measured at `detail.scrollTop: 60` for every section taller than the panel
 * (Vacation responder, Server), and 0 for the ones that fit. On a phone that link is the only route
 * back to the section list this screen offers, so the fix for "focus is nowhere" had cost the
 * screen its exit. jsdom lays nothing out and can only see the `preventScroll` option; this sees
 * the thing itself.
 */
test('a tall settings section still shows the way back to the list', async ({ page }) => {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  const rail = page.getByRole('navigation', { name: 'Settings' })
  await rail.getByRole('link', { name: 'Server', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Server', level: 1 })).toBeVisible()

  // The rail is unmounted on a phone once a section is open, so the only remaining link named
  // "Settings" inside <main> is the back link. In the viewport, not merely in the DOM: it was
  // always in the DOM.
  const back = page.locator('#main').getByRole('link', { name: 'Settings', exact: true })
  await expect(back).toBeInViewport()
})

/**
 * The section heading is set like the page title it now is (G6).
 *
 * The phone override lived inside the layout `@media` block two hundred lines ABOVE the base
 * `.sectionTitle` rule. A media query does not raise specificity and both are one class, so the
 * later rule won: every section opened at 18px, barely above the 17px labels under it, and the
 * intended 28px was dead code. A stylesheet test can see the ORDER; only a browser can see the
 * size, which is why this is here as well.
 */
test('a settings section on a phone opens at the size of a page title', async ({ page }) => {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  const list = page.getByRole('heading', { name: 'Settings', level: 1 })
  const listSize = await list.evaluate((el) => getComputedStyle(el).fontSize)

  const rail = page.getByRole('navigation', { name: 'Settings' })
  await rail.getByRole('link', { name: 'Compose', exact: true }).click()
  const section = page.getByRole('heading', { name: 'Compose', level: 1 })
  const sectionSize = await section.evaluate((el) => getComputedStyle(el).fontSize)

  // The claim is not "28px" — it is that both screens begin with a title, set the same way. That
  // survives a change to the type scale; a literal would have to be edited with it.
  expect(sectionSize, 'the detail screen is a screen and opens with its title').toBe(listSize)
})

/**
 * The phone's detail screen is a screen, and a screen begins at heading level 1.
 *
 * Opening a section REPLACES the rail, and the page's only `<h1>` — "Settings" — went with it. All
 * fourteen sections therefore started at level 2 with no level 1 anywhere on the page.
 */
test('a settings section on a phone has exactly one h1: its own name', async ({ page }) => {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  const rail = page.getByRole('navigation', { name: 'Settings' })
  await rail.getByRole('link', { name: 'Compose', exact: true }).click()

  const levelOnes = await page.getByRole('heading', { level: 1 }).allTextContents()
  expect(levelOnes, 'the open section names the screen').toEqual(['Compose'])
})

/**
 * Nothing floats on the bottom navigation bar — and `--waxwing-bottom-bar` is a real number.
 *
 * Three elements are pinned to the bottom of a phone viewport: the compose button, the toast
 * region and the outbox strip. Only the first one cleared the bar; the other two were docked to
 * the viewport edge, i.e. ON it. `.region` is `pointer-events: none`, `.toast` is not — so the tap
 * meant for a tab was swallowed by the toast lying over it. ADR-021 is what makes that more than a
 * nuisance: a toast carrying an action gets `duration: 0` and waits, so after archiving a message
 * the reader's way out of the screen stayed covered until they found the thing covering it.
 *
 * The second half is the one that cannot be checked anywhere else. `--waxwing-bottom-bar` is a
 * CONSTANT (3.75rem) standing in for the height of a bar that is laid out from an icon, a label
 * and two paddings — so it is only honest while something compares it to the real thing. This is
 * that something. A hidden `title` on the nav items, a larger icon or a second line of German
 * would grow the bar past the constant, and every floating element would quietly sit on it again.
 */
test('nothing floats on the bottom navigation bar', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Primary navigation' })
  await expect(nav).toBeVisible()

  const measured = await page.evaluate(() => {
    const bar = document.querySelector('nav[aria-label="Primary navigation"]')
    const toast = document.querySelector('section[aria-label="Status messages"]')
    // The token, resolved to pixels the way the browser resolves it — `3.75rem` is a string until
    // something lays it out.
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;visibility:hidden;block-size:var(--waxwing-bottom-bar)'
    document.body.append(probe)
    const token = probe.getBoundingClientRect().height
    probe.remove()
    return {
      token,
      barTop: bar?.getBoundingClientRect().top ?? 0,
      barHeight: bar?.getBoundingClientRect().height ?? 0,
      toastBottom: toast?.getBoundingClientRect().bottom ?? 0,
    }
  })

  // The bar really is at the bottom on this viewport (guards the whole test going vacuous if the
  // rail ever moves to the side here).
  expect(measured.barHeight).toBeGreaterThan(0)
  expect(
    measured.token,
    `--waxwing-bottom-bar is ${measured.token}px, the bar measures ${measured.barHeight}px`,
  ).toBeGreaterThanOrEqual(measured.barHeight)

  // And the region that would hold an undo toast is clear of it.
  expect(
    measured.toastBottom,
    `the toast region ends at ${measured.toastBottom}px, the bar starts at ${measured.barTop}px`,
  ).toBeLessThanOrEqual(measured.barTop)
})
