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
  if (await inRow.isVisible().catch(() => false)) {
    await inRow.click()
    return
  }
  await page.getByRole('button', { name: `More actions for ${node}`, exact: true }).click()
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
  await page.getByRole('link', { name: 'Files', exact: true }).click()
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
  await row(page, 'target').click()
  await expect(row(page, one)).toBeVisible()
  await expect(row(page, two)).toBeVisible()

  // ---- clean up: one folder, and everything under it
  await page.getByRole('link', { name: 'Files', exact: true }).click()
  await rowAction(page, `Delete ${bulkRoot}`, bulkRoot)
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(row(page, bulkRoot)).toHaveCount(0)
})
