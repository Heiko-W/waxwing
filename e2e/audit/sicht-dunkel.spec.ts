import { expect, test } from '@playwright/test'
import { check, goTo, shot, signIn } from './sicht-helpers'

/**
 * The dark appearance, over the coloured surfaces this round added — calendar colours, the
 * selection bar, the RSVP bar and the reminder rows.
 *
 * A sample rather than a second full walk: what breaks in dark is a hard-coded colour or a fill
 * that assumed a light plane behind it, and those are the surfaces that introduced new fills.
 */

test.use({ colorScheme: 'dark' })

test('dark: calendar colours, files selection bar, reminders', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)
  await shot(page, 'dunkel-posteingang')
  await check(page, 'dark inbox')

  // ---- the calendar's colour swatches, the one place this round paints with fixed hues
  await goTo(page, 'Calendar')
  await expect(page.getByRole('button', { name: 'New event' })).toBeVisible({ timeout: 45_000 })
  await shot(page, 'dunkel-kalender')
  await check(page, 'dark calendar')

  const listOpen = page.getByRole('button', { name: 'Calendar view', exact: true })
  if (await listOpen.count()) {
    await listOpen.click()
    await page.getByRole('menuitem', { name: 'Calendars…', exact: true }).click()
  }
  await page.getByRole('button', { name: 'New calendar', exact: true }).click()
  const create = page.getByRole('dialog').last()
  await expect(create.getByLabel('Name', { exact: true })).toBeVisible()
  await shot(page, 'dunkel-kalenderfarben')
  await check(page, 'dark calendar colour swatches')
  await create.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.keyboard.press('Escape')

  // ---- the event dialog: reminder rows and the sub-page rows
  await page.getByRole('button', { name: 'New event', exact: true }).click()
  const event = page.getByRole('dialog').last()
  await event.getByLabel('Title', { exact: true }).fill('Dunkel')
  await event.getByLabel('Alert', { exact: true }).selectOption('-PT15M')
  await shot(page, 'dunkel-termin')
  await check(page, 'dark event dialog')
  await event.getByRole('button', { name: /^Repeat/ }).click()
  await shot(page, 'dunkel-wiederholung')
  await check(page, 'dark repeat sub-page')
  await event.getByRole('button', { name: 'Back', exact: true }).click()
  await event.getByRole('button', { name: 'Cancel', exact: true }).click()

  // ---- the files selection bar, the other new coloured strip
  await goTo(page, 'Files')
  await expect(page.getByRole('button', { name: 'List options', exact: true })).toBeVisible({
    timeout: 45_000,
  })
  await page.getByRole('button', { name: 'List options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Select', exact: true }).click()
  await shot(page, 'dunkel-auswahlleiste')
  await check(page, 'dark files selection bar')
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  // ---- settings: the filter rows with their grips
  await goTo(page, 'Settings')
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'Account & security', exact: true })
    .click()
  // Level 1 on a phone, 2 beside the rail — see `sicht-einstellungen.spec.ts`.
  await expect(
    page
      .getByRole('heading', { name: 'Account & security', level: 2 })
      .or(page.getByRole('heading', { name: 'Account & security', level: 1 }))
      .first(),
  ).toBeVisible({ timeout: 30_000 })
  await shot(page, 'dunkel-konto')
  await check(page, 'dark account & security')
})
