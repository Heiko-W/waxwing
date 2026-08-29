import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { revealPasswordForm, SYNC_BUDGET_MS } from './helpers'

/**
 * Public-computer mode, end to end (FR-AUTH-09).
 *
 * This suite exists because the promise is about **what is left on a disk**, and nothing in jsdom
 * can check that. The unit tests cover the sweep's logic against a fake IndexedDB; only a real
 * browser can show that signing in actually writes to a throwaway database, that the durable one is
 * never created, and that a crash leaves nothing a later user could read.
 *
 * The crash case is the one worth having. `pagehide` is best-effort by construction — a browser
 * gives a dying page very little time and `deleteDatabase` may not finish — so the guarantee rests
 * on the sweep at the NEXT start. That is simulated here honestly: an orphaned database with its
 * index entry removed, which is exactly the state a killed browser leaves behind.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }
const EPHEMERAL_PREFIX = 'waxwing-replica-eph-'
const DURABLE = 'waxwing-replica'

const databases = (page: Page): Promise<string[]> =>
  page.evaluate(async () =>
    (await indexedDB.databases()).map((info) => info.name ?? '').filter(Boolean),
  )

const webStorageKeys = (page: Page): Promise<{ local: string[]; session: string[] }> =>
  page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }))

/**
 * What may still be on this origin once a session has ended: preferences, and nothing that names a
 * person or a server.
 *
 * `waxwing.accounts` is the key this list exists for. It holds the mailbox address and the server
 * origin of everyone who has signed in on this browser, the account menu reads it back as "switch
 * to alice@example.com", and no production path removed a row from it — so a public-computer
 * session left the next person an address, and "Sign out & remove data" did too. The tests below
 * are the only executable form of "keeps no sign-in on this device" that covers the WHOLE origin
 * store rather than IndexedDB alone.
 *
 * `waxwing.ephemeralDbs` is allowed on purpose: it names throwaway databases awaiting a sweep, and
 * Firefox has no `indexedDB.databases()` to find them any other way.
 */
const ALLOWED_AFTER_SIGN_OUT = new Set([
  'waxwing.theme',
  'waxwing.accent',
  'waxwing.readingPane',
  'waxwing.folderRail',
  'waxwing.cacheDays',
  'waxwing.ephemeralDbs',
  'waxwing.pwa.chunkReload',
  'i18nextLng',
])

async function expectNoIdentityLeft(page: Page): Promise<void> {
  const keys = await webStorageKeys(page)
  expect(keys.local.filter((key) => !ALLOWED_AFTER_SIGN_OUT.has(key))).toEqual([])
  expect(keys.session.filter((key) => !ALLOWED_AFTER_SIGN_OUT.has(key))).toEqual([])
}

test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('FR-AUTH-09 public-computer mode', () => {
  test('signs in to a throwaway replica and never creates the durable one', async ({ page }) => {
    await page.goto('/')
    await revealPasswordForm(page)
    await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
    await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
    await page.getByLabel('Public or shared computer').check()

    // The two boxes make contradictory promises; ticking this one must settle it.
    await expect(page.getByLabel('Stay signed in')).toBeDisabled()
    await expect(page.getByLabel('Stay signed in')).not.toBeChecked()

    await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
    await page.getByRole('treeitem', { name: /Inbox/ }).click()
    // Wait for real mail to land, so the replica genuinely holds messages rather than nothing.
    await expect(page.getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 60_000 })

    const names = await databases(page)
    expect(names.some((n) => n.startsWith(EPHEMERAL_PREFIX))).toBe(true)
    expect(names).not.toContain(DURABLE)
  })

  test('plain Sign out removes it — not just "remove data"', async ({ page }) => {
    await page.goto('/')
    await revealPasswordForm(page)
    await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
    await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
    await page.getByLabel('Public or shared computer').check()
    await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
    await page.getByRole('treeitem', { name: /Inbox/ }).click()
    await expect(page.getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 60_000 })

    // The ORDINARY sign-out, deliberately. Someone leaving a library terminal in a hurry picks the
    // first item; a mode whose guarantee depended on them finding the second one would not be one.
    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: /^Webmail for/ })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })

    await expect(async () => {
      expect((await databases(page)).some((n) => n.startsWith(EPHEMERAL_PREFIX))).toBe(false)
    }).toPass({ timeout: 20_000 })
    // The other two storages, which the mode used to leave untouched — see ALLOWED_AFTER_SIGN_OUT.
    await expectNoIdentityLeft(page)
  })

  /**
   * The FR-AUTH-05 half of the same promise. The confirmation dialog says this deletes "mail and
   * settings on this device" — and it did delete the mail, while the list of mailboxes that have
   * signed in here stayed in `localStorage` for the next person to find in the account menu.
   */
  test('"Sign out and remove data" leaves no identity in the web storages either', async ({
    page,
  }) => {
    await page.goto('/')
    await revealPasswordForm(page)
    await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
    await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
    await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
    await page.getByRole('treeitem', { name: /Inbox/ }).click()
    await expect(page.getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 60_000 })

    // A DURABLE session, so the registry row this asserts about is genuinely written first.
    await expect(async () => {
      const keys = await webStorageKeys(page)
      expect(keys.local).toContain('waxwing.accounts')
    }).toPass({ timeout: 20_000 })

    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByRole('menuitem', { name: 'Sign out and remove data' }).click()
    await page.getByRole('button', { name: 'Remove data and sign out' }).click()
    await expect(page.getByRole('heading', { level: 1, name: /^Webmail for/ })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })

    await expect(async () => {
      await expectNoIdentityLeft(page)
    }).toPass({ timeout: 20_000 })
  })

  test('a crashed session is swept at the next start', async ({ page }) => {
    await page.goto('/')
    await page
      .getByRole('heading', { level: 1, name: /^Webmail for/ })
      .waitFor({ timeout: SYNC_BUDGET_MS })

    // Exactly what a killed browser leaves: the database, and no index entry pointing at it —
    // because the entry is written at sign-in and cleared by the sweep, not by the crash.
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        const request = indexedDB.open('waxwing-replica-eph-crashed-session', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('emails')
        request.onsuccess = () => {
          request.result.close()
          resolve(undefined)
        }
      })
      localStorage.removeItem('waxwing.ephemeralDbs')
    })
    expect((await databases(page)).some((n) => n.startsWith(EPHEMERAL_PREFIX))).toBe(true)

    await page.reload()
    await page
      .getByRole('heading', { level: 1, name: /^Webmail for/ })
      .waitFor({ timeout: SYNC_BUDGET_MS })

    // The whole point of the mode: the previous person's mail is gone before this one sees a thing.
    await expect(async () => {
      expect((await databases(page)).some((n) => n.startsWith(EPHEMERAL_PREFIX))).toBe(false)
    }).toPass({ timeout: 20_000 })
  })

  test('OAuth honours it too — no throwaway replica, and no session to restore', async ({
    page,
  }) => {
    // The gap this closes was the whole mode failing where it matters most. The checkbox lived
    // inside the Basic form and reached `submitBasic` alone, while OAuth — the PRIMARY button on a
    // default Stalwart deployment, sitting directly above it — ignored it: a durable replica AND a
    // persisted refresh token, under a hint promising that nothing would be kept.
    await page.goto('/')
    await page.getByLabel('Public or shared computer').check()
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // Stalwart's own /login SPA, same-origin through the preview proxy.
    await page.locator('#username').fill(CREDENTIALS.user)
    await page.locator('#password').fill(CREDENTIALS.pass)
    await page.locator('#login-form button[type="submit"]').click()

    await page.getByRole('treeitem', { name: /Inbox/ }).click()
    await expect(page.getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 60_000 })

    const names = await databases(page)
    expect(names.some((n) => n.startsWith(EPHEMERAL_PREFIX))).toBe(true)
    expect(names).not.toContain(DURABLE)

    // And the half that only OAuth has: a reload must NOT walk back in. A refresh token left on a
    // library terminal is worse than the cached mail — it fetches the mail again.
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: /^Webmail for/ })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
  })

  test('an ORDINARY OAuth sign-in is still restored on reload — the counter-test', async ({
    page,
  }) => {
    // Without this, "never persist anything" would look identical to the test above and would
    // silently end offline cold start for every normal user.
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.locator('#username').fill(CREDENTIALS.user)
    await page.locator('#password').fill(CREDENTIALS.pass)
    await page.locator('#login-form button[type="submit"]').click()
    await page.getByRole('treeitem', { name: /Inbox/ }).click()
    await expect(page.getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 60_000 })

    await page.reload()
    await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({
      timeout: SYNC_BUDGET_MS,
    })
    expect(await databases(page)).toContain(DURABLE)
  })

  test('an ORDINARY sign-in still keeps its cache', async ({ page }) => {
    // The counter-test, and it is not a formality: a sweep with a slightly wider prefix, or one
    // that ran unconditionally, would silently delete every normal user's offline mail. Nothing
    // else in this suite would notice.
    await page.goto('/')
    await revealPasswordForm(page)
    await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
    await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
    await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
    await page.getByRole('treeitem', { name: /Inbox/ }).click()
    await expect(page.getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 60_000 })

    const names = await databases(page)
    expect(names).toContain(DURABLE)
    expect(names.some((n) => n.startsWith(EPHEMERAL_PREFIX))).toBe(false)
  })
})
