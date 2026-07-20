import { expect, test } from '@playwright/test'
import { ACCOUNTS, type JmapClient, jmapAs } from '../stalwart/seed-write.mjs'
import { CREDENTIALS, login, openSettings, typeInEditor } from './helpers'

/**
 * M3.7 settings suite — the REAL production bundle against the live Stalwart fixture.
 *
 * It proves the three things the work package's Done-when names, and each of them is verified against
 * the SERVER rather than against the screen that wrote it:
 *
 *  - the vacation responder round-trips (the app writes it; `VacationResponse/get` reads it back);
 *  - the capabilities panel agrees with the live session document, not with a hand-made fixture;
 *  - the quota bar reflects the account's real allowance.
 *
 * Runs in the WRITE harness: it mutates the vacation singleton, which is per-account state.
 */

const CORE = 'urn:ietf:params:jmap:core'
const VACATION = 'urn:ietf:params:jmap:vacationresponse'
const QUOTA = 'urn:ietf:params:jmap:quota'
const MAIL = 'urn:ietf:params:jmap:mail'

interface Vacation {
  readonly isEnabled: boolean
  readonly subject: string | null
  readonly htmlBody: string | null
  readonly textBody: string | null
}

interface QuotaRow {
  readonly resourceType: string
  readonly hardLimit: number
}

interface SessionDoc {
  readonly capabilities: Record<string, unknown>
  readonly accounts: Record<string, { readonly accountCapabilities: Record<string, unknown> }>
}

/**
 * ONE client, and ONE resolved accountId, for the whole file.
 *
 * `jmapAs()` builds a fresh client per call, and every `call()` on it first fetches the session
 * document — so a naive `alice()` inside an `expect.poll` issues two authenticated requests per
 * 100 ms tick. Over a 20 s poll that is several hundred Basic-auth requests, and Stalwart answers
 * with **HTTP 429** (its abuse limiter) and takes the whole suite down with it. The client is
 * therefore hoisted, the accountId is resolved once, and every poll is throttled to `intervals`.
 */
const alice: JmapClient = jmapAs(ACCOUNTS.alice)
let aliceAccountId = ''

/** Poll intervals: gentle enough that Stalwart's abuse limiter never sees a burst. */
const POLL = { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }

test.beforeAll(async () => {
  aliceAccountId = await alice.account()
})

/** Labels carry parentheses — "Web Push signing (RFC 9749)" — which a bare template regex would read
 *  as a capture group and then fail to match. */
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The first method response's arguments, typed by the caller. */
async function first<T>(
  client: JmapClient,
  using: string[],
  call: [string, Record<string, unknown>, string],
): Promise<T> {
  const res = await client.call(using, [call])
  const response = res.methodResponses[0]
  if (!response) throw new Error(`no response for ${call[0]}`)
  return response[1] as T
}

async function vacationOf(): Promise<Vacation> {
  const args = await first<{ list: Vacation[] }>(
    alice,
    [CORE, VACATION],
    ['VacationResponse/get', { accountId: aliceAccountId, ids: ['singleton'] }, '0'],
  )
  const vacation = args.list[0]
  if (!vacation) throw new Error('VacationResponse singleton missing')
  return vacation
}

/** The singleton is per-ACCOUNT state, not per-test: leave it off however the test ended. */
test.afterEach(async () => {
  await first(
    alice,
    [CORE, VACATION],
    [
      'VacationResponse/set',
      {
        accountId: aliceAccountId,
        update: { singleton: { isEnabled: false, subject: null, htmlBody: null, textBody: null } },
      },
      '0',
    ],
  )
})

test.describe('M3.7 settings suite', () => {
  test('vacation responder round-trips against the server (FR-VAC-01)', async ({ page }) => {
    const subject = `Away ${Date.now()}`
    await login(page, CREDENTIALS.alice)
    await openSettings(page)

    const enable = page.getByLabel('Send automatic replies')
    await expect(enable).toBeVisible()
    await enable.check()
    await page.getByLabel('Subject').fill(subject)
    await typeInEditor(page, 'Reply message', 'Back on Monday.')
    await page.getByRole('button', { name: 'Save' }).click()

    // The SERVER is the assertion — not the toast that said we saved.
    await expect.poll(async () => (await vacationOf()).isEnabled, POLL).toBe(true)
    const saved = await vacationOf()
    expect(saved.subject).toBe(subject)
    expect(saved.htmlBody).toContain('Back on Monday')
    // Both alternatives, so a plain-text client can read it too.
    expect(saved.textBody).toContain('Back on Monday')

    await enable.uncheck()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect.poll(async () => (await vacationOf()).isEnabled, POLL).toBe(false)
  })

  test('the capabilities panel matches the session document (FR-SRV-04)', async ({ page }) => {
    const session = (await alice.session()) as unknown as SessionDoc
    const account = session.accounts[aliceAccountId]
    if (!account) throw new Error('no primary mail account')

    const advertises = (urn: string): boolean =>
      Object.hasOwn(session.capabilities, urn) || Object.hasOwn(account.accountCapabilities, urn)

    await login(page, CREDENTIALS.alice)
    await openSettings(page)

    const server = page.getByRole('region', { name: 'Server' })
    await expect(server).toBeVisible()

    for (const [label, urn] of [
      ['Vacation responder', VACATION],
      ['Quota', QUOTA],
      ['WebSocket push', 'urn:ietf:params:jmap:websocket'],
      ['Web Push signing (RFC 9749)', 'urn:ietf:params:jmap:webpush-vapid'],
    ] as const) {
      await expect(
        server.locator('dt', { hasText: new RegExp(`^${escapeRe(label)}$`) }).locator('+ dd'),
      ).toHaveText(advertises(urn) ? 'Offered' : 'Not offered')
    }

    // The mail limits come from the ACCOUNT capability — Stalwart's top-level `mail` is `{}`, so a
    // panel that read the session level would show an empty table right here, against this very server.
    const mail = account.accountCapabilities[MAIL] as { maxMailboxDepth: number }
    await expect(
      server.locator('dt', { hasText: /^Folder nesting depth$/ }).locator('+ dd'),
    ).toHaveText(String(mail.maxMailboxDepth))
  })

  /**
   * FR-NOTIF-02 / NFR-PRIV-02, and the ONLY background-push assertion this repo may contain.
   *
   * No JMAP server publishes a Web-Push signing key (ADR-010), so the app deliberately contains no
   * `applicationServerKey`, no `PushSubscription/set` and no `push` listener — there is no background
   * push to test and no test may pretend otherwise. What CAN be checked, and matters more than a
   * mocked stand-in would, is that the app SAYS SO: `serverSupportsBackgroundPush` probes the live
   * session for `urn:ietf:params:jmap:webpush-vapid`, and this is the guard on that probe reaching
   * the UI against a real Stalwart rather than only against a hand-made fixture in jsdom.
   *
   * The server side is asserted first, so the sentence on screen is checked against what this server
   * actually advertises — the day one ships the capability, the app must switch to the other string
   * and this test must fail rather than pin the pessimistic wording forever.
   *
   * MUTATION-PROVEN: making `serverSupportsBackgroundPush` return `true` turns this RED — the section
   * claims background notifications work, against a server that cannot sign one.
   */
  test('the notifications section admits background push is unavailable (FR-NOTIF-02)', async ({
    page,
  }) => {
    const session = (await alice.session()) as unknown as SessionDoc
    expect(
      Object.hasOwn(session.capabilities, 'urn:ietf:params:jmap:webpush-vapid'),
      'ADR-010: no JMAP server publishes a VAPID key — if this fails, the premise changed',
    ).toBe(false)

    await login(page, CREDENTIALS.alice)
    await openSettings(page)

    // Two regions on this page answer to "Notifications" — the settings section and the toast live
    // region (`ui.toast.region`). Filtering on the master switch picks the settings one without
    // reaching for a CSS selector, and would fail loudly if the section lost its switch.
    const notifications = page
      .getByRole('region', { name: 'Notifications' })
      .filter({ hasText: 'Notify me about new mail' })
    await expect(notifications).toBeVisible()
    await expect(notifications).toContainText(
      'Notifications while Waxwing is fully closed are not available with this server',
    )
    // …and it does not simultaneously claim the opposite. The two strings are mutually exclusive by
    // construction, so this is the assertion that a future edit cannot satisfy by rendering both.
    await expect(notifications).not.toContainText(
      'This server also supports notifications while Waxwing is closed',
    )
  })

  test('the quota bar reflects the account allowance (FR-QTA-01)', async ({ page }) => {
    const args = await first<{ list: QuotaRow[] }>(
      alice,
      [CORE, QUOTA],
      ['Quota/get', { accountId: aliceAccountId, ids: null }, '0'],
    )
    const octets = args.list.find((row) => row.resourceType === 'octets' && row.hardLimit > 0)
    // The fixture provisions `maxDiskQuota` on every account (fixture.mjs). Without it Stalwart
    // advertises the capability and returns an EMPTY list — nothing for a bar to reflect.
    expect(octets, 'the fixture must provision a disk quota').toBeDefined()

    await login(page, CREDENTIALS.alice)
    const bar = page.getByRole('progressbar', { name: 'Mailbox storage' })
    await expect(bar).toBeVisible()
    await expect(bar).toHaveAttribute('max', String(octets?.hardLimit))
  })
})
