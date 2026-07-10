import { expect, type Page, test } from '@playwright/test'

// SP.4 raw-demo end-to-end spec. It proves the "Done when": a human logs in with Basic and
// reads a delivered test mail end-to-end (subject + body text), and the Email/parse button
// surfaces the inner message's subject. It drives a running `pnpm demo` (see
// playwright.demo.config.ts) and SKIPS cleanly when that origin is unreachable, so it never
// fails just because the demo isn't up.
//
// Fixture credentials + seeded subjects mirror e2e/stalwart/{fixture,seed-demo}.mjs.
const BASE_URL = process.env.WAXWING_DEMO_ORIGIN ?? 'http://localhost:5173'
const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }
const SUBJECTS = {
  plain: 'Waxwing demo — plain text hello',
  html: 'Waxwing demo — HTML with a script and an image',
  rfc822: 'Waxwing demo — forwarded message (.eml)',
  inner: 'Original quarterly figures',
}
const PLAIN_BODY =
  'Hello Alice — this is a plain-text demo message, delivered over JMAP and read end to end.'
// Body of the message/rfc822 attachment (mirrors DEMO_INNER_BODY in e2e/stalwart/seed-demo.mjs).
// Only Email/parse surfaces it — it is NOT in the outer Email/get JSON — so it is the payload
// that proves parse returned bodyValues, not just the inner headers.
const INNER_BODY =
  'These are the original quarterly figures that were forwarded to you as a .eml attachment.'

let demoUp = false

test.beforeAll(async () => {
  // Reachability probe: the demo dev server AND its proxy to the fixture must both answer.
  try {
    const res = await fetch(`${BASE_URL}/.well-known/jmap`, { redirect: 'follow' })
    demoUp = res.status === 200
  } catch {
    demoUp = false
  }
})

/** Collects CSP violations / "Refused to…" console errors so a test can assert none occurred. */
function cspErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/content security policy|refused to/i.test(text)) errors.push(text)
  })
  return errors
}

async function basicLogin(page: Page): Promise<void> {
  await page.goto('/')
  // Credentials are pre-filled from VITE_WAXWING_DEMO_USER/PASS, but set them explicitly so
  // the spec does not depend on the pre-fill.
  await page.getByLabel('Username').fill(CREDENTIALS.user)
  await page.getByLabel('Password').fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in (Basic)' }).click()
  await expect(page.getByRole('navigation', { name: 'Mailboxes' })).toBeVisible()
}

test.describe('SP.4 raw demo', () => {
  test('Basic login → read a delivered mail → Email/parse the attachment', async ({ page }) => {
    test.skip(!demoUp, `demo not reachable at ${BASE_URL} — run \`pnpm demo\` first`)
    const violations = cspErrors(page)

    await basicLogin(page)

    const list = page.getByRole('region', { name: 'Messages' })
    // Inbox auto-loads the first page: 25 seeded mails, 10 per page.
    await expect(list.getByText('1–10 of 25')).toBeVisible()

    // Read the plain-text mail end-to-end: subject in the list, body text in the message view.
    await list.getByText(SUBJECTS.plain).click()
    const message = page.getByRole('article')
    // exact match targets the visible <pre> body, not the raw-Email-JSON <pre> (which also
    // contains the body text but lives inside a collapsed <details>).
    await expect(message.getByText(PLAIN_BODY, { exact: true })).toBeVisible()

    // The HTML mail renders in a maximally-sandboxed iframe (sandbox=""): the markup is shown
    // but the inline <script> never runs.
    await list.getByText(SUBJECTS.html).click()
    const frameEl = page.getByTitle('HTML message body')
    await expect(frameEl).toHaveAttribute('sandbox', '')
    const frame = page.frameLocator('iframe[title="HTML message body"]')
    await expect(frame.getByText('End of HTML demo.')).toBeVisible()
    await expect(frame.getByText('SCRIPT RAN')).toHaveCount(0)

    // The message/rfc822 attachment: Email/parse surfaces the inner message's subject AND its
    // body. The body assertion guards a real regression: Email/parse only returns bodyValues
    // when 'bodyValues' is in the requested `properties` (RFC 8620 §5.1); omit it and a
    // compliant server yields an empty inner body while the subject still shows.
    await list.getByText(SUBJECTS.rfc822).click()
    await page.getByRole('button', { name: 'Parse (Email/parse)' }).click()
    // exact:true on the subject targets the parsed <dd>, not the body <pre> — the inner body
    // now also contains the phrase "original quarterly figures" (see INNER_BODY below).
    await expect(message.getByText(SUBJECTS.inner, { exact: true })).toBeVisible()
    await expect(message.getByText(INNER_BODY, { exact: true })).toBeVisible()

    // The attachment downloads via a fetched blob: URL (header-authed, per SP.4 probe Q7).
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download' }).first().click(),
    ])
    expect(download.suggestedFilename()).toBe('forwarded.eml')

    // Design B: zero CSP violations from the demo's own machinery (frame-src for the srcdoc
    // iframe, blob: URLs for the download, connect-src for JMAP). The ONE expected block is the
    // hostile mail's remote tracker image inside the sandboxed iframe — that block is the point
    // (remote-content blocking), not a demo defect, so it is asserted separately.
    const remoteBlocked = violations.filter((message) => message.includes('example.invalid'))
    const unexpected = violations.filter((message) => !message.includes('example.invalid'))
    expect(unexpected, unexpected.join('\n')).toEqual([])
    expect(remoteBlocked.length, 'remote mail image should be CSP-blocked').toBeGreaterThan(0)
  })

  test('OAuth login via Stalwart /login (secure context only)', async ({ page }) => {
    test.skip(!demoUp, `demo not reachable at ${BASE_URL} — run \`pnpm demo\` first`)
    // OAuth PKCE needs a secure context (crypto.subtle). Only a localhost/127.0.0.1 origin is
    // a secure context over plain http; a LAN-IP demo cannot run this.
    const host = new URL(BASE_URL).hostname
    test.skip(
      host !== 'localhost' && host !== '127.0.0.1',
      'OAuth needs a secure context (localhost)',
    )

    await page.goto('/')
    await page.getByRole('button', { name: 'Sign in with OAuth' }).click()

    // Stalwart's /login SPA (same-origin via the demo proxy): fill its form and submit.
    await page.locator('#username').fill(CREDENTIALS.user)
    await page.locator('#password').fill(CREDENTIALS.pass)
    await page.locator('#login-form button[type="submit"]').click()

    // Back at the app root with ?code=…; the demo completes the exchange and lists mailboxes.
    await expect(page.getByRole('navigation', { name: 'Mailboxes' })).toBeVisible({
      timeout: 20_000,
    })
  })
})
