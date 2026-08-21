import { expect, type Page, test } from '@playwright/test'
import {
  clearShareNotifications,
  ensureDelegations,
  revokeAllShares,
  shareInbox,
} from '../stalwart/fixture.mjs'
import { seedReadMail } from '../stalwart/seed-read.mjs'
import { revealPasswordForm } from './helpers'

/**
 * Sharing a mail folder (S-3) and being told about one (S-1), end to end against a live Stalwart
 * that really enforces the grants.
 *
 * Runs in the shared-account suite (`playwright.shared.config.ts`), which is the only configuration
 * where delegation is turned on — see `shared.setup.mjs` on why that is opt-in.
 *
 * **Both features are about state that OUTLIVES the browser**, which is why neither can be asserted
 * anywhere but here:
 *
 *  - a grant is a `Mailbox/set … shareWith` on the server, and the proof that it landed is that
 *    reopening the dialog — a fresh `Mailbox/get properties:['shareWith']`, not a React state — still
 *    lists the person;
 *  - a `ShareNotification` is created by the SERVER when someone else shares something, and only a
 *    second real account can create one.
 *
 * Everything these tests grant, they revoke; `shared.teardown.mjs` sweeps whatever an aborted run
 * leaves behind (`revokeAllShares`), because a share left on alice's account reshapes bob's and
 * carol's sidebars in every later suite.
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }
const OWN = 'alice@waxwing.test'
const CAROL = 'carol@waxwing.test'

async function login(page: Page, options: { stay?: boolean } = {}): Promise<void> {
  await page.goto('/')
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  // `stay` for any test that RELOADS: without it the token lives only in memory (NFR-SEC-02), so a
  // reload lands back on the sign-in step and the wait below never resolves.
  if (options.stay) await page.getByLabel('Stay signed in').check()
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  // Either shape of the folder rail. On a phone-width viewport it is a DRAWER — there is no
  // `navigation "Folders"` on screen at all until the button is pressed — so waiting only for the
  // navigation made the one test that resizes fail before it had done anything.
  await expect(
    page
      .getByRole('navigation', { name: 'Folders' })
      .or(page.getByRole('button', { name: 'Folders' }))
      .first(),
  ).toBeVisible({ timeout: 30_000 })
}

/** Alice's OWN Inbox row — the one she owns and may therefore share. */
function ownInbox(page: Page) {
  return page.getByRole('region', { name: OWN }).getByRole('treeitem', { name: /Inbox/ })
}

/** Open the folder's ⋯ menu and pick "Share…". */
async function openShareDialog(page: Page): Promise<void> {
  const row = ownInbox(page)
  await expect(row).toBeVisible({ timeout: 30_000 })
  // The menu button lives inside the row and only reveals on hover/focus.
  await row.hover()
  await row.getByRole('button', { name: /Folder actions/ }).click()
  await page.getByRole('menuitem', { name: 'Share…' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('S-3 — sharing a mail folder', () => {
  test.afterEach(async () => {
    // Belt and braces: a failed assertion must not leave alice's Inbox shared, or the NEXT suite's
    // `treeitem name=/Inbox/` locator becomes ambiguous inside carol's newly grouped sidebar.
    //
    // …and then PUT THE SUITE'S OWN GRANTS BACK, which is not optional. `revokeAllShares` sweeps
    // every account, including the two `shared.setup.mjs` granted — and those are what make this
    // sidebar account-grouped at all. Without them `getByRole('region', { name: OWN })` matches
    // nothing, so the first test here quietly disarmed every test after it: eight 30 s timeouts
    // hunting for a region that the cleanup had dissolved. `ensureDelegations` is idempotent and
    // rewrites exactly the fixed pair set, so this restores the baseline without inventing one.
    await revokeAllShares()
    await ensureDelegations()
  })

  test('the “Share…” entry is offered on a folder the user OWNS', async ({ page }) => {
    await login(page)
    const row = ownInbox(page)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.hover()
    await row.getByRole('button', { name: /Folder actions/ }).click()
    // `myRights.mayShare` is true for an owner — measured, the server returns it on every
    // `Mailbox/get`, ten permission keys and not the RFC's nine.
    await expect(page.getByRole('menuitem', { name: 'Share…' })).toBeVisible()
  })

  test('it is NOT offered on a folder that was merely shared with the user', async ({ page }) => {
    // carol granted alice read-only (the fixture's DELEGATIONS). `mayShare` is false there, and an
    // entry that produced a refusal the user cannot act on is worse than no entry.
    await login(page)
    const carolInbox = page
      .getByRole('region', { name: CAROL })
      .getByRole('treeitem', { name: /Inbox/ })
    await expect(carolInbox).toBeVisible({ timeout: 30_000 })
    await carolInbox.hover()
    const menu = carolInbox.getByRole('button', { name: /Folder actions/ })
    // A read-only share may have no menu at all — every entry is rights-gated. Either way, no Share.
    if (await menu.isVisible()) {
      await menu.click()
      await expect(page.getByRole('menuitem', { name: 'Share…' })).toHaveCount(0)
      await page.keyboard.press('Escape')
    }
  })

  test('a grant SURVIVES the dialog — the server has it, not just the screen', async ({ page }) => {
    await login(page)
    await openShareDialog(page)

    // Before: nobody.
    await expect(page.getByText('Only you.')).toBeVisible({ timeout: 30_000 })

    // Grant carol "View". The role names are what the user picks; the ten permission keys are what
    // goes on the wire, and `maySetSeen` is false in this one on purpose.
    await page.getByLabel('Search people').fill('carol')
    const grant = page.getByRole('button', { name: /Give .*[Cc]arol.* access/ })
    await expect(grant).toBeVisible({ timeout: 15_000 })
    await grant.click()
    await expect(page.getByText('Only you.')).toHaveCount(0)

    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // REOPEN. This is the assertion: the dialog fetches `Mailbox/get properties:['shareWith']`
    // afresh every time it opens (the replica has never held the property — the sync engine's
    // `Mailbox/get` sends no `properties`, so the server omits it). Carol being here means the
    // grant is on the server.
    await openShareDialog(page)
    await expect(page.getByRole('combobox', { name: /What .*[Cc]arol.* may do/ })).toHaveValue(
      'viewer',
    )
  })

  test('a role change replaces the grant rather than merging into it', async ({ page }) => {
    await login(page)
    await openShareDialog(page)
    await page.getByLabel('Search people').fill('carol')
    await page.getByRole('button', { name: /Give .*[Cc]arol.* access/ }).click()

    const role = page.getByRole('combobox', { name: /What .*[Cc]arol.* may do/ })
    await expect(role).toBeVisible()
    await role.selectOption('manager')
    await page.getByRole('button', { name: 'Done' }).click()

    await openShareDialog(page)
    // Not "custom": a Manage grant written by this client must read back as Manage. It would not if
    // the write had merged into the previous rights instead of replacing them.
    await expect(page.getByRole('combobox', { name: /What .*[Cc]arol.* may do/ })).toHaveValue(
      'manager',
    )
  })

  test('revoking removes the access, and the server agrees', async ({ page }) => {
    await login(page)
    await openShareDialog(page)
    await page.getByLabel('Search people').fill('carol')
    await page.getByRole('button', { name: /Give .*[Cc]arol.* access/ }).click()
    await page.getByRole('button', { name: /Remove .*[Cc]arol/ }).click()
    await expect(page.getByText('Only you.')).toBeVisible()
    await page.getByRole('button', { name: 'Done' }).click()

    await openShareDialog(page)
    await expect(page.getByText('Only you.')).toBeVisible({ timeout: 30_000 })
  })

  test('the dialog says what “View” costs, in words', async ({ page }) => {
    /*
     * The one place mail breaks the three-role model. "View" withholds `maySetSeen` so the reader
     * cannot mark the OWNER's post as read by opening it — and the price is that the reader's own
     * unread count never moves. A user who is not told discovers that as a bug in the app.
     */
    await login(page)
    await openShareDialog(page)
    await expect(page.getByText(/will not mark it read for you/i)).toBeVisible({ timeout: 30_000 })
  })
})

test.describe('S-1 — being told that something was shared', () => {
  test.afterEach(async () => {
    // Put carol's grant back to the fixture's `ro` FIRST, then sweep. That order is not cosmetic:
    // re-granting is itself a change, so it mints a fresh `ShareNotification`, and clearing before
    // it would leave that one behind for whatever runs next to find a "New shares" strip it never
    // asked for.
    //
    // The restore itself is what makes this block work at all: every test here mints its card by
    // re-granting `rw`, and `shareWith` is a full replacement, so `rw` over an existing `rw` is a
    // no-op the server does not report. Without the reset the FIRST test consumed the only real
    // change available and every one after it waited thirty seconds for a card that was never
    // going to be created.
    await ensureDelegations()
    await clearShareNotifications('alice')
  })

  test('a share by someone else raises a quiet card in the folder rail', async ({ page }) => {
    // Start from none: a `ShareNotification` is destroyed when it is dismissed, so a leftover from a
    // previous run would let this pass without the server having said anything.
    await clearShareNotifications('alice')
    // A REAL change — `shareWith` is a full replacement, so re-writing the same rights is a no-op
    // the server does not report. The fixture granted `ro`; `rw` is a different grant.
    await shareInbox('carol', 'alice', 'rw')

    await login(page)

    const strip = page.getByRole('region', { name: 'New shares' })
    await expect(strip).toBeVisible({ timeout: 30_000 })
    await expect(strip).toContainText(CAROL)
    // NOT the server's own recovery admin, which is who Stalwart v0.16.18 attributes a mailbox ACL
    // change to (measured). The card resolves the name from `objectAccountId` instead.
    await expect(strip).not.toContainText(/Recovery admin/i)
  })

  test('“Open” goes to the shared folder, in the right account', async ({ page }) => {
    await clearShareNotifications('alice')
    await shareInbox('carol', 'alice', 'rw')
    await login(page)

    const strip = page.getByRole('region', { name: 'New shares' })
    await expect(strip).toBeVisible({ timeout: 30_000 })
    await strip.getByRole('button', { name: 'Open' }).click()

    // Both halves of the address. Every account's Inbox on this server is mailbox `a`, so a card
    // that carried only the mailbox id would land in alice's own Inbox and look entirely plausible.
    await expect(page).toHaveURL(/account=/)
    await expect(page.getByRole('region', { name: 'Messages', exact: true })).toBeVisible({
      timeout: 30_000,
    })
    // Alice's own seeded corpus must NOT be here: this is carol's inbox.
    const { READ_SUBJECTS } = await import('../stalwart/seed-read.mjs')
    await expect(
      page.getByRole('region', { name: 'Messages', exact: true }).getByText(READ_SUBJECTS.plain),
    ).toHaveCount(0)
  })

  test('“Hide” destroys the notification, so a reload does not bring it back', async ({ page }) => {
    /*
     * RFC 9670 §3 gives a notification no read flag: a destroy is the only "seen" there is. Hiding
     * it locally would put the card back on the next reload and on every other device — which is the
     * behaviour that makes people stop reading notifications.
     */
    await clearShareNotifications('alice')
    await shareInbox('carol', 'alice', 'rw')
    // `stay`, because the assertion IS the reload below — see `login`.
    await login(page, { stay: true })

    const strip = page.getByRole('region', { name: 'New shares' })
    await expect(strip).toBeVisible({ timeout: 30_000 })
    await strip.getByRole('button', { name: 'Hide this notice' }).click()
    await expect(strip).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('region', { name: 'New shares' })).toHaveCount(0)
  })

  test('nothing is announced when nothing has changed', async ({ page }) => {
    // The quiet half of "quiet card". With no outstanding notification the strip is not rendered at
    // all — no empty box, no zero badge.
    await clearShareNotifications('alice')
    await login(page)
    await expect(page.getByRole('region', { name: OWN })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('region', { name: 'New shares' })).toHaveCount(0)
  })

  test('the card is readable on a phone, and so is the rail behind it', async ({ page }) => {
    // 390 px: the drawer breakpoint. The strip sits at the top of the same scrolling column the
    // folder trees do, so it must not push the first account out of reach.
    await page.setViewportSize({ width: 390, height: 780 })
    await clearShareNotifications('alice')
    await shareInbox('carol', 'alice', 'rw')
    await login(page)

    await page.getByRole('button', { name: 'Folders' }).click()
    const strip = page.getByRole('region', { name: 'New shares' })
    await expect(strip).toBeVisible({ timeout: 30_000 })
    // Both actions still reachable and still 44 px.
    for (const name of ['Open', 'Hide this notice']) {
      const button = strip.getByRole('button', { name })
      const box = await button.boundingBox()
      expect(box, name).not.toBeNull()
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(24)
    }
    await expect(page.getByRole('region', { name: OWN })).toBeVisible()
  })
})
