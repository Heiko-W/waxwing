import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'

// M3.8 keyboard suite (FR-UI-04) — the WP's exit criterion, proven against the live Stalwart fixture:
// a FULL triage session without touching the mouse, plus the ⌘K palette and the `?` cheat-sheet.
// Runs under playwright.read.config.ts (it already seeds alice's inbox); `pnpm e2e:read`.

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })
const grid = (page: Page) => page.getByRole('grid', { name: 'Messages' })

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
 * The subject of the row the roving focus currently sits on (via aria-activedescendant).
 * Read the subject CELL, not the row: a row's text begins with the "Unread" badge and the
 * sender, so `innerText` would hand back "Unread" as its first line — never the subject.
 */
async function focusedRowSubject(page: Page): Promise<string> {
  const id = await grid(page).getAttribute('aria-activedescendant')
  expect(id).not.toBeNull()
  return (await page.locator(`[id="${id}"] [class*="subject"]`).innerText()).trim()
}

/** The subject of the row `x` actually ticked — read from the checked checkbox, not from the focus. */
async function selectedRowSubject(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const row = [...document.querySelectorAll('[role="row"]')].find(
      (r) => (r.querySelector('input[type=checkbox]') as HTMLInputElement | null)?.checked,
    )
    return row?.querySelector('[class*="subject"]')?.textContent?.trim() ?? null
  })
}

// Reseed before every test — the triage chords MOVE mail, so each test needs a fresh corpus.
test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('M3.8 keyboard shortcuts + command palette', () => {
  test('a full triage session without the mouse: j → o → e → auto-advance → u → x → #', async ({
    page,
  }) => {
    await login(page)

    // j/k rove the list (the grid keeps focus; aria-activedescendant moves).
    await page.keyboard.press('j')
    const opened = await focusedRowSubject(page)
    expect(opened).not.toBe('')

    // o opens the focused row into the reading pane.
    const heading = page.getByRole('heading', { level: 2 })
    await page.keyboard.press('o')
    await expect(heading).toHaveText(opened, { timeout: 20_000 })

    // e archives it: an Undo toast appears, the message leaves the Inbox list, and the reading
    // pane AUTO-ADVANCES to the NEXT message rather than sitting on a dead one. Without the
    // advance a mouse-free triage session stalls after every single archive.
    await page.keyboard.press('e')
    await expect(page.getByText('Moved to Archive')).toBeVisible({ timeout: 15_000 })
    await expect(heading).not.toHaveText(opened, { timeout: 15_000 })
    await expect(messageList(page).getByText(opened, { exact: true })).toBeHidden({
      timeout: 15_000,
    })

    // u in the READING scope is "back to the list" (in the list scope the same key marks unread).
    await page.keyboard.press('u')
    await expect(page).toHaveURL(/\/mail\/[^/]+$/, { timeout: 15_000 })

    // Back in the list: x selects the focused row, # moves it to Trash.
    const doomed = await focusedRowSubject(page)
    await page.keyboard.press('x')
    await expect(page.getByText('1 selected')).toBeVisible()
    // `x` must have ticked the row we just read. This is not paranoia: `advanceAfterTriage` used to
    // anchor the focus by INDEX, so the archive's prune could shift the rows between the read above
    // and this keypress — and then the assertion at the bottom would wait for a message nobody ever
    // trashed and blame the app for it. Asserting the link explicitly means a future drift fails HERE,
    // naming the real problem, instead of masquerading as "the trashed row never disappeared".
    expect(await selectedRowSubject(page)).toBe(doomed)
    await page.keyboard.press('#')
    // Address the toasts by their own title: they STACK, so the archive's Undo button from a few
    // lines up is still on screen and a bare `name: 'Undo'` would be ambiguous.
    const trashed = page.getByText('Moved to Trash')
    await expect(trashed).toBeVisible({ timeout: 15_000 })
    await expect(messageList(page).getByText(doomed, { exact: true })).toBeHidden({
      timeout: 15_000,
    })
  })

  test('an archive is UNDOable — and undo puts the message back in the list', async ({ page }) => {
    await login(page)
    await page.keyboard.press('j')
    const subject = await focusedRowSubject(page)

    await page.keyboard.press('e')
    await expect(messageList(page).getByText(subject, { exact: true })).toBeHidden({
      timeout: 15_000,
    })

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(messageList(page).getByText(subject, { exact: true })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('x selects, and the bulk bar acts on the selection', async ({ page }) => {
    await login(page)
    await page.keyboard.press('x')
    await expect(page.getByText('1 selected')).toBeVisible()
    await page.keyboard.press('j')
    await page.keyboard.press('x')
    await expect(page.getByText('2 selected')).toBeVisible()
  })

  test('r opens a reply seeded from the open message; Escape minimizes the draft (never loses it)', async ({
    page,
  }) => {
    await login(page)
    await page.getByText(READ_SUBJECTS.plain).click()
    // Reply is gated on the body being loaded — wait for the frame.
    await expect(
      page.frameLocator(`iframe[title="Message: ${READ_SUBJECTS.plain}"]`).locator('body'),
    ).toBeVisible({
      timeout: 20_000,
    })

    await page.keyboard.press('r')
    const subject = page.getByLabel('Subject', { exact: true })
    await expect(subject).toBeVisible({ timeout: 15_000 })
    await expect(subject).toHaveValue(new RegExp(`^Re: ${READ_SUBJECTS.plain}`))

    // Escape de-escalates the composer (docked → minimized); the draft survives as a chip.
    await page.getByRole('textbox', { name: 'Message body' }).click()
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('button', { name: new RegExp(`Re: ${READ_SUBJECTS.plain}`) }),
    ).toBeVisible()
  })

  test('⌘K palette jumps to a folder, and ranks it first on the next open (recents)', async ({
    page,
  }) => {
    await login(page)

    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()

    // The matcher is a SUBSEQUENCE match, so the query must be a subsequence of the label:
    // "arch" matches "Go to folder: Archive" (and the Archive action, and Search) — pick the
    // folder jump by its accessible name rather than by narrowing the query.
    await page.keyboard.type('arch')
    await expect(palette.getByRole('option').first()).toBeVisible()
    await palette
      .getByRole('option', { name: /Go to folder: Archive/ })
      .first()
      .click()
    await expect(page.getByRole('treeitem', { name: /Archive/, selected: true })).toBeVisible({
      timeout: 15_000,
    })

    // Reopen with an empty query: the last-run item leads, under "Recent".
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette).toBeVisible()
    await expect(palette.getByText('Recent')).toBeVisible()
    await expect(palette.getByRole('option').first()).toContainText('Archive')
  })

  test('? shows the cheat-sheet (generated from the registry); Escape closes it', async ({
    page,
  }) => {
    await login(page)
    await page.keyboard.press('?')

    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(sheet).toBeVisible()
    // The term carries the title AND its scope pill ("Archive" + "Message list · Reading pane"),
    // so match the <dt> by prefix — an exact-text match would find no element at all.
    await expect(sheet.locator('dt', { hasText: /^Archive/ }).first()).toBeVisible()
    await expect(sheet.locator('kbd', { hasText: /^E$/ }).first()).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })

  test('/ focuses the search box — and typing there never triages', async ({ page }) => {
    await login(page)
    await page.keyboard.press('/')

    const search = page.getByRole('searchbox', { name: 'Search' })
    await expect(search).toBeFocused()

    // The guard that IS the work package: `e` in a text field must not archive anything.
    await page.keyboard.type('e')
    await expect(search).toHaveValue('e')
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  })
})
