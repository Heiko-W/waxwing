import { expect, type Page, test } from '@playwright/test'
import { login } from './helpers'

/**
 * The files screen against the LIVE fixture — the first E2E this area has ever had.
 *
 * Until today the Files screen was the least covered surface in the app: unit tests against an
 * injected `FilesClient` and nothing that had ever spoken to Stalwart. That gap is not academic.
 * The screen's worst outage — the one recorded at the top of `files-client.ts` — was a single
 * optional argument sent as `null` instead of being omitted, which this server answers by rejecting
 * the WHOLE request with HTTP 400. Every unit test passed throughout: the fake was handed the
 * arguments the client had built, and only a real server can say whether it will accept them.
 *
 * The four findings of 2026-08-21 all live in that same blind spot, and two of them are request
 * shapes no fake can vouch for:
 *
 *   - **`parentId: null` in a `FileNode/set` patch** (moving to the root). The identical value is
 *     refused inside a query FILTER by this server; whether it is accepted as a property value is a
 *     question only Stalwart answers.
 *   - **`filter: { name: … }`** on `FileNode/query`, and a `sort` property taken from the session's
 *     own `fileNodeQuerySortOptions`. An argument this server dislikes fails the whole batch.
 *
 * So this walks the round trip a reader walks: make a folder, put a file in it, move the file, lose
 * it, find it again by name, follow the result back to where it lives, and delete the lot.
 *
 * ---
 *
 * **Where it belongs and what it owns.** Registered in `playwright.write.config.ts` beside the
 * other stateful suites (`write`, `settings`, `contacts`, `calendar`), which run serially against
 * one shared fixture. There is no file seed to reset — `write.setup.mjs` clears mail and nothing
 * else — so this suite cleans up after ITSELF, exactly as `calendar.spec.ts` does.
 *
 * Everything it creates lives under ONE run-scoped root folder, `ROOT`, whose name carries a
 * timestamp; the last step deletes that folder, and deleting a folder takes its contents with it.
 * That is the whole contract with the shared fixture:
 *
 *   - nothing at the account root survives except `ROOT`, and `ROOT` is removed at the end;
 *   - a failed run leaves one stray `E2E files …` folder behind. It is inert — a later run makes a
 *     new one with a new timestamp and never looks at the old — but it will accumulate across
 *     failures, so `WAXWING_KEEP_FIXTURE=1` users should expect to see them;
 *   - it must NOT be parallelised with anything that reads the account's file root, because the
 *     root listing is shared state. `fullyParallel: false` in the write config already guarantees
 *     that; the `serial` mode below states it locally too.
 */

const STAMP = Date.now()
const ROOT = `E2E files ${STAMP}`
const INNER = `E2E inner ${STAMP}`
const NOTE = `e2e-note-${STAMP}.txt`

/** The Files screen, reached the way a reader reaches it. */
async function openFiles(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible({
    timeout: 30_000,
  })
}

/**
 * A row's action, whether it is a button in the row or an item in that row's `⋯` menu.
 *
 * Not a convenience: `use-row-actions.ts` MEASURES the row and moves the tail of the actions into
 * the menu, so which of the two a given action is depends on the viewport and on the file's name
 * length. A test that assumed one of them would be a test of the window size.
 */
async function rowAction(page: Page, label: string, node: string): Promise<void> {
  const inRow = page.getByRole('button', { name: label, exact: true })
  const menu = page.getByRole('button', { name: `More actions for ${node}`, exact: true })
  // WAIT for the row to be in one of its two shapes before choosing between them. `isVisible()`
  // does not wait — it answers about this instant — so called straight after a navigation it says
  // "no" simply because the listing has not arrived, and the else-branch below then waited the full
  // test timeout for a `⋯` that this row never grows. The failure read like a missing menu and was
  // a missing millisecond.
  await expect(inRow.or(menu).first()).toBeVisible({ timeout: 30_000 })
  if (await inRow.isVisible()) {
    await inRow.click()
    return
  }
  await menu.click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

/** Create a folder at the level currently shown. */
async function newFolder(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('New folder', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: 'New folder', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(name, { exact: true })).toBeVisible()
}

const row = (page: Page, name: string) => page.getByText(name, { exact: true })

test.describe.configure({ mode: 'serial' })

test('a file can be filed away, lost, found by name and followed home', async ({ page }) => {
  await login(page)
  await openFiles(page)

  // ---- a folder to work in, and one inside it: a move has to cross a level to prove anything
  await newFolder(page, ROOT)
  await row(page, ROOT).click()
  await expect(page.getByRole('heading', { name: ROOT, level: 1 })).toBeVisible()
  await newFolder(page, INNER)

  // ---- upload. The hidden input is the picker's own control; `setInputFiles` is the only way in.
  await page.locator('input[type="file"]').setInputFiles({
    name: NOTE,
    mimeType: 'text/plain',
    buffer: Buffer.from('waxwing e2e\n'),
  })
  await expect(row(page, NOTE)).toBeVisible({ timeout: 30_000 })

  // ---- move it into the inner folder (D-1). The whole finding: the server changes `parentId`
  // without complaint and the client had no way to ask.
  await rowAction(page, `Move ${NOTE}`, NOTE)
  const picker = page.getByRole('dialog')
  await picker.getByRole('button', { name: ROOT, exact: true }).click()
  await picker.getByRole('button', { name: INNER, exact: true }).click()
  await picker.getByRole('button', { name: `Move to ${INNER}`, exact: true }).click()
  await expect(picker).toBeHidden()

  // Gone from where it was — which is the half a client-side test can fake, so the other half is
  // below: it has to be somewhere.
  await expect(row(page, NOTE)).toHaveCount(0)
  await expect(page.getByText(`Moved to ${INNER}.`)).toBeVisible()

  await row(page, INNER).click()
  await expect(row(page, NOTE)).toBeVisible()

  // ---- undo puts it back where it came from (ADR-021), and only a real `FileNode/set` says so
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(row(page, NOTE)).toHaveCount(0)

  // ---- find it by name from anywhere (D-3). Account-wide, so the row states the folder it is in.
  await page.getByRole('link', { name: 'Files', exact: true }).click()
  await page.getByLabel('Search files', { exact: true }).fill(NOTE)
  await expect(row(page, NOTE)).toBeVisible({ timeout: 30_000 })
  const location = page.getByRole('button', { name: `in ${ROOT}`, exact: true })
  await expect(location).toBeVisible()

  // ---- and the statement is the way back: following it lands on a TRUE breadcrumb, not on a
  // plausible one. The ancestor walk is what makes `Files / ROOT` rather than `Files / …`.
  await location.click()
  await expect(page.getByRole('heading', { name: ROOT, level: 1 })).toBeVisible()
  await expect(row(page, NOTE)).toBeVisible()

  // ---- delete asks first (B-7), and this server keeps no trash to undo it from
  //
  // Back to the account root by the BREADCRUMB, which is the way out this screen offers. The
  // primary-nav "Files" link does not do it: the folder you are in is component state, not part of
  // the URL (`path` in FilesPage.tsx), so clicking a link to the route you are already on changes
  // nothing at all. The test used to click it and then hunt for a row that was two levels above
  // where the screen still was.
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Files', level: 1 })).toBeVisible()
  await rowAction(page, `Delete ${ROOT}`, ROOT)
  const confirm = page.getByRole('dialog')
  await expect(confirm.getByText(/permanently deleted/i)).toBeVisible()
  // A folder says that its contents go with it — which is exactly what makes this the cleanup.
  await expect(confirm.getByText(/Everything inside/i)).toBeVisible()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(row(page, ROOT)).toHaveCount(0)
})

test('several files can be picked out at once and filed together', async ({ page }) => {
  // D-2. Deliberately a second test with its own folder: the first one deletes its root as its
  // last act, and a shared fixture is not the place to depend on the order two tests left it in.
  const bulkRoot = `E2E bulk ${Date.now()}`
  const one = `e2e-a-${Date.now()}.txt`
  const two = `e2e-b-${Date.now()}.txt`

  await login(page)
  await openFiles(page)
  await newFolder(page, bulkRoot)
  await row(page, bulkRoot).click()
  await newFolder(page, 'target')

  await page.locator('input[type="file"]').setInputFiles([
    { name: one, mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: two, mimeType: 'text/plain', buffer: Buffer.from('b') },
  ])
  await expect(row(page, one)).toBeVisible({ timeout: 30_000 })
  await expect(row(page, two)).toBeVisible()

  // Selecting is a mode, entered on purpose — an ordinary tap still opens a folder.
  await page.getByRole('button', { name: 'List options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Select', exact: true }).click()
  await page.getByRole('checkbox', { name: new RegExp(one) }).check()
  await page.getByRole('checkbox', { name: new RegExp(two) }).check()
  await expect(page.getByText('2 selected')).toBeVisible()

  await page.getByRole('button', { name: 'Move', exact: true }).click()
  const picker = page.getByRole('dialog')
  await picker.getByRole('button', { name: bulkRoot, exact: true }).click()
  await picker.getByRole('button', { name: 'target', exact: true }).click()
  await picker.getByRole('button', { name: 'Move to target', exact: true }).click()

  await expect(row(page, one)).toHaveCount(0)

  // LEAVE the selection mode before opening the folder. A move empties the selection but does not
  // end the mode — deliberately, so a second batch can be picked without re-entering it — and while
  // the mode is on the row IS a checkbox, so a click on it selects rather than opens. The test used
  // to click "target" here and merely tick it, then look for the moved files in the folder it had
  // never left.
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await row(page, 'target').click()
  await expect(row(page, one)).toBeVisible()
  await expect(row(page, two)).toBeVisible()

  // ---- clean up: one folder, and everything under it. By the breadcrumb, not the nav link — see
  // the note in the test above.
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Files', level: 1 })).toBeVisible()
  await rowAction(page, `Delete ${bulkRoot}`, bulkRoot)
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(row(page, bulkRoot)).toHaveCount(0)
})

/**
 * Files offline (D-4), against the LIVE fixture.
 *
 * Before the replica landed, a lost connection replaced the folder this device had just listed with
 * "Your files could not be loaded." — over data it was holding the whole time. Files joined Mail and
 * Contacts in the replica; this is the browser-level proof that the seams are actually connected.
 *
 * What only a browser can show here: that the REAL sync engine walked the tree into IndexedDB, that
 * the REAL screen reads it back when `navigator.onLine` flips, and that the search — which is a
 * local pass over the replicated tree now, not a `FileNode/query` — still answers with no network.
 * Every one of those is correct in isolation upstream and proves nothing about the wiring.
 *
 * No reload: `login()` does not tick "Stay signed in", so a reload lands back on the sign-in form.
 * Leaving the screen and coming back unmounts `FilesPage` and takes its component state with it, so
 * everything drawn afterwards can only have come from the replica.
 */
test('offline, the file list keeps showing what it already has (D-4)', async ({
  page,
  context,
}) => {
  const folder = `E2E offline ${Date.now()}`
  await login(page)
  await openFiles(page)

  // ---- something to look at, made while there is still a network
  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('New folder', { exact: true }).fill(folder)
  await dialog.getByRole('button', { name: 'New folder', exact: true }).click()
  await expect(row(page, folder)).toBeVisible()

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
    await page.getByRole('link', { name: 'Files', exact: true }).click()

    await expect(row(page, folder)).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByRole('status').filter({ hasText: /Not updating while offline/ }),
    ).toBeVisible()
    await expect(page.getByText('The files could not be loaded.')).toHaveCount(0)

    // ---- and the search still answers, because it is a pass over the replica rather than a query
    await page.getByRole('searchbox', { name: 'Search files' }).fill(folder)
    await expect(row(page, folder)).toBeVisible({ timeout: 15_000 })
    await page.getByRole('searchbox', { name: 'Search files' }).fill('')
  } finally {
    await context.setOffline(false)
  }

  // ---- clean up, back online
  await expect(page.getByRole('status').filter({ hasText: /^Offline$/ })).toBeHidden({
    timeout: 15_000,
  })
  await rowAction(page, `Delete ${folder}`, folder)
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(row(page, folder)).toHaveCount(0)
})
