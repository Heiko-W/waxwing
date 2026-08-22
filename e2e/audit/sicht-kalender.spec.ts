import { expect, type Page, test } from '@playwright/test'
import { check, goTo, shot, signIn } from './sicht-helpers'

/**
 * Visual sweep of the calendar surfaces the JMAP-gap waves added: the calendar list (rail from
 * 40em, screen-high sheet below it), create / rename / colour, delete with its question,
 * reminders, the series editor with its repeat sub-page, the scope sheet after Save, the ICS
 * import dialog, participants and the RSVP bar.
 */

const phone = (page: Page) => (page.viewportSize()?.width ?? 0) < 640

/**
 * Two events in one file, which is the case the preview list is for — a client that reads the
 * server's parse answer as an object rather than an array shows one of them and loses the other
 * with no error anywhere (see `IcsImportDialog`). One of them repeats, so the "repeats" note has
 * something to render.
 */
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Waxwing//Sicht//EN',
  'BEGIN:VEVENT',
  'UID:sicht-1@waxwing.test',
  'DTSTAMP:20260901T090000Z',
  'DTSTART:20260901T090000Z',
  'DTEND:20260901T100000Z',
  'SUMMARY:Sicht import one',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:sicht-2@waxwing.test',
  'DTSTAMP:20260902T090000Z',
  'DTSTART:20260902T140000Z',
  'DTEND:20260902T150000Z',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'SUMMARY:Sicht import two, which repeats every week',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

async function openCalendar(page: Page): Promise<void> {
  await goTo(page, 'Calendar')
  await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({ timeout: 45_000 })
}

/** The calendar list: a rail from 40em up, a sheet out of the view menu below it. */
async function openCalendarList(page: Page): Promise<void> {
  if (!phone(page)) return
  await page.getByRole('button', { name: 'Calendar view', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Calendars…', exact: true }).click()
  await expect(page.getByRole('dialog').first()).toBeVisible()
}

/** The agenda: a segmented button from 40em up, a menu entry below it. */
async function openAgenda(page: Page): Promise<void> {
  if (phone(page)) {
    await page.getByRole('button', { name: 'Calendar view', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Agenda', exact: true }).click()
    return
  }
  await page.getByRole('button', { name: 'Agenda', exact: true }).click()
}

async function closeCalendarList(page: Page): Promise<void> {
  if (!phone(page)) return
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test('calendar: list, colours, reminders, series, scope, import', async ({ page }) => {
  test.setTimeout(300_000)
  const name = `Sicht ${test.info().project.name} ${Date.now() % 100000}`

  await signIn(page)
  await openCalendar(page)
  await shot(page, 'kalender-monat')
  await check(page, 'calendar month')

  // ---- the calendar list
  await openCalendarList(page)
  await shot(page, 'kalender-liste')
  await check(page, 'calendar list')

  // ---- create, with a colour chosen
  await page.getByRole('button', { name: 'New calendar', exact: true }).click()
  const create = page.getByRole('dialog').last()
  await create.getByLabel('Name', { exact: true }).fill(name)
  await shot(page, 'kalender-neu')
  await check(page, 'new calendar dialog')
  await create.locator('label').filter({ hasText: 'Green' }).click()
  await expect(create.getByText('Chosen: Green')).toBeVisible()
  await shot(page, 'kalender-farbe')
  await check(page, 'calendar colour chosen')
  await create.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(create).toBeHidden()

  await openCalendarList(page)
  await expect(page.getByRole('checkbox', { name })).toBeVisible({ timeout: 30_000 })
  await shot(page, 'kalender-liste-mit-farbe')
  await check(page, 'calendar list with a coloured entry')

  // ---- rename
  await page.getByRole('button', { name: `Options for ${name}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  const rename = page.getByRole('dialog').last()
  await expect(rename.getByLabel('Name', { exact: true })).toHaveValue(name)
  await shot(page, 'kalender-umbenennen')
  await check(page, 'rename calendar dialog')
  await rename.getByRole('button', { name: 'Cancel', exact: true }).click()
  await closeCalendarList(page)

  // ---- an event: two reminders, participants, a repeat
  await page.getByRole('button', { name: 'New event', exact: true }).click()
  const event = page.getByRole('dialog').last()
  await event.getByLabel('Title', { exact: true }).fill(`${name} entry`)
  await event.getByLabel('Calendar', { exact: true }).selectOption({ label: name })
  await shot(page, 'termin-neu')
  await check(page, 'event dialog')

  await event.getByLabel('Alert', { exact: true }).selectOption('-PT15M')
  await expect(event.getByLabel('Second alert', { exact: true })).toBeVisible()
  await event.getByLabel('Second alert', { exact: true }).selectOption('-PT1H')
  await shot(page, 'termin-erinnerungen')
  await check(page, 'event reminders (two rows)')

  // ---- participants sub-page
  await event.getByRole('button', { name: /^Participants/ }).click()
  await expect(event.getByLabel('Email address', { exact: true })).toBeVisible()
  await shot(page, 'termin-teilnehmer-leer')
  await check(page, 'participants sub-page, empty')
  await event.getByLabel('Email address', { exact: true }).fill('bob@waxwing.test')
  await event.getByRole('button', { name: 'Add', exact: true }).click()
  await event.getByLabel('Email address', { exact: true }).fill('carol@waxwing.test')
  await event.getByRole('button', { name: 'Add', exact: true }).click()
  await shot(page, 'termin-teilnehmer')
  await check(page, 'participants sub-page, two people')
  await event.getByRole('button', { name: 'Back', exact: true }).click()

  // ---- repeat sub-page
  await event.getByRole('button', { name: /^Repeat/ }).click()
  await shot(page, 'termin-wiederholung')
  await check(page, 'repeat sub-page')
  await event.getByRole('button', { name: 'Every week', exact: true }).click()
  await event.getByRole('button', { name: 'After a number', exact: true }).click()
  await expect(event.getByLabel('Number of events', { exact: true })).toBeVisible()
  await shot(page, 'termin-wiederholung-ende')
  await check(page, 'repeat sub-page, ends after a count')
  await event.getByRole('button', { name: 'Back', exact: true }).click()
  await shot(page, 'termin-serie')
  await check(page, 'event dialog for a series')

  await event.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(event).toBeHidden({ timeout: 45_000 })

  // ---- the agenda, then the event again: the RSVP bar and the scope sheet
  await openAgenda(page)
  const row = page.getByRole('button', { name: new RegExp(`${name} entry`) }).first()
  await expect(row).toBeVisible({ timeout: 45_000 })
  await row.click()
  const again = page.getByRole('dialog').last()
  await expect(again.getByLabel('Title', { exact: true })).toBeVisible()
  const rsvp = again.getByRole('group', { name: 'Your reply', exact: true })
  if (await rsvp.count()) {
    await shot(page, 'termin-rsvp')
    await check(page, 'RSVP bar')
  } else {
    console.log('[sicht] RSVP bar not reachable: no own calendar address on this event')
  }

  await again.getByLabel('Title', { exact: true }).fill(`${name} entry changed`)
  await again.getByRole('button', { name: 'Save', exact: true }).click()
  const scope = page.getByRole('button', { name: 'This event only', exact: true })
  await expect(scope).toBeVisible({ timeout: 45_000 })
  await shot(page, 'termin-bereich')
  await check(page, 'scope sheet after Save')
  await scope.click()
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 45_000 })

  // ---- ICS import
  if (phone(page)) {
    await page.getByRole('button', { name: 'Calendar view', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Import events/ }).click()
  } else {
    await page.getByRole('button', { name: /^Import events/ }).click()
  }
  await expect(page.getByRole('dialog').first()).toBeVisible()
  await shot(page, 'kalender-import')
  await check(page, 'ICS import dialog')

  /*
   * And the half the dialog exists for: the PREVIEW. A calendar file routinely holds more than one
   * event, and the list of what is about to be added — one row each, tickable — is the screen. An
   * empty file picker says nothing about how that list lays out at 390px.
   */
  await page.setInputFiles('[role=dialog] input[type=file]', {
    name: 'sicht.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from(ICS),
  })
  await expect(page.getByRole('button', { name: /^Import 2 events/ })).toBeVisible({
    timeout: 45_000,
  })
  await shot(page, 'kalender-import-vorschau')
  await check(page, 'ICS import, two events previewed')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // ---- delete, the one calendar control that asks first
  await openCalendarList(page)
  await page.getByRole('button', { name: `Options for ${name}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const confirm = page.getByRole('dialog').last()
  await expect(confirm).toContainText('event')
  await shot(page, 'kalender-loeschen')
  await check(page, 'delete calendar confirmation')
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('checkbox', { name })).toHaveCount(0, { timeout: 45_000 })
})
