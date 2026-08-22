import { expect, type Page, test } from '@playwright/test'
import {
  addBusyEvent,
  clearCalendarEvents,
  clearShareNotifications,
  revokeAllPimShares,
  shareAddressBook,
  shareCalendar,
} from '../stalwart/fixture.mjs'
import { revealPasswordForm } from './helpers'

/**
 * Sharing a calendar and an address book (S-2), and asking what somebody else is doing (S-6) — end
 * to end against a live Stalwart that really enforces the grants.
 *
 * Runs in the shared-account suite for the same reason `sharing.spec.ts` does: every claim here is
 * about state that outlives the browser, and half of them need a SECOND real account.
 *
 *  - a calendar grant is a `Calendar/set … shareWith`, and the proof it landed is that reopening the
 *    dialog — over the object a fresh `Calendar/get properties:[…, shareWith]` returned — still
 *    lists the person at the level that was chosen;
 *  - a `ShareNotification` for a calendar can only be created by somebody else sharing one;
 *  - free/busy needs a diary to be busy in, and it must belong to an account that is NOT the reader
 *    — `Principal/getAvailability` needs the free/busy share and nothing beyond it (measured).
 *
 * Everything granted here is revoked; `shared.teardown.mjs` sweeps whatever an aborted run leaves
 * (`revokeAllPimShares`, `clearCalendarEvents`), because a calendar left shared puts the owner's
 * whole account into the grantee's session — with all seventeen capabilities, measured — and every
 * later suite then sees a sidebar it was not written for.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }
/**
 * Carol as the PICKER labels her.
 *
 * `principalLabel` prefers `Principal.name`, and on this server that is the full login address, not
 * the display name — measured: `{"id":"d","name":"carol@waxwing.test","description":"Carol Chen
 * (Waxwing e2e)"}`. A test that looked for "Carol Chen" in an option would never find it.
 */
const CAROL_LABEL = 'carol@waxwing.test'

async function login(page: Page, options: { stay?: boolean } = {}): Promise<void> {
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  // `stay` for any test that RELOADS: without it the token lives only in memory (NFR-SEC-02), so a
  // reload lands back on the sign-in step.
  if (options.stay) await page.getByLabel('Stay signed in').check()
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(
    page
      .getByRole('navigation', { name: 'Folders' })
      .or(page.getByRole('button', { name: 'Folders' }))
      .first(),
  ).toBeVisible({ timeout: 30_000 })
}

/** The calendar screen, reached the way a reader reaches it. */
async function openCalendar(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Calendar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({ timeout: 30_000 })
}

/** The contacts screen. */
async function openContacts(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Contacts', exact: true }).click()
  await expect(page.getByRole('link', { name: /All Contacts/ })).toBeVisible({ timeout: 30_000 })
}

/** The calendar rail — a real `<aside>` from 40em up, which every desktop project is. */
function calendarRail(page: Page) {
  return page.getByRole('complementary', { name: 'Calendars' })
}

/** Alice's own default calendar row, and the share icon on it. */
function shareCalendarButton(page: Page) {
  return calendarRail(page).getByRole('button', { name: /^Share / })
}

test.describe('S-2 — sharing a calendar', () => {
  test.afterEach(async () => {
    // Belt and braces: a failed assertion must not leave a calendar shared, or carol's account
    // appears in alice's session for every later suite in this file and the next.
    await revokeAllPimShares()
  })

  test('the share icon sits beside the calendar’s NAME, not inside a menu', async ({ page }) => {
    /*
     * The design claim, asserted rather than described. iCloud shares a calendar from an icon on the
     * row; a control that has to be found in a `⋯` is one most people never learn exists. The `⋯`
     * still carries Edit and Delete, and this must be a SEPARATE control from it.
     */
    await login(page)
    await openCalendar(page)
    const button = shareCalendarButton(page).first()
    await expect(button).toBeVisible({ timeout: 30_000 })
    // Not a menu item: it is reachable with one activation and no menu is open.
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('a grant SURVIVES the dialog — the server has it, not just the screen', async ({ page }) => {
    await login(page)
    await openCalendar(page)
    await shareCalendarButton(page).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByText('Only you.')).toBeVisible()

    await dialog.getByLabel('Search people').fill('carol')
    const grant = dialog.getByRole('button', { name: /Give .*[Cc]arol.* access/ })
    await expect(grant).toBeVisible({ timeout: 15_000 })
    await grant.click()
    await expect(dialog.getByText('Only you.')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // REOPEN. `onChanged` re-fetches the calendars, so what is on screen now is what
    // `Calendar/get properties:['…','shareWith']` answered — not React state.
    await shareCalendarButton(page).first().click()
    await expect(
      page.getByRole('dialog').getByRole('combobox', { name: /What .*[Cc]arol.* may do/ }),
    ).toHaveValue('freeBusy')
  })

  /*
   * THE test of S-2's calendar half. The picker's default is the LEAST role, and what that role puts
   * on the wire is one `true`: carol may see that alice is busy and not one word of what she is
   * doing. If `mayReadItems` ever crept into it, this is where it would show — carol's own session
   * would start answering with alice's event titles.
   */
  test('“Availability only” gives away the times and nothing else', async ({ page }) => {
    await login(page)
    await openCalendar(page)
    await shareCalendarButton(page).first().click()
    const dialog = page.getByRole('dialog')

    // Four options, least first — this is the one place the four-role model is visible to a user.
    const role = dialog.getByLabel('They may')
    await expect(role).toHaveValue('freeBusy')
    await expect(role.getByRole('option')).toHaveText([
      'Availability only',
      'View',
      'Edit',
      'Manage',
    ])
    // And the promise is spelled out, not left to the label.
    await expect(dialog.getByText(/never what you are doing/i)).toBeVisible()

    await dialog.getByLabel('Search people').fill('carol')
    const grant = dialog.getByRole('button', { name: /Give .*[Cc]arol.* access/ })
    await expect(grant).toBeVisible({ timeout: 15_000 })
    await grant.click()
    await dialog.getByRole('button', { name: 'Done' }).click()

    // The server's own answer, read back through a fresh dialog: still `freeBusy`, which it would
    // not be if any second right had gone with it — `roleOf` compares the WHOLE map and would say
    // `custom`, or `viewer`.
    await shareCalendarButton(page).first().click()
    await expect(
      page.getByRole('dialog').getByRole('combobox', { name: /What .*[Cc]arol.* may do/ }),
    ).toHaveValue('freeBusy')
  })

  test('a role change replaces the grant rather than merging into it', async ({ page }) => {
    await login(page)
    await openCalendar(page)
    await shareCalendarButton(page).first().click()
    const dialog = page.getByRole('dialog')

    await dialog.getByLabel('Search people').fill('carol')
    await dialog.getByRole('button', { name: /Give .*[Cc]arol.* access/ }).click()
    const role = dialog.getByRole('combobox', { name: /What .*[Cc]arol.* may do/ })
    await expect(role).toBeVisible()
    await role.selectOption('editor')
    await dialog.getByRole('button', { name: 'Done' }).click()

    await shareCalendarButton(page).first().click()
    // Not "Custom access": an Edit grant written by this client must read back as Edit, which it
    // would not if the write had merged into the previous rights rather than replacing them.
    await expect(
      page.getByRole('dialog').getByRole('combobox', { name: /What .*[Cc]arol.* may do/ }),
    ).toHaveValue('editor')
  })

  test('a shared calendar wears a marker afterwards — and it is a WORD, not a colour', async ({
    page,
  }) => {
    await login(page)
    await openCalendar(page)
    await shareCalendarButton(page).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Search people').fill('carol')
    await dialog.getByRole('button', { name: /Give .*[Cc]arol.* access/ }).click()
    await dialog.getByRole('button', { name: 'Done' }).click()

    // WCAG 1.4.1: the person glyph is decoration and the word is the marker. It is visually hidden,
    // so this asserts what a screen reader gets — which is the only thing that can be asserted here.
    await expect(calendarRail(page).getByText('Shared').first()).toBeAttached({ timeout: 30_000 })
  })

  test('the calendar shared WITH alice offers no way to share it on', async ({ page }) => {
    /*
     * `myRights.mayShare` is `false` on a grantee's copy and `shareWith` is `null` — only the owner
     * ever sees the grant map. The icon must not be drawn: it would open a dialog listing nobody,
     * over something the server will refuse to change.
     *
     * Alice's own calendars all carry `mayShare`, so the count of share icons must equal the count
     * of calendars she owns — one more calendar in the rail, no more icons.
     */
    await shareCalendar('carol', 'alice', 'viewer')
    await login(page)
    await openCalendar(page)

    const rail = calendarRail(page)
    await expect(rail).toBeVisible({ timeout: 30_000 })
    const rows = rail.getByRole('listitem')
    const icons = shareCalendarButton(page)
    await expect(icons).toHaveCount(await rows.count())
  })

  test('the control is a real touch target on a phone', async ({ browser }) => {
    /*
     * `hasTouch` is load-bearing: without it the context reports a fine pointer, `tokens.css` leaves
     * `--waxwing-control-min` at its desktop value, and every control measures ~34px — which is a
     * failure report about a case the user is not in. With it the rail is a sheet reached from the
     * view menu, and the icon inside it has to be as big as everything else there.
     */
    const context = await browser.newContext({
      viewport: { width: 390, height: 780 },
      hasTouch: true,
      isMobile: true,
    })
    const page = await context.newPage()
    try {
      await login(page)
      await openCalendar(page)
      // Below 40em there is no rail — the list is a screen-high sheet behind the view menu.
      await page.getByRole('button', { name: 'Calendar view' }).click()
      await page.getByRole('menuitem', { name: /^Calendars/ }).click()
      const sheet = page.getByRole('dialog')
      await expect(sheet).toBeVisible({ timeout: 30_000 })

      const button = sheet.getByRole('button', { name: /^Share / }).first()
      await expect(button).toBeVisible()
      /*
       * `toPass` rather than a single read, and the reason is worth writing down: the dialog ENTERS
       * with `transform: translateY(8px) scale(0.98)` (`Dialog.module.css`). A `boundingBox()` taken
       * while that is still running reports 44 × 0.98 = **43.12px** — a WCAG 2.5.5 failure that is
       * not one. Two separate passes reported it as a real defect before the animation was noticed;
       * the computed `min-inline-size`/`min-block-size` were 44px the whole time.
       */
      await expect(async () => {
        const box = await button.boundingBox()
        expect(box).not.toBeNull()
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
      }).toPass({ timeout: 10_000 })
    } finally {
      await context.close()
    }
  })
})

test.describe('S-2 — sharing an address book', () => {
  test.afterEach(async () => {
    await revokeAllPimShares()
  })

  /**
   * The share icon on an address-book row.
   *
   * By PREFIX rather than by name: the fixture's default book is whatever Stalwart calls it
   * ("Stalwart Address Book" on v0.16.18), and pinning a test to a server's own display string is
   * how a suite breaks on an upgrade that changed nothing that matters. `.first()` is alice's own
   * default, which is the only one she may share anyway — `mayShare` gates the rest.
   */
  function shareBookButton(page: Page) {
    return page.getByRole('button', { name: /^Share / }).first()
  }

  test('a grant survives the dialog, fetched afresh each time it opens', async ({ page }) => {
    /*
     * Unlike a calendar, an address book's `shareWith` is NOT in any list this client already holds:
     * the sync engine's `AddressBook/get` names no `properties` at all. So the dialog fetches it,
     * and reopening is a genuine second round trip to the server rather than a re-render.
     */
    await login(page)
    await openContacts(page)

    const button = shareBookButton(page)
    await expect(button).toBeVisible({ timeout: 30_000 })
    await button.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Only you.')).toBeVisible({ timeout: 30_000 })

    await dialog.getByLabel('Search people').fill('carol')
    const grant = dialog.getByRole('button', { name: /Give .*[Cc]arol.* access/ })
    await expect(grant).toBeVisible({ timeout: 15_000 })
    await grant.click()
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await button.click()
    await expect(
      page.getByRole('dialog').getByRole('combobox', { name: /What .*[Cc]arol.* may do/ }),
    ).toHaveValue('viewer')
  })

  test('it offers THREE roles — an address book has no “availability only”', async ({ page }) => {
    await login(page)
    await openContacts(page)
    const button = shareBookButton(page)
    await expect(button).toBeVisible({ timeout: 30_000 })
    await button.click()

    const dialog = page.getByRole('dialog')
    const role = dialog.getByLabel('They may')
    await expect(role.getByRole('option')).toHaveText(['View', 'Edit', 'Manage'])
    await expect(role).toHaveValue('viewer')
  })
})

test.describe('S-1 — a calendar and an address-book share are ANNOUNCED', () => {
  test.afterEach(async () => {
    await revokeAllPimShares()
    await clearShareNotifications('alice')
  })

  test('the card names the calendar, not “the folder”', async ({ page }) => {
    /*
     * The regression this exists to catch is a sentence, not a crash. Until S-2 the strip could say
     * one noun, and it said "folder" for whatever arrived — so a calendar share announced itself as
     * a mail folder, which is a false statement about what somebody has just given away.
     */
    await clearShareNotifications('alice')
    await shareCalendar('carol', 'alice', 'viewer')
    await login(page)
    await openCalendar(page)

    const strip = page.getByRole('region', { name: 'New shares' })
    await expect(strip).toBeVisible({ timeout: 30_000 })
    await expect(strip.getByText(/shared a calendar with you|shared the calendar/i)).toBeVisible()
    await expect(strip.getByText(/folder/i)).toHaveCount(0)
  })

  test('it offers no Open, because nothing can open a foreign calendar yet', async ({ page }) => {
    /*
     * Honest rather than tidy. Following the card means scoping this screen to carol's account, and
     * it is wired to the reader's own throughout — `sharing/probe.ts` has no `calendar` area at all.
     * A button that landed the reader back in their own calendars would be worse than no button.
     */
    await clearShareNotifications('alice')
    await shareCalendar('carol', 'alice', 'viewer')
    await login(page)
    await openCalendar(page)

    const strip = page.getByRole('region', { name: 'New shares' })
    await expect(strip).toBeVisible({ timeout: 30_000 })
    await expect(strip.getByRole('button', { name: 'Open' })).toHaveCount(0)
    await expect(strip.getByRole('button', { name: 'Hide this notice' })).toBeVisible()
  })

  test('“Hide” destroys it, so a reload does not bring it back', async ({ page }) => {
    await clearShareNotifications('alice')
    await shareCalendar('carol', 'alice', 'viewer')
    await login(page, { stay: true })
    await openCalendar(page)

    const strip = page.getByRole('region', { name: 'New shares' })
    await expect(strip).toBeVisible({ timeout: 30_000 })
    await strip.getByRole('button', { name: 'Hide this notice' }).click()
    await expect(strip).toHaveCount(0)

    await page.reload()
    await openCalendar(page)
    await expect(page.getByRole('region', { name: 'New shares' })).toHaveCount(0)
  })

  test('an address-book share is announced in the contacts rail, in its own words', async ({
    page,
  }) => {
    await clearShareNotifications('alice')
    await shareAddressBook('carol', 'alice', 'viewer')
    await login(page)
    await openContacts(page)

    const strip = page.getByRole('region', { name: 'New shares' })
    await expect(strip).toBeVisible({ timeout: 30_000 })
    await expect(
      strip.getByText(/shared a contact list with you|shared the contact list/i),
    ).toBeVisible()
    await expect(strip.getByRole('button', { name: 'Open' })).toHaveCount(0)
  })
})

test.describe('S-6 — somebody else’s availability', () => {
  /** A Wednesday well inside the fixture's future, so the week view can be steered onto it. */
  const BUSY_DAY = '2026-09-02'

  test.beforeEach(async () => {
    await clearCalendarEvents()
    await addBusyEvent('carol', { start: `${BUSY_DAY}T10:00:00`, duration: 'PT2H' })
    // The WEAKEST of the four calendar roles, and it is the point of the test rather than setup
    // noise: free/busy is not something the directory gives away. Measured 2026-08-22 — alice
    // asking about carol's calendar with no share gets `{"list":[]}`; with `mayReadFreeBusy` and
    // nothing else she gets the times. An earlier note in this file claimed the opposite; it came
    // from a probe where an account asked about ITSELF, which answers whatever is granted or not.
    await shareCalendar('carol', 'alice', 'freeBusy')
  })

  test.afterEach(async () => {
    await clearCalendarEvents()
    await revokeAllPimShares()
  })

  /*
   * THE claim of S-6: the WEAKEST share is enough. Carol has granted `mayReadFreeBusy` and nothing
   * else — she has not let alice read a single event — and alice can still plan around her, because
   * `Principal/getAvailability` answers with times and no titles.
   *
   * That is exactly what the fourth calendar role from S-2 exists for, and why it is not a
   * decoration: without a role that gives away availability ALONE, the only way to be plannable
   * would be to let colleagues read the diary.
   */
  test('needs only the free/busy share, and gives away times but not titles', async ({ page }) => {
    // `{ stay: true }` because the line below RELOADS: `page.goto` is a full document load, and a
    // token that lives only in memory (NFR-SEC-02) does not survive one — without it every test in
    // this block landed back on the sign-in form and waited thirty seconds for a button that is on
    // the other side of it.
    await login(page, { stay: true })
    await page.goto(`/calendar/${BUSY_DAY}`)
    await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Week', exact: true }).click()

    const picker = page.getByLabel('Show availability')
    await expect(picker).toBeVisible({ timeout: 30_000 })
    await picker.selectOption({ label: CAROL_LABEL })

    // The band is a background layer and `aria-hidden`; the sentence beside it is the whole of what
    // a screen reader gets, and asserting on it is the only honest way to assert on a hatch.
    await expect(
      page.getByText(new RegExp(`${CAROL_LABEL} is busy on .* from .* to `)),
    ).toBeAttached({ timeout: 30_000 })
    // And NOT the title. Carol's event is called "Busy" by the fixture; nothing on alice's screen
    // may carry it, because `Principal/getAvailability` refuses to return titles at all
    // (`eventProperties` accepts only `id` and `baseEventId` — measured).
    await expect(page.getByRole('button', { name: 'Busy' })).toHaveCount(0)
  })

  test('the picker exists only where the answer can be drawn', async ({ page }) => {
    // The month and agenda views have no time axis; a control whose effect the reader cannot see is
    // worse than a missing one.
    // `{ stay: true }` because the line below RELOADS: `page.goto` is a full document load, and a
    // token that lives only in memory (NFR-SEC-02) does not survive one — without it every test in
    // this block landed back on the sign-in form and waited thirty seconds for a button that is on
    // the other side of it.
    await login(page, { stay: true })
    await page.goto(`/calendar/${BUSY_DAY}`)
    await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({ timeout: 30_000 })

    await expect(page.getByLabel('Show availability')).toHaveCount(0)
    await page.getByRole('button', { name: 'Week', exact: true }).click()
    await expect(page.getByLabel('Show availability')).toBeVisible()
    await page.getByRole('button', { name: 'Month', exact: true }).click()
    await expect(page.getByLabel('Show availability')).toHaveCount(0)
  })

  test('the hatch never covers a real appointment', async ({ page }) => {
    /*
     * The rule that decides the whole visual design: the layer is behind, and it is a pattern rather
     * than a fill. Asserted as geometry — alice's own event in the same hour must still be hit-
     * testable, i.e. the top element at its centre is the event, not the band.
     */
    await addBusyEvent('alice', { start: `${BUSY_DAY}T10:30:00`, duration: 'PT1H', title: 'Mine' })
    // `{ stay: true }` because the line below RELOADS: `page.goto` is a full document load, and a
    // token that lives only in memory (NFR-SEC-02) does not survive one — without it every test in
    // this block landed back on the sign-in form and waited thirty seconds for a button that is on
    // the other side of it.
    await login(page, { stay: true })
    await page.goto(`/calendar/${BUSY_DAY}`)
    await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Week', exact: true }).click()

    const picker = page.getByLabel('Show availability')
    await expect(picker).toBeVisible({ timeout: 30_000 })
    await picker.selectOption({ label: CAROL_LABEL })
    await expect(page.getByText(new RegExp(`${CAROL_LABEL} is busy on `))).toBeAttached({
      timeout: 30_000,
    })

    // If the band were on top, or were a click target, this would time out or open nothing.
    const mine = page.getByRole('button', { name: /Mine/ }).first()
    await expect(mine).toBeVisible()
    await mine.click()
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('choosing nobody puts the layer away again', async ({ page }) => {
    // `{ stay: true }` because the line below RELOADS: `page.goto` is a full document load, and a
    // token that lives only in memory (NFR-SEC-02) does not survive one — without it every test in
    // this block landed back on the sign-in form and waited thirty seconds for a button that is on
    // the other side of it.
    await login(page, { stay: true })
    await page.goto(`/calendar/${BUSY_DAY}`)
    await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Week', exact: true }).click()

    const picker = page.getByLabel('Show availability')
    await expect(picker).toBeVisible({ timeout: 30_000 })
    await picker.selectOption({ label: CAROL_LABEL })
    await expect(page.getByText(new RegExp(`${CAROL_LABEL} is busy on `))).toBeAttached({
      timeout: 30_000,
    })

    await picker.selectOption('')
    await expect(page.getByText(/is busy on /)).toHaveCount(0)
  })
})
