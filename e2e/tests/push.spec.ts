import { expect, type Page, test } from '@playwright/test'
import { READ_SUBJECTS, seedReadMail } from '../stalwart/seed-read.mjs'
import { revealPasswordForm } from './helpers'

/**
 * M3.10 push suite (gap B4, decision D2 / ADR-005) — the regression that hid for a milestone.
 *
 * Before the fix the browser opened a WebSocket at every sign-in, got a 401 (a browser cannot set
 * `Authorization` on a WS upgrade and Stalwart offers no token fallback), tried again, got a second
 * 401, and only then fell through to SSE. Two dead round-trips on the critical path, and nothing in
 * the unit suite could see them: `channel.test.ts` pinned the *selection* logic, which was right —
 * what was wrong was the option the app passed it. That is a wiring bug, and wiring is exactly what
 * only a browser against a real server can prove.
 *
 * WHY `page.on('websocket')` AND NOT `page.on('request')`. A WebSocket handshake never surfaces as a
 * Playwright `request` — it rides `Network.webSocketCreated` / `webSocketWillSendHandshakeRequest`,
 * a different CDP path from `requestWillBeSent`. So a request-only filter for `/jmap/ws` can never
 * match and would pass forever regardless of what the app does. The socket listener is the only
 * instrument that can see the thing being asserted absent.
 *
 * WHY THE NEGATIVE HAS TEETH HERE. `isEligible('websocket')` (packages/jmap/src/push/channel.ts)
 * requires the session to advertise `supportsPush: true`. This fixture does — the session document
 * carries `urn:ietf:params:jmap:websocket` with `{ url: '…/jmap/ws', supportsPush: true }`, and
 * `vite.config.ts` proxies `/jmap` with `ws: true`, so an attempt would both be made and reach the
 * server. Were either untrue the assertion would be vacuously green, so both are checked in the
 * first test rather than assumed.
 *
 * Runs under playwright.read.config.ts (seeded inbox, same-origin proxy, serial + reseeded).
 */

const CREDENTIALS = { user: 'alice@waxwing.test', pass: 'waxwing-e2e-Pw1!' }

const messageList = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true })

async function login(page: Page): Promise<void> {
  await revealPasswordForm(page)
  await page.getByLabel('Username', { exact: true }).fill(CREDENTIALS.user)
  await page.getByLabel('Password', { exact: true }).fill(CREDENTIALS.pass)
  await page.getByRole('button', { name: 'Sign in with a password', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('treeitem', { name: /Inbox/ }).click()
  await expect(messageList(page).getByText(READ_SUBJECTS.plain)).toBeVisible({ timeout: 30_000 })
}

test.beforeEach(async () => {
  await seedReadMail()
})

test.describe('M3.10 push transport (B4)', () => {
  test('no WebSocket is opened at sign-in — SSE is the push transport', async ({ page }) => {
    // Attach BOTH listeners before the first navigation: `openPush()` runs on leadership, which is
    // immediately after sign-in, so anything attached later races the thing it is watching.
    const sockets: string[] = []
    page.on('websocket', (ws) => sockets.push(ws.url()))
    const sseRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/jmap/eventsource')) sseRequests.push(request.url())
    })

    await page.goto('/')
    await login(page)

    // POSITIVE ANCHOR FIRST, and this is the whole design of the test. "No WebSocket within N ms" is
    // a race by construction; "no WebSocket by the time the working transport had connected" is
    // deterministic, because the app cannot have got push running without having chosen a transport.
    await expect.poll(() => sseRequests.length, { timeout: 30_000 }).toBeGreaterThan(0)

    // POSITIVE CONTROL for the instrument itself. `page.on('websocket')` firing at all is not
    // observable from a green absence assertion, so prove the listener works by opening a socket
    // this test controls. Without this the assertion below would also pass if the event name were
    // misspelled, if the listener were attached to the wrong object, or if Playwright had stopped
    // reporting sockets — three ways to be green for no reason.
    await page.evaluate(async () => {
      const probe = new WebSocket(`ws://${location.host}/jmap/ws`)
      await new Promise<void>((resolve) => {
        probe.addEventListener('open', () => resolve())
        probe.addEventListener('error', () => resolve())
        probe.addEventListener('close', () => resolve())
      })
      probe.close()
    })
    await expect.poll(() => sockets.length, { timeout: 10_000 }).toBe(1)

    // …and the one socket that exists is the control's, not the app's. The app opened none.
    expect(sockets).toEqual([`ws://localhost:4183/jmap/ws`])

    // The fixture really does offer the WebSocket the app is declining, so declining it is a choice
    // and not an accident of an unadvertised capability (see the module comment).
    const capability = await page.evaluate(async () => {
      const response = await fetch('/jmap/session', {
        headers: { authorization: `Basic ${btoa('alice@waxwing.test:waxwing-e2e-Pw1!')}` },
      })
      const session = (await response.json()) as {
        capabilities: Record<string, { supportsPush?: boolean }>
      }
      return session.capabilities['urn:ietf:params:jmap:websocket'] ?? null
    })
    expect(capability?.supportsPush).toBe(true)
  })

  // The PRACTICAL payoff of B4 — a live delivery landing in under a second instead of on the ≈60 s
  // safety sweep — is deliberately NOT a second test here. It already existed as read.spec's
  // "auto-refreshes on a live delivery", written when push was believed unable to authenticate in a
  // browser and budgeted at 75 s for the sweep. M3.10 measured the delivery at well under a second
  // and tightened that budget to 20 s, which is what turns it into a push assertion. Duplicating it
  // would buy nothing but a second fixture round-trip; the tightened budget there is mutation-proven
  // against the same `transports`-removal that reddens the socket assertion above.
})
