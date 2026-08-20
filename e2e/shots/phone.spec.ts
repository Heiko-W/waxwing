import { expect, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { shot, signIn, waitForBody, waitForCorpus } from './capture'

// Phone project-site screenshots (390×844 @3×, touch). See playwright.shots.config.ts — this
// viewport sits below both shell breakpoints, so it photographs the real narrow layout: bottom
// navigation, and the folder rail as an off-canvas drawer.

test.beforeEach(async ({ page }) => {
  await seedReadMail()
  await signIn(page)
  // On this viewport the folder rail is a drawer, so nothing is selected on arrival and the list
  // is empty — the Inbox has to be picked the way a person on a phone picks it.
  await page.getByRole('button', { name: 'Show folders' }).click()
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  // …and then dismissed BY HAND, because selecting a folder does not close it (MailScreen.tsx
  // wires `closeFolders` to Escape and to the backdrop only). That is a real defect in the narrow
  // layout, not a quirk of driving it from a test: the drawer is `min(80vw, 18rem)` wide, so after
  // a tap on Inbox it is still covering the list the tap was meant to reveal. It is written down
  // here rather than worked around silently — a screenshot run that quietly papers over the thing
  // it photographs is worse than no screenshots.
  // Escape, not the backdrop: the backdrop spans the whole screen but the drawer covers 80 vw of
  // it, so a click at the backdrop's centre lands on the drawer and Playwright waits forever.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeHidden()
  await waitForCorpus(page, READ_SUBJECTS.plain)
})

test('the message list', async ({ page }) => {
  await shot(page, 'phone-list')
})

test('reading a message', async ({ page }) => {
  await page.getByText(READ_SUBJECTS.newsletter, { exact: true }).click()
  await expect(page.getByRole('heading', { name: READ_SUBJECTS.newsletter })).toBeVisible()
  await waitForBody(page, READ_SUBJECTS.newsletter, 'Top story')
  await shot(page, 'phone-reading')
})

test('the folder drawer', async ({ page }) => {
  await page.getByRole('button', { name: 'Show folders' }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible()
  await shot(page, 'phone-folders')
})

test('writing a message', async ({ page }) => {
  await page.getByRole('button', { name: 'New message', exact: true }).click()
  const body = page.getByRole('textbox', { name: 'Message body' })
  await expect(body).toBeVisible({ timeout: 15_000 })

  const to = page.getByRole('combobox', { name: 'To', exact: true })
  await to.click()
  await to.fill('bob@waxwing.test')
  await to.press('Enter')
  await page.getByLabel('Subject', { exact: true }).fill('Thursday works')
  await body.click()
  await page.keyboard.type('See you at one.')
  await shot(page, 'phone-compose')
})

test('the settings list', async ({ page }) => {
  await signIn(page)
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  // On a phone the rail IS the screen: a section replaces it, and the back link returns here.
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({
    timeout: 30_000,
  })
  await shot(page, 'phone-settings')
})
