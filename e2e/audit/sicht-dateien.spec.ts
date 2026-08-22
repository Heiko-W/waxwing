import { expect, test } from '@playwright/test'
import { check, goTo, shot, signIn, truncated } from './sicht-helpers'

/**
 * Visual sweep of the Files surfaces this round added: the move picker, multi-selection
 * ("Select" plus the selection bar), search, sorting and the delete question.
 *
 * Everything is made under one run-scoped root and that root is deleted at the end, the contract
 * `e2e/tests/files.spec.ts` documents for sharing the fixture.
 */

const STAMP = Date.now() % 100000

test('files: move, multiple selection, search, sorting, delete', async ({ page }) => {
  test.setTimeout(300_000)
  const project = test.info().project.name
  const root = `Sicht ${project} ${STAMP}`
  const inner = `Sicht inner ${project} ${STAMP}`
  const one = `sicht-eins-${project}-${STAMP}.txt`
  const two = `sicht-zwei-${project}-${STAMP}.txt`

  await signIn(page)
  await goTo(page, 'Files')
  // `List options` is the one control the bar keeps at every width — below 40em "New folder" and
  // "Upload" are inside it, so waiting for either of those is waiting for the desktop shape.
  await expect(page.getByRole('button', { name: 'List options', exact: true })).toBeVisible({
    timeout: 45_000,
  })
  await shot(page, 'dateien-liste')
  await check(page, 'files list')

  async function newFolder(name: string): Promise<void> {
    const inBar = page.getByRole('button', { name: 'New folder', exact: true })
    if (await inBar.count()) await inBar.click()
    else {
      await page.getByRole('button', { name: 'List options', exact: true }).click()
      await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
    }
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('New folder', { exact: true }).fill(name)
    await dialog.getByRole('button', { name: 'New folder', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 30_000 })
  }

  await newFolder(root)
  await page.getByText(root, { exact: true }).click()
  await expect(page.getByRole('heading', { name: root, level: 1 })).toBeVisible()
  await newFolder(inner)

  // Two files, so the selection bar and the sorts have something to work on.
  for (const [name, body] of [
    [one, 'a'.repeat(40)],
    [two, 'b'.repeat(4000)],
  ] as const) {
    await page.setInputFiles('input[type=file]', {
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from(body),
    })
    await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 45_000 })
  }
  await shot(page, 'dateien-ordner')
  await check(page, 'a folder with two files')

  /*
   * The failure mode this screen is most at risk from: a name squeezed by the controls beside it.
   * The bar was measured showing 24px of a 132px folder name on 2026-08-22 — one character.
   *
   * Half is the line between "this name is long" (correct: it ellipsises) and "this name was not
   * given the room it had" (the defect). A rule that forbade every ellipsis would forbid long file
   * names, which is not a thing a file browser may do.
   */
  expect
    .soft(await truncated(page, 0.5), 'a name lost more than half its width to the controls')
    .toEqual([])

  // ---- sorting
  await page.getByRole('button', { name: 'List options', exact: true }).click()
  await shot(page, 'dateien-sortierung')
  await check(page, 'files list options / sorting')
  await page.getByRole('menuitem', { name: 'Sort by size', exact: true }).click()
  await page.waitForTimeout(400)
  await shot(page, 'dateien-nach-groesse')
  await check(page, 'files sorted by size')

  // ---- multiple selection
  await page.getByRole('button', { name: 'List options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Select', exact: true }).click()
  await page.getByRole('checkbox', { name: new RegExp(one) }).check()
  await page.getByRole('checkbox', { name: new RegExp(two) }).check()
  await expect(page.getByText('2 selected')).toBeVisible()
  await shot(page, 'dateien-auswahlleiste')
  await check(page, 'files selection bar')

  // ---- the move picker, for two at once
  await page.getByRole('button', { name: 'Move', exact: true }).click()
  const picker = page.getByRole('dialog')
  await expect(picker).toBeVisible()
  await shot(page, 'dateien-verschieben')
  await check(page, 'files move picker')
  // The picker always starts at the account root, so the way down is root then inner.
  await picker.getByRole('button', { name: root, exact: true }).click()
  await picker.getByRole('button', { name: inner, exact: true }).click()
  await shot(page, 'dateien-verschieben-ziel')
  await check(page, 'files move picker, one level down')
  await picker.getByRole('button', { name: `Move to ${inner}`, exact: true }).click()
  await expect(page.getByText(`Moved to ${inner}.`)).toBeVisible({ timeout: 45_000 })

  // ---- search
  await page.getByLabel('Search files', { exact: true }).fill(two)
  await expect(page.getByRole('button', { name: `in ${inner}`, exact: true })).toBeVisible({
    timeout: 45_000,
  })
  await shot(page, 'dateien-suche')
  await check(page, 'files search')
  await page.getByLabel('Search files', { exact: true }).fill('')

  // ---- delete, with its question. Back to the root through the BREADCRUMB: the nav link is
  // already on Files, so pressing it again changes nothing.
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Files', level: 1 })).toBeVisible()
  // Selection mode may still be on from the move above — the menu then offers "Done", not
  // "Select", and asking for the one that is not there is a five-minute wait.
  await page.getByRole('button', { name: 'List options', exact: true }).click()
  const start = page.getByRole('menuitem', { name: 'Select', exact: true })
  if (await start.count()) await start.click()
  else await page.keyboard.press('Escape')
  await page.getByRole('checkbox', { name: new RegExp(root) }).check()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const confirm = page.getByRole('dialog')
  await expect(confirm.getByText(/permanently deleted/i)).toBeVisible()
  await shot(page, 'dateien-loeschen')
  await check(page, 'files delete confirmation')
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText(root, { exact: true })).toHaveCount(0, { timeout: 45_000 })
})
