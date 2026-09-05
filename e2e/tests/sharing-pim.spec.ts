import { expect, type Page, test } from '@playwright/test'
import {
  addBusyEvent,
  clearCalendarEvents,
  clearShareNotifications,
  revokeAllPimShares,
  shareAddressBook,
  shareCalendar,
} from '../stalwart/fixture.mjs'
import { revealPasswordForm, SYNC_BUDGET_MS } from './helpers'

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

/** A day inside the month the calendar opens on, so a grid assertion needs no date navigation. */
const SHARED_EVENT_DAY = '2026-09-02'
const SHARED_EVENT_TITLE = 'Carols shared meeting'

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
  ).toBeVisible({ timeout: SYNC_BUDGET_MS })
}

/** The calendar screen, reached the way a reader reaches it. */
async function openCalendar(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Calendar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })
}

/** The contacts screen. */
async function openContacts(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Contacts', exact: true }).click()
  await expect(page.getByRole('link', { name: /All Contacts/ })).toBeVisible({
    timeout: SYNC_BUDGET_MS,
  })
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
    await expect(button).toBeVisible({ timeout: SYNC_BUDGET_MS })
    // Not a menu item: it is reachable with one activation and no menu is open.
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('a grant SURVIVES the dialog — the server has it, not just the screen', async ({ page }) => {
    await login(page)
    await openCalendar(page)
    await shareCalendarButton(page).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: SYNC_BUDGET_MS })
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
    await expect(calendarRail(page).getByText('Shared').first()).toBeAttached({
      timeout: SYNC_BUDGET_MS,
    })
  })

  test('the calendar shared WITH alice offers no way to share it on (S-4)', async ({ page }) => {
    /*
     * `myRights.mayShare` is `false` on a grantee's copy and `shareWith` is `null` — only the owner
     * ever sees the grant map. The icon must not be drawn: it would open a dialog listing nobody,
     * over something the server will refuse to change.
     *
     * Since S-4 the shared account is reachable, but NOT as an extra calendar row: alice's own rail
     * lists her own calendars, and carol's account sits in the rail's account NAV (S-4b) — the same
     * iCloud pattern the folder rail uses. So the count that must hold is: every calendar CHECKBOX
     * (each of alice's own) has exactly one share icon, and the nav entry for carol is a plain link
     * with no checkbox and no share icon.
     */
    await shareCalendar('carol', 'alice', 'viewer')
    await login(page)
    await openCalendar(page)

    const rail = calendarRail(page)
    const checkboxes = rail.getByRole('checkbox')
    const icons = shareCalendarButton(page)

    /*
     * Wait for the list to be POPULATED, not merely for the rail to EXIST — this is B59, the flake
     * this suite carried from the v0.17.0 release onward, and there was never anything wrong with
     * the app. See the note in the test this replaced: a snapshot count is only safe once the thing
     * being counted has arrived.
     */
    await expect(checkboxes.first()).toBeVisible({ timeout: SYNC_BUDGET_MS })
    const owned = await checkboxes.count()
    expect(owned, 'the rail is empty — this assertion would prove nothing').toBeGreaterThan(0)
    await expect(icons).toHaveCount(owned)
    // Carol's account is the rail's account entry — one click away, with nothing to share ON.
    const carolEntry = rail.getByRole('link', { name: CAROL_LABEL })
    await expect(carolEntry).toBeVisible({ timeout: SYNC_BUDGET_MS })
    await expect(carolEntry).not.toHaveAttribute('aria-current')
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
      await expect(sheet).toBeVisible({ timeout: SYNC_BUDGET_MS })

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
    await expect(button).toBeVisible({ timeout: SYNC_BUDGET_MS })
    await button.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Only you.')).toBeVisible({ timeout: SYNC_BUDGET_MS })

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
    await expect(button).toBeVisible({ timeout: SYNC_BUDGET_MS })
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
    await expect(strip).toBeVisible({ timeout: SYNC_BUDGET_MS })
    await expect(strip.getByText(/shared a calendar with you|shared the calendar/i)).toBeVisible()
    await expect(strip.getByText(/folder/i)).toHaveCount(0)
  })

  test('Open scopes the calendar screen to the account that shared (S-4b)', async ({ page }) => {
    /*
     * S-4b made the card's Open honest: the wrapper scopes the whole screen to the share's account
     * (`?account=`), so the button lands in the account whose calendar was shared instead of back in
     * the reader's own. The account is the announcement's `objectAccountId`, which the session lists
     * by name — and the rail's own account entry (S-4b) is the standing door a group membership
     * gets, which has no card at all.
     */
    await clearShareNotifications('alice')
    await shareCalendar('carol', 'alice', 'viewer')
    await login(page)
    await openCalendar(page)

    const strip = page.getByRole('region', { name: 'New shares' })
    await expect(strip).toBeVisible({ timeout: SYNC_BUDGET_MS })
    const open = strip.getByRole('button', { name: 'Open' })
    await expect(open).toBeVisible()
    await open.click()
    // The route now names carol's account, so a reload stays in her calendars.
    await expect(page).toHaveURL(/\/calendar.*account=/)
    // And the rail's account nav marks her account as the acting one.
    await expect(calendarRail(page).getByRole('link', { name: CAROL_LABEL })).toHaveAttribute(
      'aria-current',
      'page',
      { timeout: SYNC_BUDGET_MS },
    )
    // Her account's calendars are the ones drawn now — the entry row replaced the own one.
    await expect(
      calendarRail(page).getByRole('link', { name: /alice@waxwing.test/ }),
    ).not.toHaveAttribute('aria-current')
  })

  test('“Hide” destroys it, so a reload does not bring it back', async ({ page }) => {
    await clearShareNotifications('alice')
    await shareCalendar('carol', 'alice', 'viewer')
    await login(page, { stay: true })
    await openCalendar(page)

    const strip = page.getByRole('region', { name: 'New shares' })
    await expect(strip).toBeVisible({ timeout: SYNC_BUDGET_MS })
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
    await expect(strip).toBeVisible({ timeout: SYNC_BUDGET_MS })
    await expect(
      strip.getByText(/shared a contact list with you|shared the contact list/i),
    ).toBeVisible()
    await expect(strip.getByRole('button', { name: 'Open' })).toHaveCount(0)
  })
})

test.describe('S-4 — a grantee sees the shared account in the rails', () => {
  test('a shared address book gives the owner a labelled section in the contacts rail', async ({
    page,
  }) => {
    /*
     * The contacts rail groups books by account (S-4): with carol's book shared in, alice's rail
     * grows a section labelled with carol's account — the same iCloud pattern the folder rail uses,
     * and the standing door a group membership gets with no card at all.
     *
     * **The BOOK is the assertion, not the section**, and that distinction is the whole point of
     * this test. An earlier version pinned only the section and explained the empty list as a lag:
     * it was not a lag. Carol shares an address book and no mail, so her account got no sync engine
     * and no replica rows — the section rendered in under a second and still said "No address
     * books." thirty seconds later, while `AddressBook/get` was returning the book to the same
     * session. A test that asserts the container while the contents are structurally unreachable
     * reports coverage it does not have. See ADR-046.
     */
    await clearShareNotifications('alice')
    await shareAddressBook('carol', 'alice', 'viewer')
    await login(page)
    await openContacts(page)

    const section = page
      .getByRole('navigation', { name: 'Address books' })
      .getByRole('region', { name: CAROL_LABEL })
    await expect(section).toBeVisible({ timeout: SYNC_BUDGET_MS })
    // Her actual book, from the replica an engine now fills for a mail-less shared account.
    await expect(section.getByRole('link')).not.toHaveCount(0, { timeout: SYNC_BUDGET_MS })
    await expect(section.getByText('No address books.')).toHaveCount(0)
  })

  test('a calendar shared with no mail still shows its EVENTS, not an empty month', async ({
    page,
  }) => {
    /*
     * The calendar half of the same defect, and the more deceptive of the two: the calendar LIST
     * arrives over the live client, so carol's calendar appeared in the rail under its own name
     * while the grid behind it stayed on the spinner — the events come from the replica (K-8) and
     * no engine was filling it for an account that shares no mail. A reader would have concluded
     * her diary was empty.
     *
     * The EVENT is therefore the assertion. It is also what makes the offline promise real: a month
     * that reached the replica is a month the next visit draws with the network off. See ADR-046.
     */
    await clearCalendarEvents()
    // Inside the month the calendar opens on, so the grid shows it with no date navigation.
    await addBusyEvent('carol', {
      start: `${SHARED_EVENT_DAY}T10:00:00`,
      duration: 'PT2H',
      title: SHARED_EVENT_TITLE,
    })
    await clearShareNotifications('alice')
    await shareCalendar('carol', 'alice', 'viewer')
    await login(page)
    await openCalendar(page)

    await calendarRail(page).getByRole('link', { name: CAROL_LABEL }).click()
    await expect(page).toHaveURL(/\/calendar.*account=/)
    await expect(page.getByText(SHARED_EVENT_TITLE).first()).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
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

  /**
   * Choose whose availability to draw, once the picker can actually offer them.
   *
   * The `<select>` renders as soon as the week view does; its OPTIONS come from the principals the
   * reader may ask about, which arrive on a later sync pass. `selectOption` does retry until the
   * option exists — so a picker that never fills up does not fail where the problem is, it burns the
   * whole sixty-second budget inside `locator.selectOption` and reports "Test timeout exceeded" with
   * no hint that an option list is what was missing. Four of the twenty-nine flaky attempts across
   * forty CI runs were this call, in this shape.
   *
   * Waiting for the option explicitly costs nothing when it is already there and names the real
   * problem when it is not.
   */
  async function chooseAvailability(page: Page, label: string): Promise<void> {
    const picker = page.getByLabel('Show availability')
    await expect(picker).toBeVisible({ timeout: SYNC_BUDGET_MS })
    await expect(
      picker.getByRole('option', { name: label, exact: true }),
      `the availability picker never offered ${label}`,
    ).toBeAttached({ timeout: SYNC_BUDGET_MS })
    await picker.selectOption({ label })
  }

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
    await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
    await page.getByRole('button', { name: 'Week', exact: true }).click()

    await chooseAvailability(page, CAROL_LABEL)

    // The band is a background layer and `aria-hidden`; the sentence beside it is the whole of what
    // a screen reader gets, and asserting on it is the only honest way to assert on a hatch.
    await expect(
      page.getByText(new RegExp(`${CAROL_LABEL} is busy on .* from .* to `)),
    ).toBeAttached({ timeout: SYNC_BUDGET_MS })
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
    await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })

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
    await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
    await page.getByRole('button', { name: 'Week', exact: true }).click()

    await chooseAvailability(page, CAROL_LABEL)
    await expect(page.getByText(new RegExp(`${CAROL_LABEL} is busy on `))).toBeAttached({
      timeout: SYNC_BUDGET_MS,
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
    await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
    await page.getByRole('button', { name: 'Week', exact: true }).click()

    await chooseAvailability(page, CAROL_LABEL)
    await expect(page.getByText(new RegExp(`${CAROL_LABEL} is busy on `))).toBeAttached({
      timeout: SYNC_BUDGET_MS,
    })

    await page.getByLabel('Show availability').selectOption('')
    await expect(page.getByText(/is busy on /)).toHaveCount(0)
  })
})
