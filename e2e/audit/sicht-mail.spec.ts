import { expect, type Page, test } from '@playwright/test'
import { check, shot, signIn } from './sicht-helpers'

/**
 * Visual sweep of the mail surfaces this round added: "Manage folders" (drag AND keyboard
 * reordering, hiding), "Folder info → Use this folder as …", the search scope with its third
 * entry, the new sorts, the send-options dialog, the Reply-To field and the attach-from-Files
 * picker (a sheet on the phone).
 */

const phone = (page: Page) => (page.viewportSize()?.width ?? 0) < 640

/** The folder tree is an off-canvas drawer below 64em; the toggle brings it in. */
async function openFolders(page: Page): Promise<void> {
  const toggle = page.locator('#waxwing-folder-toggle')
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click()
  }
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
}

/**
 * Put the drawer away again.
 *
 * Not optional bookkeeping: while it is open the drawer covers the list AND its own toggle, so
 * anything the next step wants to reach is behind it.
 */
async function closeFolders(page: Page): Promise<void> {
  const toggle = page.locator('#waxwing-folder-toggle')
  if ((await toggle.count()) === 0) return
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') return
  // The drawer's own close button rather than Escape: it is what a finger has, and it is inside
  // the panel, so it works whatever the focus did when the dialog above it closed.
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: 'Hide folders', exact: true })
    .click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
}

test('mail: manage folders, folder info, search scope, sorting', async ({ page }) => {
  test.setTimeout(300_000)
  const stamp = Date.now() % 100000
  const folder = `Sicht ${test.info().project.name} ${stamp}`
  // TWO of them, because reordering needs something to reorder past — the standard folders carry
  // no grip at all ("Always shown"), so a single custom folder makes the drag untestable.
  const second = `Zicht ${test.info().project.name} ${stamp}`

  await signIn(page)
  await openFolders(page)

  // Folders of one's own — "Manage folders" only appears once there is something to manage.
  for (const name of [folder, second]) {
    await openFolders(page)
    await page.getByRole('button', { name: 'New folder', exact: true }).first().click()
    const create = page.getByRole('dialog')
    await create.getByLabel('Folder name', { exact: true }).fill(name)
    await create.getByRole('button', { name: /^(Create|New folder)$/ }).click()
    await expect(page.getByRole('treeitem', { name: new RegExp(name) })).toBeVisible({
      timeout: 30_000,
    })
  }
  await shot(page, 'mail-ordnerbaum')
  await check(page, 'folder tree')

  // ---- Manage folders
  await openFolders(page)
  await page.getByRole('button', { name: 'Manage folders', exact: true }).click()
  const manage = page.getByRole('dialog')
  await expect(manage).toBeVisible()
  await shot(page, 'mail-ordner-verwalten')
  await check(page, 'manage folders')

  // The grab handle is the control this screen adds, and the one a finger has to hit.
  const handle = manage.getByRole('button', { name: `Reorder ${folder}`, exact: true })
  await expect(handle).toBeVisible()
  await handle.focus()
  await page.keyboard.press('Space')
  await shot(page, 'mail-ordner-verwalten-aufgenommen')
  await check(page, 'manage folders, a folder picked up by keyboard')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Space')
  await page.waitForTimeout(600)
  await shot(page, 'mail-ordner-verwalten-tastatur')
  await check(page, 'manage folders, reordered by keyboard')

  // And the pointer path, which is a different code path and a different picture: the row under
  // the cursor has to say where it would land.
  const from = await handle.boundingBox()
  const target = manage.getByRole('button', { name: `Reorder ${second}`, exact: true })
  const to = await target.boundingBox()
  expect(from, 'the grip has no geometry').not.toBeNull()
  expect(to, 'the second grip has no geometry').not.toBeNull()
  if (from !== null && to !== null) {
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    // Past the row's MIDPOINT, which is what decides the drop index.
    await page.mouse.move(to.x + to.width / 2, to.y + to.height, { steps: 12 })
    // A picture only: mid-press every control carries `.button:active`'s `scale(0.97)`, so a 44px
    // grip measures 43 and the size check would report a defect that exists for 60ms.
    await shot(page, 'mail-ordner-verwalten-gezogen')
    await page.mouse.up()
    await page.waitForTimeout(600)
  }

  // Hiding: the switch beside the name. `role=switch`, not `checkbox` — `Switch` follows the APG
  // switch pattern, and asking for a checkbox here silently found nothing and skipped the surface.
  const hide = manage.getByRole('switch', { name: /in the sidebar$/ }).first()
  await expect(hide).toBeVisible()
  await hide.click()
  await expect(hide).toHaveAttribute('aria-checked', 'false')
  await shot(page, 'mail-ordner-verwalten-ausgeblendet')
  await check(page, 'manage folders, one folder hidden')
  await hide.click()
  await expect(hide).toHaveAttribute('aria-checked', 'true')
  await manage.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await closeFolders(page)

  // ---- Folder info → "Use this folder as …"
  await openFolders(page)
  const row = page.getByRole('treeitem', { name: new RegExp(folder) })
  await row.hover()
  await row.getByRole('button', { name: /^Folder actions/ }).click()
  await page.getByRole('menuitem', { name: /^Folder info/ }).click()
  const info = page.getByRole('dialog')
  await expect(info).toBeVisible()
  await expect(info.getByLabel('Use this folder as…', { exact: true })).toBeVisible()
  await shot(page, 'mail-ordnerinfo')
  await check(page, 'folder info, "use this folder as"')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await closeFolders(page)

  // ---- Search: the scope row with its third entry
  const search = page.getByRole('searchbox', { name: 'Search', exact: true })
  await search.click()
  await search.fill('report')
  await expect(page.getByLabel('Search in', { exact: true })).toBeVisible()
  await page.getByLabel('Search in', { exact: true }).selectOption('everywhere')
  await search.press('Enter')
  await page.waitForTimeout(1500)
  await shot(page, 'mail-suche-bereich')
  await check(page, 'search scope row')
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()

  // ---- Sorting
  const viewOptions = page.getByRole('button', { name: 'Show view options', exact: true })
  if (await viewOptions.count()) await viewOptions.click()
  await expect(page.getByLabel('Sort', { exact: true })).toBeVisible()
  await page.getByLabel('Sort', { exact: true }).selectOption('size')
  await shot(page, 'mail-sortierung')
  await check(page, 'list view options / sorting')
  await page.getByLabel('Sort', { exact: true }).selectOption('date')

  // ---- clean up: remove both folders again
  for (const name of [folder, second]) {
    await openFolders(page)
    const doomed = page.getByRole('treeitem', { name: new RegExp(name) })
    await doomed.hover()
    await doomed.getByRole('button', { name: /^Folder actions/ }).click()
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByRole('treeitem', { name: new RegExp(name) })).toHaveCount(0, {
      timeout: 30_000,
    })
    await closeFolders(page)
  }
})

test('mail: send options, Reply-To, attach from Files', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)

  await page.getByRole('button', { name: 'New message', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Message body' })).toBeVisible({ timeout: 30_000 })
  await shot(page, 'verfassen')
  await check(page, 'composer')

  // ---- Reply-To
  await page.getByRole('button', { name: 'Reply-To', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Reply-To', exact: true })).toBeVisible()
  await shot(page, 'verfassen-antwort-an')
  await check(page, 'composer with the Reply-To field')

  // ---- Send options
  await page.getByRole('button', { name: 'Send options', exact: true }).click()
  const options = page
    .getByRole('dialog')
    .filter({ has: page.getByLabel('Priority', { exact: true }) })
  await expect(options.getByLabel('Priority', { exact: true })).toBeVisible()
  await shot(page, 'verfassen-sendeoptionen')
  await check(page, 'send options')
  await options.getByLabel('Priority', { exact: true }).selectOption('high')
  await options.getByRole('switch', { name: /delivery receipt/ }).click()
  await shot(page, 'verfassen-sendeoptionen-gesetzt')
  await check(page, 'send options, set')
  await options.getByRole('button', { name: 'Done', exact: true }).click()
  // NOT a dialog count: the composer window is itself a `role=dialog`, so zero is never right here.
  await expect(page.getByLabel('Priority', { exact: true })).toHaveCount(0)

  // ---- Attach from Files
  await page.getByRole('button', { name: 'Attach file', exact: true }).click()
  const fromFiles = page.getByRole('menuitem', { name: 'From Files…', exact: true })
  if (await fromFiles.count()) {
    await fromFiles.click()
    await expect(page.getByRole('heading', { name: 'Attach from Files' })).toBeVisible({
      timeout: 30_000,
    })
    await page.waitForTimeout(1200)
    await shot(page, 'verfassen-anhang-aus-dateien')
    await check(page, 'attach from Files')
    await page.keyboard.press('Escape')
  } else {
    console.log('[sicht] attach-from-Files not offered: the server advertises no file storage')
    await page.keyboard.press('Escape')
  }

  await page.getByRole('button', { name: 'Discard draft', exact: true }).click()
  const confirm = page.getByRole('button', { name: 'Discard', exact: true })
  if (await confirm.count()) await confirm.click()
  if (phone(page)) await expect(page.getByRole('textbox', { name: 'Message body' })).toHaveCount(0)
})
