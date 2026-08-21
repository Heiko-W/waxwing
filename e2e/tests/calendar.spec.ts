import { expect, type Page, test } from '@playwright/test'
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
