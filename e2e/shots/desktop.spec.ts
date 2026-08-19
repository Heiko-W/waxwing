import { expect, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { shot, signIn, waitForBody, waitForCorpus } from './capture'

// Desktop project-site screenshots (1440×900 @2×). See playwright.shots.config.ts.

test.beforeEach(async () => {
  await seedReadMail()
})

async function openInbox(page: import('@playwright/test').Page): Promise<void> {
  await signIn(page)
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await waitForCorpus(page, READ_SUBJECTS.plain)
}

test('reading a message', async ({ page }) => {
  await openInbox(page)
  // The newsletter, because it is the one that carries the remote-content banner — blocking
  // remote images by default is a claim the site makes, and this is what the claim looks like.
  await page.getByText(READ_SUBJECTS.newsletter, { exact: true }).click()
  await expect(page.getByRole('heading', { name: READ_SUBJECTS.newsletter })).toBeVisible()
  await waitForBody(page, READ_SUBJECTS.newsletter, 'Top story')
  await shot(page, 'desktop-reading')
})

test.describe('dark', () => {
  test.use({ colorScheme: 'dark' })

  test('reading a message in dark mode', async ({ page }) => {
    await openInbox(page)
    await page.getByText(READ_SUBJECTS.newsletter, { exact: true }).click()
    await expect(page.getByRole('heading', { name: READ_SUBJECTS.newsletter })).toBeVisible()
    await waitForBody(page, READ_SUBJECTS.newsletter, 'Top story')
    await shot(page, 'desktop-reading-dark')
  })
})

test('the phishing warning', async ({ page }) => {
  await openInbox(page)
  // FR-RD-06/08. The site names this feature AND its limitation; a picture of it is the honest
  // version of both.
  await page.getByText(READ_SUBJECTS.phishing, { exact: true }).click()
  await expect(page.getByRole('heading', { name: READ_SUBJECTS.phishing })).toBeVisible()
  await shot(page, 'desktop-phishing')
})

test('writing a message', async ({ page }) => {
  await openInbox(page)
  await page.getByRole('button', { name: 'New message', exact: true }).click()
  const body = page.getByRole('textbox', { name: 'Message body' })
  await expect(body).toBeVisible({ timeout: 15_000 })

  const to = page.getByRole('combobox', { name: 'To', exact: true })
  await to.click()
  await to.fill('bob@waxwing.test')
  await to.press('Enter')
  await page.getByLabel('Subject', { exact: true }).fill('Re: Q3 planning sync')
  await body.click()
  await page.keyboard.type('Thursday works. I have pencilled it in and moved the review to Friday.')
  await shot(page, 'desktop-compose')
})

test('one message, full screen', async ({ page }) => {
  await openInbox(page)
  // The double-click gesture itself, photographed: no list, no folder rail, no nav rail — the shape
  // the reader gets when they ask for one message and nothing else.
  await page.getByText(READ_SUBJECTS.newsletter, { exact: true }).dblclick()
  await expect(page.getByRole('heading', { name: READ_SUBJECTS.newsletter })).toBeVisible()
  await waitForBody(page, READ_SUBJECTS.newsletter, 'Top story')
  await shot(page, 'desktop-fullscreen')
})
