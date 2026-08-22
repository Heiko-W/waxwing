import { expect, type Page, test } from '@playwright/test'
import { check, goTo, shot, signIn } from './sicht-helpers'

/**
 * Visual sweep of the Settings surfaces this round added: the filter list with its reorder grips
 * and keyboard path, the master switch, the delete question, the richer rule form — and the whole
 * of "Account & security" (app passwords with their one-time secret, the password change, the spam
 * samples, the encryption report).
 */

async function openSettings(page: Page, section: string): Promise<void> {
  await goTo(page, 'Settings')
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({
    timeout: 45_000,
  })
  const rail = page.getByRole('navigation', { name: 'Settings' })
  await rail.getByRole('link', { name: section, exact: true }).click()
  // Level 1 on a phone, 2 beside the rail: below 40em the panel IS the screen, so it takes the
  // page's only `<h1>` with it (SettingsPage's `Section`, `narrow`).
  await expect(
    page
      .getByRole('heading', { name: section, level: 2 })
      .or(page.getByRole('heading', { name: section, level: 1 }))
      .first(),
  ).toBeVisible({ timeout: 30_000 })
}

test('settings: filter rules — order, conditions, switch, delete', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)
  await openSettings(page, 'Filters')
  await shot(page, 'einstellungen-filter')
  await check(page, 'filters, empty')

  const section = page.getByRole('region', { name: 'Filters' })

  async function addRule(name: string, subject: string): Promise<void> {
    await section.getByRole('button', { name: 'Add rule', exact: true }).click()
    await page.getByLabel('Name', { exact: true }).fill(name)
    await page.getByLabel('Part', { exact: true }).first().selectOption('subject')
    await page.getByLabel('Value', { exact: true }).fill(subject)
    await page.getByRole('button', { name: 'Save rule', exact: true }).click()
    await expect(section.getByText(name, { exact: true })).toBeVisible({ timeout: 30_000 })
  }

  // ---- the rule form, and the conditions this round added
  await section.getByRole('button', { name: 'Add rule', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('Sicht')
  await shot(page, 'einstellungen-regel-formular')
  await check(page, 'filter rule form')
  await page.getByLabel('Part', { exact: true }).first().selectOption('spam')
  await shot(page, 'einstellungen-regel-spam')
  await check(page, 'filter rule, spam-score condition')
  await page.getByLabel('Part', { exact: true }).first().selectOption('currentDate')
  await shot(page, 'einstellungen-regel-zeit')
  await check(page, 'filter rule, delivery-time condition')
  await page.getByRole('button', { name: 'Add condition', exact: true }).click()
  await shot(page, 'einstellungen-regel-zwei-bedingungen')
  await check(page, 'filter rule, two conditions')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  // ---- two rules, so the grips have something to do
  await addRule('First', 'One')
  await addRule('Second', 'Two')
  await shot(page, 'einstellungen-filter-liste')
  await check(page, 'filter list with reorder grips')

  const grip = page.getByRole('button', { name: 'Reorder First', exact: true })
  await grip.focus()
  await page.keyboard.press('Space')
  await shot(page, 'einstellungen-filter-aufgenommen')
  await check(page, 'filter list, a rule picked up by keyboard')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Space')
  await page.waitForTimeout(800)
  await shot(page, 'einstellungen-filter-umsortiert')
  await check(page, 'filter list, reordered')

  // ---- the master switch off
  await page.getByRole('switch', { name: 'Filter incoming mail', exact: true }).click()
  await page.waitForTimeout(800)
  await shot(page, 'einstellungen-filter-aus')
  await check(page, 'filters switched off')
  await page.getByRole('switch', { name: 'Filter incoming mail', exact: true }).click()
  await page.waitForTimeout(800)

  // ---- delete the script, with its question
  await page.getByRole('button', { name: 'Delete filter script', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete filter script?' })
  await expect(confirm).toBeVisible()
  await shot(page, 'einstellungen-filter-loeschen')
  await check(page, 'delete filter script confirmation')
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(section).toContainText('No filter rules yet', { timeout: 45_000 })
})

test('settings: account & security', async ({ page }) => {
  test.setTimeout(300_000)
  const name = `Sicht ${test.info().project.name} ${Date.now() % 100000}`

  await signIn(page)
  await openSettings(page, 'Account & security')
  await shot(page, 'einstellungen-konto')
  await check(page, 'account & security')

  // ---- app password, and the secret shown exactly once
  await page.getByRole('button', { name: 'Create app password…', exact: true }).click()
  const create = page.getByRole('dialog')
  await create.getByLabel('What is it for?', { exact: true }).fill(name)
  await shot(page, 'einstellungen-app-passwort-neu')
  await check(page, 'create app password')
  await create.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(create.getByText(/only time it is shown/i)).toBeVisible({ timeout: 45_000 })
  await shot(page, 'einstellungen-app-passwort-geheimnis')
  await check(page, 'app password, the one-time secret')
  await create.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 30_000 })
  await shot(page, 'einstellungen-app-passwoerter')
  await check(page, 'app password list')

  // ---- revoke it again, with its question
  await page.getByRole('button', { name: `Revoke ${name}`, exact: true }).click()
  const revoke = page.getByRole('dialog')
  await expect(revoke).toBeVisible()
  await shot(page, 'einstellungen-app-passwort-widerrufen')
  await check(page, 'revoke app password')
  await revoke.getByRole('button', { name: 'Revoke', exact: true }).click()
  await expect(page.getByText(name, { exact: true })).toBeHidden({ timeout: 45_000 })

  // ---- password change (opened and cancelled: changing it would lock the fixture out)
  await page.getByRole('button', { name: 'Change password…', exact: true }).click()
  const change = page.getByRole('dialog')
  await expect(change.getByLabel('Current password', { exact: true })).toBeVisible()
  await shot(page, 'einstellungen-passwortwechsel')
  await check(page, 'change password')
  await change.getByLabel('Current password', { exact: true }).fill('wrong')
  await change.getByLabel('New password', { exact: true }).fill('one-Pw1!')
  await change.getByLabel('Repeat new password', { exact: true }).fill('another-Pw1!')
  await change.getByRole('button', { name: 'Change password', exact: true }).click()
  await shot(page, 'einstellungen-passwortwechsel-fehler')
  await check(page, 'change password, the two do not match')
  await change.getByRole('button', { name: 'Cancel', exact: true }).click()

  // ---- what is left on the panel: spam samples and the encryption report
  const spam = page.getByText('Spam training samples', { exact: true })
  if (await spam.count()) {
    await spam.scrollIntoViewIfNeeded()
    await shot(page, 'einstellungen-spamproben')
    await check(page, 'spam samples + encryption')
  } else {
    console.log('[sicht] spam samples not offered by this server')
  }
})
