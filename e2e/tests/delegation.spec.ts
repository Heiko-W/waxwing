import { expect, type Page, test } from '@playwright/test'
import { clearFileNodes, shareFileFolder } from '../stalwart/fixture.mjs'
import { revealPasswordForm } from './helpers'

/**
 * Opening someone else's files (S-4), and finding a colleague who is in no address book (S-5) —
 * both against the live Stalwart, which is the only place either can be proved.
 *
 * **Why not a unit test.** The unit suites drive `connected.delegated` and an injected
 * `FilesClient`; they can show that the screen renders the probe's answer, and they cannot show
 * that the probe's answer is right. The fact this whole feature exists to work around is a SERVER
 * fact, measured against v0.16.18 on 2026-08-21 and re-measured in both directions:
 *
 *   carol shares ONE FOLDER with alice
 *   → alice's session lists carol's account with all seventeen capabilities, mail included
 *   → `FileNode/get   { accountId: carol }` answers a list
 *   → `Mailbox/get    { accountId: carol }` answers `forbidden`
 *   → `AddressBook/get{ accountId: carol }` answers `forbidden`
 *
 * So the negative half of this suite — no mail section, no contacts section, for an account that
 * advertises both — is asserting something only this server can be asked about.
 *
 * **Where it runs and what it owns.** The shared-account config
 * (`playwright.shared.config.ts`), which is the only one with delegation turned on. It creates ONE
 * folder in carol's file storage, shares it with alice, and destroys every file node of every test
 * account afterwards — destroys rather than unshares, because revoking the last file share leaves
 * the account answering an empty list rather than `forbidden` for a while (measured), which would
 * leave a "Shared with me" section on screen in the next suite.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }
const CAROL = 'carol@waxwing.test'
const SHARED_FOLDER = `E2E shared ${Date.now()}`

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
}

async function openFiles(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible({
    timeout: 30_000,
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('S-4 — opening files someone shared', () => {
  test.beforeAll(async () => {
    await clearFileNodes()
    await shareFileFolder(CAROL, CREDENTIALS.user, SHARED_FOLDER)
  })

  test.afterAll(async () => {
    await clearFileNodes()
  })

  test('the shared account appears as a section of the reader’s OWN root', async ({ page }) => {
    await login(page)
    await openFiles(page)

    // iCloud's arrangement, and the mail rail's: one place, two sections, no account switcher.
    const shared = page.getByRole('region', { name: 'Shared with me' })
    await expect(shared).toBeVisible({ timeout: 30_000 })
    await expect(shared.getByRole('button', { name: new RegExp(CAROL) })).toBeVisible()
  })

  test('walking into it lists the owner’s files, and the way back is the breadcrumb', async ({
    page,
  }) => {
    await login(page)
    await openFiles(page)

    await page.getByRole('button', { name: new RegExp(`Open the files ${CAROL}`) }).click()

    // The heading names whose root this is — the reader is never in doubt which account they are in.
    await expect(page.getByRole('heading', { level: 1, name: CAROL })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(SHARED_FOLDER, { exact: true })).toBeVisible()

    // And the trail starts one step further back, at their own root.
    await page
      .getByRole('navigation', { name: 'Folder path' })
      .getByRole('button', { name: 'Files', exact: true })
      .click()
    await expect(page.getByRole('heading', { level: 1, name: 'Files' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Shared with me' })).toBeVisible()
  })

  test('THE ONE: a files-only share grows no mail section and no contacts section', async ({
    page,
  }) => {
    /*
     * The measured false positive, end to end. Carol's account is in alice's session with the FULL
     * capability set because of the folder above — `urn:ietf:params:jmap:mail` and
     * `urn:ietf:params:jmap:contacts` included — and neither is true. Before the probe, the mail
     * rail grew a "carol@waxwing.test" section over a folder tree that could never fill, and a sync
     * engine was started for an account whose every `Mailbox/get` answers `forbidden`.
     *
     * NOTE for whoever runs this: the shared suite's own setup ALSO delegates carol's inbox to
     * alice (`ensureDelegations`). This test is only meaningful with that revoked, which
     * `revokeAllShares()` in the sharing suite's teardown does — hence the serial mode and the
     * explicit revoke below.
     */
    const { revokeAllShares } = await import('../stalwart/fixture.mjs')
    await revokeAllShares()

    await login(page)

    // No mail section: the rail is the single-account pass-through, one ungrouped tree.
    await expect(page.getByRole('region', { name: CAROL })).toHaveCount(0)

    // No contacts section either — nothing in the contacts area names carol.
    await page.getByRole('link', { name: 'Contacts', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Address books' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(CAROL, { exact: true })).toHaveCount(0)

    // …while the files section, the one thing that IS shared, is still there.
    await openFiles(page)
    await expect(page.getByRole('region', { name: 'Shared with me' })).toBeVisible()
  })
})

test.describe('S-5 — finding a colleague who is in no address book', () => {
  test('the directory offers someone the writer has never mailed', async ({ page }) => {
    await login(page)

    // Alice has no contact card for Bob and has never written to him in this fixture, so before
    // S-5 this field could not produce his address at all.
    await page.getByRole('button', { name: 'New message', exact: true }).click()
    const to = page.getByRole('combobox', { name: 'To' })
    await expect(to).toBeVisible({ timeout: 30_000 })

    /*
     * "Baker", not "Bak". `Principal/query`'s `text` filter matches WHOLE WORDS — measured:
     * `{text:"bak"}` and `{text:"bak*"}` both answer with nothing while `{text:"Baker"}` finds him.
     * That is the server's search and not something the client can paper over; the test types what
     * a reader has to type.
     */
    await to.fill('Baker')

    const option = page.getByRole('option', { name: /Bob Baker/ })
    await expect(option).toBeVisible({ timeout: 15_000 })
    await expect(option).toContainText('bob@waxwing.test')
    // The affiliation, as a quiet line — no badge, and no separate "Directory" list.
    await expect(option).toContainText('waxwing.test')

    await option.click()
    await expect(page.getByText('bob@waxwing.test')).toBeVisible()
  })

  test('a directory that cannot be reached leaves the local suggestions alone', async ({
    page,
  }) => {
    await login(page)
    await page.getByRole('button', { name: 'New message', exact: true }).click()
    const to = page.getByRole('combobox', { name: 'To' })
    await expect(to).toBeVisible({ timeout: 30_000 })

    // Break ONLY the directory call. The recents and contact-card sources are replica reads and
    // must be untouched by it — that asymmetry is the reason the directory is queried separately.
    await page.route('**/jmap/', async (route) => {
      const body = route.request().postData() ?? ''
      if (body.includes('Principal/query')) return route.abort()
      return route.fallback()
    })

    // Someone alice HAS corresponded with, so the recents source has an answer.
    await to.fill('carol')
    await expect(page.getByRole('option', { name: /carol@waxwing\.test/ })).toBeVisible({
      timeout: 15_000,
    })
  })
})
