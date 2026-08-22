import { expect, type Page, test } from '@playwright/test'
import { ACCOUNTS, jmapAs } from '../stalwart/seed-write.mjs'
import { login } from './helpers'

/**
 * The calendar's write path against the LIVE fixture (T1, T13).
 *
 * This suite exists because the leading finding of the 21 August 2026 walkthrough was invisible to
 * every other kind of test we have. Editing and deleting failed for **every** event, on a code path
 * that is correct in isolation and wrong on the wire: the month is fetched with
 * `expandRecurrences: true`, the server answers with one id per OCCURRENCE (`eaaaaa0`, not `0`), and
 * the screen wrote back with the id it had drawn with. Stalwart refuses that —
 * `invalidProperties: "Updating synthetic ids is not yet supported."` — while the identical patch
 * addressed to the real id is accepted.
 *
 * A component test can only assert that the client is handed the id the client itself resolved. Only
 * a real server can say whether that id is one it will accept, which is the whole point of this
 * file: create, change, delete, undo, against Stalwart.
 *
 * Registered in `playwright.write.config.ts` beside the other stateful suites; it cleans up after
 * itself rather than resetting a seed, because there is no calendar seed to reset.
 */

const TITLE = `E2E event ${Date.now()}`
const CHANGED = `${TITLE} changed`

/** The calendar screen, reached the way a reader reaches it. */
async function openCalendar(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Calendar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({ timeout: 30_000 })
}

/**
 * The agenda, not the month grid, for finding an event.
 *
 * A month cell shows at most three chips before it starts counting, and this fixture's calendar is
 * shared with whatever else has run against it — so "the event is visible" must not depend on how
 * busy today happens to be. Every upcoming event has a row here.
 */
async function openAgenda(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Agenda', exact: true }).click()
}

const row = (page: Page, title: string) => page.getByRole('button', { name: new RegExp(title) })

test.describe.configure({ mode: 'serial' })

test('an event can be created, changed, deleted and brought back', async ({ page }) => {
  await login(page)
  await openCalendar(page)

  // ---- create
  await page.getByRole('button', { name: 'New event' }).click()
  const create = page.getByRole('dialog')
  await create.getByLabel('Title', { exact: true }).fill(TITLE)
  await create.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(create).toBeHidden()

  await openAgenda(page)
  await expect(row(page, TITLE)).toBeVisible()

  // ---- change: the half that failed for every event in the calendar
  await row(page, TITLE).click()
  const edit = page.getByRole('dialog')
  await edit.getByLabel('Title', { exact: true }).fill(CHANGED)
  await edit.getByRole('button', { name: 'Save', exact: true }).click()
  // The dialog closing IS the assertion: it stays open on a refusal, by design, so that the
  // reader's input survives to be corrected.
  await expect(edit).toBeHidden()
  await expect(row(page, CHANGED)).toBeVisible()

  // ---- delete, and undo it
  await row(page, CHANGED).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('Event deleted.')).toBeVisible()
  await expect(row(page, CHANGED)).toHaveCount(0)

  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(row(page, CHANGED)).toBeVisible()

  // ---- clean up: delete it for good, so a re-run starts from the same place
  await row(page, CHANGED).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(row(page, CHANGED)).toHaveCount(0)
})

test('a failed write names the operation and the reason', async ({ page }) => {
  // The server's refusal is forced rather than provoked: what is under test is the REPORT, which
  // used to say "The event could not be saved." after a failed delete and dropped the server's own
  // explanation entirely (T7).
  await login(page)
  await openCalendar(page)

  await page.getByRole('button', { name: 'New event' }).click()
  const create = page.getByRole('dialog')
  await create.getByLabel('Title', { exact: true }).fill(`${TITLE} refused`)

  await page.route('**/jmap/**', async (route) => {
    const body = route.request().postData() ?? ''
    if (!body.includes('CalendarEvent/set')) return route.fallback()
    await route.fulfill({
      json: {
        methodResponses: [
          [
            'CalendarEvent/set',
            {
              accountId: 'x',
              notCreated: {
                e: { type: 'invalidProperties', description: 'Nope, not today.' },
              },
            },
            'c0',
          ],
        ],
        sessionState: 'e2e',
      },
    })
  })

  await create.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('The event could not be saved.')).toBeVisible()
  await expect(page.getByText('Nope, not today.')).toBeVisible()
  // And the dialog is still there with the reader's title in it.
  await expect(create.getByLabel('Title', { exact: true })).toHaveValue(`${TITLE} refused`)
})

/**
 * Managing calendars (K-1) and reminders (K-5) against the LIVE fixture.
 *
 * These two belong here rather than in a component test for the same reason the block above does:
 * the failures they guard against are shapes on the wire, and a fake answers whatever it was told
 * to. Three of them were measured against Stalwart v0.16.18 on 21 August 2026 and are the reason the
 * implementation plan had to be corrected:
 *
 *  - `inCalendars` (the draft's spelling) is answered `unsupportedFilter` as a METHOD-level error —
 *    the whole query fails. Only `inCalendar`, singular, works.
 *  - a `Calendar/set` destroy on a non-empty calendar is refused (`calendarHasEvent`) unless the
 *    client sends `onDestroyRemoveEvents: true`.
 *  - `participantIdentities` on a calendar is `invalidProperties` and fails the create outright.
 *
 * A component test cannot see any of that. This one can, because hiding a calendar here means the
 * month comes back from the server without its events.
 */

const CAL = `E2E calendar ${Date.now()}`

test('a calendar can be created, hidden, shown and deleted', async ({ page }) => {
  await login(page)
  await openCalendar(page)

  // ---- create: `{name, color, isVisible, isSubscribed}` and nothing the server refuses
  await page.getByRole('button', { name: 'New calendar' }).click()
  const create = page.getByRole('dialog')
  await create.getByLabel('Name', { exact: true }).fill(CAL)
  // The <label>, not the radio inside it — because that is the control a person presses. The input
  // is deliberately invisible (1 px, `clip-path`, so arrow keys and the accessible name still come
  // from a real radio; see `.swatchInput` in calendar.module.css) and sits at its static position
  // under the coloured dot, so a click aimed at the input itself is intercepted by the tick drawn
  // on top of it — which is what this line used to do, and it retried for ninety seconds. Clicking
  // the label activates the radio exactly as a mouse does; `Chosen: Green` below is the proof.
  await create.locator('label').filter({ hasText: 'Green' }).click()
  await expect(create.getByText('Chosen: Green')).toBeVisible()
  await create.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(create).toBeHidden()

  const tick = page.getByRole('checkbox', { name: CAL })
  await expect(tick).toBeVisible()
  await expect(tick).toBeChecked()

  // ---- an event in it, so the range query has something to prove
  const eventTitle = `${CAL} entry`
  await page.getByRole('button', { name: 'New event' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title', { exact: true }).fill(eventTitle)
  await dialog.getByLabel('Calendar', { exact: true }).selectOption({ label: CAL })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()

  await openAgenda(page)
  await expect(row(page, eventTitle)).toBeVisible()

  /*
   * ---- hide it. The assertion is NOT that the row disappears from the screen — a local filter
   * would do that too, and a local filter is precisely what this feature must not be. It is that
   * the event is gone after the month has been fetched again, which only happens if the server was
   * asked with `inCalendar` naming the calendars that are left.
   */
  await page.getByRole('checkbox', { name: CAL }).uncheck()
  await expect(row(page, eventTitle)).toHaveCount(0)

  // ---- and back again: the tick is server state, so it survives a re-read of the month.
  await page.getByRole('checkbox', { name: CAL }).check()
  await expect(row(page, eventTitle)).toBeVisible()

  // ---- rename it, to exercise the update path
  await page.getByRole('button', { name: `Options for ${CAL}` }).click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
  const edit = page.getByRole('dialog')
  await edit.getByLabel('Name', { exact: true }).fill(`${CAL} renamed`)
  await edit.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: `${CAL} renamed` })).toBeVisible()

  /*
   * ---- delete, which is the one control on this screen with a confirmation, and the one that
   * needs `onDestroyRemoveEvents` — the calendar is NOT empty, so a client that omits the flag is
   * refused here with "Calendar is not empty." and the test fails on the count line below.
   */
  await page.getByRole('button', { name: `Options for ${CAL} renamed` }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog')
  await expect(confirm).toContainText('1 event')
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(page.getByRole('checkbox', { name: `${CAL} renamed` })).toHaveCount(0)
  await expect(row(page, eventTitle)).toHaveCount(0)
})

test('the default calendar cannot be deleted from here', async ({ page }) => {
  /*
   * The server WOULD allow it — measured, `destroy` on the account's default calendar succeeds.
   * What it will not allow is appointing a replacement: `isDefault` is refused in create and in
   * update ("Field could not be set."), because on this server the flag belongs to the DAV
   * collection literally named `default`. The guard is therefore this client's, and nothing but a
   * test says so.
   */
  await login(page)
  await openCalendar(page)

  const menu = page.getByRole('button', { name: /^Options for / }).first()
  await menu.click()
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0)
})

test('a reminder set here survives a rename, and one set elsewhere is not lost', async ({
  page,
}) => {
  /*
   * K-5 end to end. `alerts` was in no property list the client sent, so this could not even be
   * OBSERVED before — and the moment the editor names the property in a patch, an alarm it cannot
   * model is one save away from deletion.
   *
   * The second half is the one that needs a real server: the email alarm is put in over JMAP from
   * NODE, because no control in this app can create one and `page.route` would only fake the
   * answer. It then has to survive a title change made through the editor, which rewrites the whole
   * `alerts` map from what the dialog knows — and the dialog does not know about email alarms.
   */
  const title = `E2E alert ${Date.now()}`
  const alice = jmapAs(ACCOUNTS.alice)
  const calendars = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars']
  const accountId = await alice.account()

  await login(page)
  await openCalendar(page)

  await page.getByRole('button', { name: 'New event' }).click()
  const create = page.getByRole('dialog')
  await create.getByLabel('Title', { exact: true }).fill(title)
  await create.getByLabel('Alert', { exact: true }).selectOption('-PT15M')
  await create.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(create).toBeHidden()

  await openAgenda(page)
  await row(page, title).click()
  // Read back from the server, not from React state: the dialog closed and the month was re-fetched
  // in between, so this value made the round trip.
  await expect(page.getByRole('dialog').getByLabel('Alert', { exact: true })).toHaveValue('-PT15M')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()

  // An alarm this client cannot make, put in behind its back — the shape a phone or a CalDAV client
  // would leave. A per-member patch, so nothing else on the event is touched.
  const found = await alice.call(calendars, [
    ['CalendarEvent/query', { accountId, filter: { title } }, '0'],
  ])
  const eventId = (found.methodResponses[0]?.[1] as { ids?: string[] }).ids?.[0]
  expect(eventId, 'the event just created was not found over JMAP').toBeTruthy()
  if (eventId === undefined) return

  await alice.call(calendars, [
    [
      'CalendarEvent/set',
      {
        accountId,
        update: {
          [eventId]: {
            'alerts/mail': {
              '@type': 'Alert',
              action: 'email',
              trigger: { '@type': 'OffsetTrigger', offset: '-PT1H' },
            },
          },
        },
      },
      '0',
    ],
  ])

  /*
   * Wait for the REPLICA to catch up, without reloading the page (`login()` does not tick "Stay
   * signed in", so a reload lands back on the sign-in form).
   *
   * This used to step a month away and back, because that is what made the screen fetch again. Since
   * K-8 it does not: the month is read out of IndexedDB, keyed by the window, so paging away and
   * back re-renders the same rows and asks the server nothing. What brings in a change made on
   * another device is the engine's own `CalendarEvent/changes` delta — pushed, or on the 60 s safety
   * sweep behind it — and the dialog holds the event it was OPENED with, so it has to be opened
   * after that has landed rather than refreshed while it is up.
   *
   * Re-opening until it is there is therefore the assertion, not a softening of one: it is the proof
   * that an alarm set elsewhere reaches this screen at all. Measured against v0.16.18 it arrives in
   * about three seconds, on the push echo.
   */
  const edit = page.getByRole('dialog')
  await expect(async () => {
    if (await edit.isVisible()) {
      await edit.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(edit).toBeHidden()
    }
    await row(page, title).click()
    // Reported, and NOT offered for editing — it is not in the picker, it is a sentence.
    await expect(edit.getByText(/further reminder is kept unchanged/)).toBeVisible({
      timeout: 1_000,
    })
  }).toPass({ timeout: 45_000 })
  await edit.getByLabel('Title', { exact: true }).fill(`${title} renamed`)
  await edit.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(edit).toBeHidden()

  // The assertion K-5 exists for. The editor rewrote `alerts` wholesale; the email alarm is still
  // there, under its own key, with its own trigger.
  const after = await alice.call(calendars, [
    ['CalendarEvent/get', { accountId, ids: [eventId], properties: ['title', 'alerts'] }, '0'],
  ])
  const stored = (after.methodResponses[0]?.[1] as { list?: Record<string, unknown>[] }).list?.[0]
  expect(stored?.title).toBe(`${title} renamed`)
  expect(JSON.stringify(stored?.alerts)).toContain('email')
  expect(JSON.stringify(stored?.alerts)).toContain('-PT15M')

  // ---- clean up
  await alice.call(calendars, [['CalendarEvent/set', { accountId, destroy: [eventId] }, '0']])
})

/**
 * The calendar offline (K-8), against the LIVE fixture.
 *
 * Before the replica landed, this screen answered a lost connection with "The calendar could not be
 * loaded." over a month the device had drawn a minute earlier — the one failure mode a calendar
 * cannot afford, because looking at it in a lift or on a train is most of what a calendar is for.
 *
 * Only a browser can prove the fix. The unit tests inject a fake engine and a seeded replica; what
 * they cannot see is whether the REAL sync engine actually materialized this month into IndexedDB,
 * and whether the REAL screen reads it back when `navigator.onLine` flips. That is one seam per
 * layer, all of which are correct in isolation, and the class of bug that lives between them.
 *
 * The test never reloads the page — `login()` does not tick "Stay signed in", so a reload lands back
 * on the sign-in form. Leaving the screen and coming back is enough: `CalendarPage` unmounts, its
 * component state dies with it, and everything drawn afterwards can only have come from the replica.
 */
test('offline, the calendar keeps showing the month it already has (K-8)', async ({
  page,
  context,
}) => {
  const title = `E2E offline ${Date.now()}`
  await login(page)
  await openCalendar(page)

  // ---- something to look at, created while there is still a network
  await page.getByRole('button', { name: 'New event' }).click()
  const create = page.getByRole('dialog')
  await create.getByLabel('Title', { exact: true }).fill(title)
  await create.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(create).toBeHidden()
  await openAgenda(page)
  await expect(row(page, title)).toBeVisible()

  try {
    /*
     * Pull the plug, and wait for the APP to agree rather than for the CDP command.
     *
     * `/^Offline$/` and not `'Offline'`: a STRING `hasText` is a case-insensitive SUBSTRING match,
     * so it also catches this screen's own "Not updating while offline." line — two `role="status"`
     * elements, one locator, and a strict-mode violation that never resolves. The anchored regex
     * names the shell's chip alone, which is the thing being waited on here.
     */
    await context.setOffline(true)
    await expect(page.getByRole('status').filter({ hasText: /^Offline$/ })).toBeVisible({
      timeout: 15_000,
    })

    // ---- leave and come back: from here on, anything on screen came out of IndexedDB
    await page.getByRole('link', { name: 'Mail', exact: true }).click()
    await page.getByRole('link', { name: 'Calendar', exact: true }).click()
    await openAgenda(page)

    await expect(row(page, title)).toBeVisible({ timeout: 30_000 })
    // …and the screen says so, quietly, instead of claiming to be live.
    await expect(
      page.getByRole('status').filter({ hasText: /Not updating while offline/ }),
    ).toBeVisible()
    // The failure it used to show over exactly this data.
    await expect(page.getByText('The calendar could not be loaded.')).toHaveCount(0)

    // ---- what cannot work offline is REFUSED with a reason, not silently broken (Apple's rule:
    // greyed out and explained, never invisible).
    const newEvent = page.getByRole('button', { name: 'New event' })
    await expect(newEvent).toBeDisabled()
    await expect(
      page.getByText('You are offline. Events can only be created while connected.'),
    ).toBeVisible()
    /*
     * `force`, because the refusal is `aria-disabled` and NOT the `disabled` attribute: `Button`'s
     * `unavailableReason` keeps the control focusable on purpose, so the reader who most needs the
     * explanation can still reach it (FR-A11Y-01), and swallows the activation in the handler.
     * Playwright's actionability guard honours `aria-disabled` and would wait for the button to
     * become enabled until the test timed out — which is what a plain `.click()` did here. A real
     * mouse press does reach this button, so forcing it is the honest simulation, and the assertion
     * is that it still opens nothing.
     */
    await newEvent.click({ force: true })
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }

  // ---- clean up: back online, delete the event for good
  await expect(page.getByRole('status').filter({ hasText: /^Offline$/ })).toBeHidden({
    timeout: 15_000,
  })
  await openAgenda(page)
  await row(page, title).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(row(page, title)).toHaveCount(0)
})
