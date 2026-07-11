import { expect, type Page, test } from '@playwright/test'
import {
  deliverLiveMail,
  READ_BODIES,
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
