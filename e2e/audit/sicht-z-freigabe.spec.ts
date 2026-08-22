import { expect, test } from '@playwright/test'
import {
  clearFileNodes,
  clearShareNotifications,
  ensureDelegations,
  revokeAllShares,
  shareFileFolder,
  shareInbox,
} from '../stalwart/fixture.mjs'
import { check, goTo, shot, signIn } from './sicht-helpers'

/**
 * Visual sweep of the sharing surfaces this round added: the share dialog for a mail folder, the
 * card for incoming shares at the top of the folder rail, and the shared files / shared address
 * books in their rails.
 *
 * Delegation is opt-in for the reason `shared.setup.mjs` gives — it regroups the sidebar by
 * account, which every other suite's locators would then trip over — so this file turns it on for
 * itself and turns it off again afterwards.
 *
 * The `z-` in the file name is load-bearing: Playwright runs files in path order, and this one has
 * to be LAST. Measured on Stalwart v0.16.18 — after every grant is revoked and every shared node
 * destroyed, alice's session still lists carol's account, so the fixture's own `smoke()` refuses
 * the next `up()` with "a previous shared-account run did not revoke". Only `pnpm e2e:server:down`
 * clears it. Anything that runs after this file therefore runs against a fixture in a state it did
 * not ask for.
 */

const CAROL = 'carol@waxwing.test'
const SHARED_FOLDER = 'Sicht shared'

test.beforeAll(async () => {
  await ensureDelegations()
  await shareFileFolder('carol', 'alice', SHARED_FOLDER)
  await clearShareNotifications('alice')
  // A REAL change, or the server mints no notification: the fixture granted `ro`, so `rw` is one.
  await shareInbox('carol', 'alice', 'rw')
})

test.afterAll(async () => {
  await revokeAllShares().catch(() => {})
  /*
   * And the FILE share, which `revokeAllShares` does not reach — it walks mailboxes only. A shared
   * FileNode is enough on its own to put a second account in alice's session, and the fixture's own
   * `smoke()` then refuses the next `up()` with "expected no shared accounts". Measured: that is
   * exactly what a first run of this file left behind.
   */
  await clearFileNodes().catch(() => {})
  for (const who of ['alice', 'bob', 'carol']) await clearShareNotifications(who).catch(() => {})
})

/** The folder tree is an off-canvas drawer below 64em. */
async function openFolders(page: import('@playwright/test').Page): Promise<void> {
  const toggle = page.locator('#waxwing-folder-toggle')
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click()
  }
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
}

test('sharing: the incoming card, the share dialog, the shared rails', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)
  await openFolders(page)

  // ---- the card for incoming shares, at the top of the rail
  const strip = page.getByRole('region', { name: 'New shares' })
  await expect(strip).toBeVisible({ timeout: 45_000 })
  await expect(strip).toContainText(CAROL)
  await shot(page, 'freigabe-eingehend')
  await check(page, 'incoming-shares card')

  // The rail must still be usable behind it: the account section is the thing it could push away.
  await expect(page.getByRole('region', { name: 'alice@waxwing.test' })).toBeVisible()

  // ---- the share dialog for a mail folder
  const own = page
    .getByRole('region', { name: 'alice@waxwing.test' })
    .getByRole('treeitem', { name: /Inbox/ })
  await own.hover()
  await own.getByRole('button', { name: /Folder actions/ }).click()
  await page.getByRole('menuitem', { name: 'Share…', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Search people', { exact: true })).toBeVisible({ timeout: 45_000 })
  await shot(page, 'freigabe-dialog')
  await check(page, 'mailbox share dialog')

  await dialog.getByLabel('Search people', { exact: true }).fill('carol')
  const grant = dialog.getByRole('button', { name: /Give .*[Cc]arol.* access/ })
  await expect(grant).toBeVisible({ timeout: 45_000 })
  await shot(page, 'freigabe-dialog-treffer')
  await check(page, 'share dialog, a match found')
  await grant.click()
  await expect(dialog.getByRole('combobox', { name: /What .*[Cc]arol.* may do/ })).toBeVisible()
  await shot(page, 'freigabe-dialog-erteilt')
  await check(page, 'share dialog, access granted')
  // Take it away again — this dialog writes to the server.
  await dialog.getByRole('button', { name: /Remove .*[Cc]arol/ }).click()
  await expect(dialog.getByText('Only you.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // ---- the shared files rail
  await goTo(page, 'Files')
  await expect(page.getByRole('heading', { name: 'Files', level: 1 })).toBeVisible({
    timeout: 45_000,
  })
  const sharedFiles = page.getByText('Shared with me', { exact: true })
  if (await sharedFiles.count()) {
    await shot(page, 'freigabe-dateien')
    await check(page, 'shared files rail')
  } else {
    console.log('[sicht] "Shared with me" is not on the Files screen for this account')
    await shot(page, 'freigabe-dateien-fehlt')
  }

  // ---- shared address books
  await goTo(page, 'Contacts')
  await page.waitForTimeout(2000)
  await shot(page, 'freigabe-kontakte')
  await check(page, 'contacts rail with shared books')
})
