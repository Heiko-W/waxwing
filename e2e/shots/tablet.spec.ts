import { expect, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { shot, signIn, waitForBody, waitForCorpus } from './capture'

/*
 * Tablet project-site screenshots (834×1112 @2×). See playwright.shots.config.ts.
 *
 * WHY A THIRD VIEWPORT. 834px is the one width where BOTH shell breakpoints have fired in
 * different directions: it is past 40em, so the primary navigation is the icon rail rather than a
 * bottom bar, but short of 64em, so the folder region is still an off-canvas drawer. Neither the
 * desktop nor the phone run photographs that combination, and it is the layout an iPad in portrait
 * actually gets — which made it the one shape nobody was looking at.
 *
 * `viewports.spec.ts` already asserts that nothing overflows here. That is a different question
 * from whether it looks right, and only a picture answers the second one.
 */

test.beforeEach(async () => {
  await seedReadMail()
})

test('reading a message', async ({ page }) => {
  await signIn(page)
  // The rail is a drawer at this width, so the inbox has to be opened through the toggle — the
  // same path a reader takes, and the reason this shot is not a narrower copy of the desktop one.
  await page.getByRole('button', { name: 'Show folders' }).click()
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await waitForCorpus(page, READ_SUBJECTS.plain)

  await page.getByText(READ_SUBJECTS.newsletter, { exact: true }).click()
  await expect(page.getByRole('heading', { name: READ_SUBJECTS.newsletter })).toBeVisible()
  await waitForBody(page, READ_SUBJECTS.newsletter, 'Top story')
  await shot(page, 'tablet-reading')
})

test('the folder drawer', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'Show folders' }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible()
  await shot(page, 'tablet-folders')
})

test('one message, full screen', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'Show folders' }).click()
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await waitForCorpus(page, READ_SUBJECTS.plain)

  // The width where it matters most: at 834px the reading pane is under 300px beside the list, and
  // full screen gives the message all of it.
  await page.getByText(READ_SUBJECTS.newsletter, { exact: true }).dblclick()
  await expect(page.getByRole('heading', { name: READ_SUBJECTS.newsletter })).toBeVisible()
  await waitForBody(page, READ_SUBJECTS.newsletter, 'Top story')
  await shot(page, 'tablet-fullscreen')
})
