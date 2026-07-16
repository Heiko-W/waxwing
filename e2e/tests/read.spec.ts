import { expect, type Page, test } from '@playwright/test'
import {
  deliverLiveMail,
  READ_BODIES,
  READ_PHISHING,
  READ_SUBJECTS,
  seedReadMail,
} from '../stalwart/seed-read.mjs'

// M1.9 read E2E suite — the REAL production bundle against the live Stalwart fixture (see
// playwright.read.config.ts + read.setup.mjs). It proves the Phase-2 "read" story end to end:
// Basic login, folder navigation, reading plain / HTML / threaded mail in the sandboxed frame,
// the triage actions (flag / archive / trash) round-tripping through the outbox, and a live
// delivery surfacing without a refresh (push → sync → liveQuery).

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

/** The reading-pane iframe for a given subject (title = "Message: <subject>"). */
const bodyFrame = (page: Page, subject: string) =>
  page.frameLocator(`iframe[title="Message: ${subject}"]`)

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages' })

async function login(page: Page, options: { stay?: boolean } = {}): Promise<void> {
  await page.goto('/')
  // The app is served from the same origin as its JMAP server (the preview proxy), so the
  // FR-AUTH-01 same-origin probe succeeds and onboarding lands straight on the Basic sign-in
  // step — no connect step to fill.
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  if (options.stay) await page.getByLabel('Stay signed in').check()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await openInbox(page)
}

/** Wait for the connected shell, open the Inbox and wait for the seeded corpus to sync in. */
async function openInbox(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
}

// Reseed before every test so triage mutations never leak across tests (each test = fresh corpus).
test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('M1.9 read suite', () => {
  test('Basic login lists the inbox corpus', async ({ page }) => {
    await login(page)
    const list = messageList(page)
    await expect(list.getByText(READ_SUBJECTS.plain)).toBeVisible()
    await expect(list.getByText(READ_SUBJECTS.newsletter)).toBeVisible()
    // The three-message thread collapses to one row showing the newest ("Re: …") subject.
    await expect(list.getByText(`Re: ${READ_SUBJECTS.thread}`)).toBeVisible()
  })

  test('reads a plain-text message in the sandboxed frame', async ({ page }) => {
    await login(page)
    await page.getByText(READ_SUBJECTS.plain).click()
    await expect(bodyFrame(page, READ_SUBJECTS.plain).getByText(READ_BODIES.plain)).toBeVisible({
      timeout: 20_000,
    })
  })

  test('reads the HTML newsletter: remote content blocked, then loaded', async ({ page }) => {
    await login(page)
    await page.getByText(READ_SUBJECTS.newsletter).click()
    // The newsletter carries a remote tracking image → the banner is shown (default block).
    await expect(page.getByText('Remote content blocked')).toBeVisible({ timeout: 20_000 })
    // The sandboxed frame still renders the message text (just not the remote image).
    await expect(
      bodyFrame(page, READ_SUBJECTS.newsletter).getByText(READ_BODIES.newsletterMarker),
    ).toBeVisible()
    // Loading images dismisses the banner (re-sanitized with remote content allowed).
    await page.getByRole('button', { name: 'Load images' }).click()
    await expect(page.getByText('Remote content blocked')).toHaveCount(0)
  })

  test('shows a threaded conversation with expandable older messages', async ({ page }) => {
    await login(page)
    await page.getByText(`Re: ${READ_SUBJECTS.thread}`).click()
    await expect(page.getByText('3 messages in this conversation')).toBeVisible({ timeout: 20_000 })
    // Newest is expanded: its body renders in the "Re: …" frame.
    await expect(
      bodyFrame(page, `Re: ${READ_SUBJECTS.thread}`).first().getByText(READ_BODIES.threadNewest),
    ).toBeVisible()
    // The oldest is collapsed (its preview is a button); expanding it renders its body.
    await page.getByText(/Kicking off Q3 planning/).click()
    await expect(
      bodyFrame(page, READ_SUBJECTS.thread).getByText(READ_BODIES.threadOldest),
    ).toBeVisible({ timeout: 20_000 })
  })

  test('flags and archives a message from the reading action bar', async ({ page }) => {
    await login(page)
    await page.getByText(READ_SUBJECTS.plain).click()
    await page.getByRole('button', { name: 'Flag', exact: true }).click()
    // The flag stuck (optimistic apply): the control flips to Unflag.
    await expect(page.getByRole('button', { name: 'Unflag', exact: true })).toBeVisible({
      timeout: 15_000,
    })
    // Archiving moves it out of the inbox — the list row disappears (live).
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toHaveCount(0, {
      timeout: 15_000,
    })
  })

  test('moves a message to Trash out of the inbox', async ({ page }) => {
    await login(page)
    await page.getByText(READ_SUBJECTS.plain).click()
    await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toHaveCount(0, {
      timeout: 15_000,
    })
  })

  test('auto-refreshes on a live delivery, no manual reload', async ({ page }) => {
    // The slow one: with Basic auth a browser cannot authenticate the WebSocket push handshake
    // (no Authorization header on a WS upgrade), so live updates arrive via the engine's
    // safety-sweep poll (≈60 s) rather than an instant push. Either way the client re-renders
    // from the replica with no manual reload — that user-visible guarantee is what we assert.
    // Instant-push validation (OAuth Bearer + SSE) is a follow-up (see plan §7, M1.9 changelog).
    test.setTimeout(90_000)
    await login(page)
    const list = messageList(page)
    const subject = await deliverLiveMail('t-live')
    await expect(list.getByText(subject)).toBeVisible({ timeout: 75_000 })
  })

  test('OAuth login reaches the inbox (secure-context localhost)', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in securely' }).click()
    // Stalwart's /login SPA (same-origin via the proxy): fill its form and submit; the app then
    // completes the PKCE code exchange and mounts the shell.
    await page.locator('#username').fill(CREDENTIALS.user)
    await page.locator('#password').fill(CREDENTIALS.pass)
    await page.locator('#login-form button[type="submit"]').click()
    await openInbox(page)
  })

  test('cross-tab: a flag in one tab reflects in another', async ({ page, context }) => {
    test.setTimeout(60_000)
    // Tab A signs in and persists the session; tab B (same context → same replica) restores it.
    await login(page, { stay: true })
    const b = await context.newPage()
    await b.goto('/')
    await openInbox(b)
    // Open the same message in both tabs, then flag it in A.
    await page.getByText(READ_SUBJECTS.plain).click()
    await b.getByText(READ_SUBJECTS.plain).click()
    await page.getByRole('button', { name: 'Flag', exact: true }).click()
    // B reflects the change through the shared Dexie replica (cross-tab liveQuery).
    await expect(b.getByRole('button', { name: 'Unflag', exact: true })).toBeVisible({
      timeout: 20_000,
    })
  })

  test('perf smoke: cached open and folder switch (records numbers)', async ({ page }) => {
    await login(page)
    // Warm the body cache (first open fetches + stores the body).
    await page.getByText(READ_SUBJECTS.plain).click()
    await expect(bodyFrame(page, READ_SUBJECTS.plain).getByText(READ_BODIES.plain)).toBeVisible()
    // Navigate away, then re-open — now served from the replica, no network fetch (FR-OFF-02).
    await page.getByText(`Re: ${READ_SUBJECTS.thread}`).click()
    await expect(page.getByText('3 messages in this conversation')).toBeVisible()
    const openStart = Date.now()
    await page.getByText(READ_SUBJECTS.plain).click()
    await expect(bodyFrame(page, READ_SUBJECTS.plain).getByText(READ_BODIES.plain)).toBeVisible()
    const cachedOpenMs = Date.now() - openStart
    // Folder switch round-trip: Inbox → Trash → Inbox; time the inbox list re-appearing.
    const switchStart = Date.now()
    await page.getByRole('treeitem', { name: /Trash/ }).click()
    await page.getByRole('treeitem', { name: /Inbox/ }).click()
    await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible()
    const folderSwitchMs = Date.now() - switchStart
    // Record the numbers (the deliverable); the NFR-PERF-02 targets are <100ms open / <200ms switch.
    console.log(`[perf] cached message open: ${cachedOpenMs}ms (NFR-PERF-02 target <100ms)`)
    console.log(`[perf] folder switch Trash→Inbox: ${folderSwitchMs}ms (target <200ms)`)
    // Generous smoke bounds — headless E2E adds click+render overhead beyond the app's own work.
    expect(cachedOpenMs).toBeLessThan(3000)
    expect(folderSwitchMs).toBeLessThan(3000)
  })
})

// M3.9 — header details (FR-RD-06) and phishing friction (FR-RD-08), against the seeded phishing
// message. It carries every hostile pattern at once, because they co-occur in the real thing: two
// Authentication-Results headers (a failing one on top, the sender's own forgery below), a display
// name that IS a different email address, and a link whose text names a host it does not open.
test.describe('M3.9 reading polish', () => {
  test('the auth results shown are the TOPMOST header, never the sender’s forgery', async ({
    page,
  }) => {
    await login(page)
    // `.first()`: the row renders the subject in its cell AND in the preview line, so a bare
    // getByText matches two nodes and Playwright refuses in strict mode.
    await page.getByText(READ_SUBJECTS.phishing).first().click()
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(READ_SUBJECTS.phishing, {
      timeout: 20_000,
    })

    await page.getByRole('button', { name: 'Details' }).click()
    const details = page.locator('dl').first()

    // THE assertion of this work package. RFC 8621 §4.1.3 makes `header:X:asText` return the LAST
    // instance; the receiving MTA PREPENDS its own (RFC 8601 §5), so the last one is the ATTACKER'S.
    // Ask the obvious way and this reads "dmarc=pass" for a message that failed every check.
    await expect(details).toContainText(READ_PHISHING.trustedAuthserv)
    await expect(details).toContainText('dmarc=fail')
    await expect(details).not.toContainText(READ_PHISHING.forgedAuthserv)
    await expect(details).not.toContainText('dmarc=pass')
    // Reported, never adjudicated: the reader is told we cannot vouch for who wrote this.
    await expect(details).toContainText(/cannot be verified/i)
  })

  test('the sender’s real address is visible without hovering, and the fake name is marked', async ({
    page,
  }) => {
    await login(page)
    // `.first()`: the row renders the subject in its cell AND in the preview line, so a bare
    // getByText matches two nodes and Playwright refuses in strict mode.
    await page.getByText(READ_SUBJECTS.phishing).first().click()
    const article = page.getByRole('article').first()
    await expect(article).toBeVisible({ timeout: 20_000 })

    // "on hover/tap" is what the spec says; hover does not exist on a phone, so the address is
    // always on. No hover, no click, no disclosure — it is simply there.
    await expect(article).toContainText(READ_PHISHING.realAddress)
    await expect(article).toContainText(READ_PHISHING.displayName)
    // `From: "security@bank.test" <mallory@evil.tld>` — the name is impersonating an address.
    await expect(article).toContainText(/not the sender's real address/i)
  })

  test('a link whose text names another host is interrupted; Cancel opens nothing', async ({
    page,
    context,
  }) => {
    await login(page)
    // `.first()`: the row renders the subject in its cell AND in the preview line, so a bare
    // getByText matches two nodes and Playwright refuses in strict mode.
    await page.getByText(READ_SUBJECTS.phishing).first().click()
    const frame = bodyFrame(page, READ_SUBJECTS.phishing)
    await expect(frame.locator('body')).toBeVisible({ timeout: 20_000 })

    let opened = 0
    context.on('page', () => {
      opened += 1
    })

    await frame.getByText(READ_PHISHING.linkText).click()
    // The dialog is a LAZY chunk — wait for it. An immediate visibility check races the import and
    // reports a false "no warning", which is how this very test first lied to me.
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog).toContainText('bank.test')
    await expect(dialog).toContainText('paypa1-secure.ru')

    // The whole point: the default answer is "no", and it must be inert.
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await page.waitForTimeout(500)
    expect(opened).toBe(0)
  })

  test('an honest link in the same message opens with no warning at all', async ({ page }) => {
    await login(page)
    // `.first()`: the row renders the subject in its cell AND in the preview line, so a bare
    // getByText matches two nodes and Playwright refuses in strict mode.
    await page.getByText(READ_SUBJECTS.phishing).first().click()
    const frame = bodyFrame(page, READ_SUBJECTS.phishing)
    await expect(frame.locator('body')).toBeVisible({ timeout: 20_000 })

    // The false-positive control, and it is not a formality: a warning readers learn to click
    // through is worse than no warning. Prose text over any href must stay silent.
    await frame.getByText(READ_PHISHING.benignText).click()
    await page.waitForTimeout(1500)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('View source shows the raw message, and Save as .eml downloads it', async ({ page }) => {
    await login(page)
    await page.getByText(READ_SUBJECTS.plain).click()
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(READ_SUBJECTS.plain, {
      timeout: 20_000,
    })

    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'View source' }).click()
    const dialog = page.getByRole('dialog', { name: 'Message source' })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    // The real RFC 5322 bytes — and single angle brackets, which the seeder used to double.
    await expect(dialog.locator('pre')).toContainText(`Message-ID: <lunch-thursday@waxwing.test>`)
    await expect(dialog.locator('pre')).toContainText(`Subject: ${READ_SUBJECTS.plain}`)

    const download = page.waitForEvent('download', { timeout: 15_000 })
    await page.getByRole('button', { name: 'Save as .eml' }).click()
    const file = await download
    // The subject sanitizes into the filename; the `?` is not a legal one.
    expect(file.suggestedFilename()).toBe('Lunch on Thursday.eml')
  })
})
