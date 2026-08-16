import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'

// M4.4 shared-account suite — the ONLY place the delegated-mailbox story is exercised end to end,
// against a live Stalwart that really enforces the grants (see playwright.shared.config.ts).
//
// The fixture grants alice two shares: bob's inbox READ-WRITE, carol's inbox READ-ONLY. Both owners'
// inboxes carry the mailbox id `a` — and so does alice's own. That collision is not incidental, it is
// the whole point: JMAP ids are per-account and short, so a write routed to the wrong account does
// not fail, it succeeds on the wrong mail. Every assertion below is written to catch that silently.

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

const OWN = 'alice@waxwing.test'
const SHARED_RW = 'bob@waxwing.test'
const SHARED_RO = 'carol@waxwing.test'

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages' })

/** One account's section of the grouped sidebar — a named region per account (M4.4 stage 3). */
const accountSection = (page: Page, name: string) => page.getByRole('region', { name })

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
}

/** Open an account's Inbox by clicking it inside THAT account's section. */
async function openInboxOf(page: Page, account: string): Promise<void> {
  const section = accountSection(page, account)
  await expect(section).toBeVisible({ timeout: 30_000 })
  await section.getByRole('treeitem', { name: /Inbox/ }).click()
}

test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('M4.4 shared accounts', () => {
  test('the sidebar groups every granted account, own account first', async ({ page }) => {
    await login(page)

    // All three, each its own named region. Without the delegation this renders as ONE ungrouped
    // tree — which is what every other suite gets, and what its pass-through is for.
    await expect(accountSection(page, OWN)).toBeVisible()
    await expect(accountSection(page, SHARED_RW)).toBeVisible()
    await expect(accountSection(page, SHARED_RO)).toBeVisible()

    // Delegated accounts are marked as such; the user's own is not.
    await expect(accountSection(page, SHARED_RW).getByText('Shared')).toBeVisible()
    await expect(accountSection(page, OWN).getByText('Shared')).toHaveCount(0)
  })

  test('a shared account shows only the mailbox that was shared', async ({ page }) => {
    await login(page)

    // Bob has Inbox/Trash/Junk/Sent/Drafts; only the Inbox was granted, and the server only shows
    // that one. The sidebar must not invent the rest.
    const bob = accountSection(page, SHARED_RW)
    await expect(bob.getByRole('treeitem', { name: /Inbox/ })).toBeVisible({ timeout: 30_000 })
    await expect(bob.getByRole('treeitem')).toHaveCount(1)
  })

  test('opening a shared mailbox lists ITS mail, not the primary account’s', async ({ page }) => {
    await login(page)

    // Alice's own inbox holds the seeded read corpus.
    await openInboxOf(page, OWN)
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({
      timeout: 30_000,
    })

    // Bob's shared inbox is a different account with the SAME mailbox id (`a`). If the panes were
    // still scoped to the primary, the seeded corpus would still be on screen here.
    await openInboxOf(page, SHARED_RW)
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toHaveCount(0)
  })

  test('switching back to the own account restores its own mail', async ({ page }) => {
    await login(page)
    // Load the own account's window FIRST, and wait for it. That is the precondition, not the
    // subject: what this test is about is the round trip back. Going straight into the shared
    // account and expecting the own list to materialise on the way back also exercises a COLD first
    // sync, and that combination was seen to time out once, against a freshly created volume under
    // load, and has not reproduced in 12 targeted repeats since (recorded as B39 — do not "fix" it
    // by widening this timeout).
    await openInboxOf(page, OWN)
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })

    await openInboxOf(page, SHARED_RW)
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toHaveCount(0)

    await openInboxOf(page, OWN)
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
  })

  test('the primary account still triages normally with shares present', async ({ page }) => {
    // The "primary-account UX unchanged" half of M4.4's Done-when: routing writes per account must
    // not have cost the ordinary single-account action anything.
    await login(page)
    await openInboxOf(page, OWN)

    const row = messageList(page).getByText(READ_SUBJECTS.plain)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click()
    await page.keyboard.press('e')

    // Archived out of the Inbox, and the undo toast names it.
    await expect(page.getByText('Moved to Archive')).toBeVisible()
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toHaveCount(0)
  })
})
