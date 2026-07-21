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
const WEBPUSH_VAPID = 'urn:ietf:params:jmap:webpush-vapid'

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

/**
 * Does this session carry a VAPID key the APP would actually use?
 *
 * **This must mirror the app's own condition, not a weaker one.** The Notifications section
 * branches on `serverSupportsBackgroundPush` (apps/web/src/notify/capability.ts), which delegates
 * to `getWebPushVapidCapability` (packages/jmap/src/session.ts) — and that guard requires more than
 * the capability being advertised: `applicationServerKey` must be a NON-EMPTY STRING. A premise
 * that asserted mere presence would pass against a server advertising the capability with an
 * empty/absent/non-string key, the app would render the OTHER branch, and the failure would land
 * later on `toContainText` — reading as "the copy is wrong" when the truth is "the server's key is
 * unusable". (The old `.toBe(false)` form did not have this asymmetry: absence really does imply
 * the probe is false. Inverting it introduced it.)
 *
 * The guard is duplicated rather than imported because `@waxwing/jmap` is not resolvable from the
 * `@waxwing/e2e` package — it is not a dependency and ships only a built `dist`. If the guard in
 * `packages/jmap/src/session.ts` changes, change this with it.
 */
function usableVapidKey(session: SessionDoc): boolean {
  const capability = session.capabilities[WEBPUSH_VAPID]
  if (typeof capability !== 'object' || capability === null) return false
  const key = (capability as { applicationServerKey?: unknown }).applicationServerKey
  return typeof key === 'string' && key !== ''
}

/**
 * Why the premise above failed — and the two causes have nothing to do with each other.
 *
 * The likely one is a STALE DATA VOLUME, not a regressed pin. Stalwart v0.16.14 auto-generates the
 * VAPID keypair only on a VIRGIN registry: the generation step in `crates/common/src/manager/
 * defaults.rs` is nested inside `if count_object(OidcProvider) == 0`. `docker-compose.yml` keeps the
 * registry in a NAMED volume (`stalwart-data`) and `fixture.mjs up()` never removes it — only
 * `down()` passes `-v`. So the ordinary upgrade path (bump the tag, run `pnpm e2e:server`) boots the
 * new binary against a registry an older version already populated, no key is generated, and this
 * premise fails while the pin is perfectly correct.
 */
function premiseFailure(session: SessionDoc): string {
  if (Object.hasOwn(session.capabilities, WEBPUSH_VAPID)) {
    return (
      `the server advertises \`${WEBPUSH_VAPID}\` but its \`applicationServerKey\` is not a usable ` +
      'non-empty string, so the app renders the OTHER branch. This is a server/key problem, not a ' +
      'wording problem — do not "fix" the copy below.'
    )
  }
  return (
    `the server advertises no \`${WEBPUSH_VAPID}\` at all. Most likely cause: a STALE DATA VOLUME, ` +
    'not the image pin. Stalwart v0.16.14 generates the VAPID keypair only on a virgin registry, ' +
    'and `pnpm e2e:server` reuses the existing `stalwart-data` volume — so bumping the pinned tag ' +
    'without recreating the volume leaves the old registry, and no key is ever generated. Remedy: ' +
    '`pnpm e2e:server:down` (removes the volume), then `pnpm e2e:server`. If the volume IS fresh, ' +
    'then the pin really did regress below v0.16.14.'
  )
}

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
      ['Web Push signing (RFC 9749)', WEBPUSH_VAPID],
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
   * **The premise moved on 2026-07-20 and this test moved with it.** Stalwart v0.16.14 ships
   * RFC 9749 and auto-generates a VAPID keypair, so this server DOES publish a Web-Push signing key.
   * What has not changed is our side: the app still contains no `applicationServerKey`, no
   * `PushSubscription/set` and no `push` listener (ADR-010 + amendment), so there is still no
   * background push to test and no test may pretend otherwise.
   *
   * What CAN be checked — and matters more than a mocked stand-in would — is that the app SAYS SO:
   * `serverSupportsBackgroundPush` probes the live session for `urn:ietf:params:jmap:webpush-vapid`,
   * and this is the guard on that probe reaching the UI against a real Stalwart rather than only
   * against a hand-made fixture in jsdom.
   *
   * The server side is asserted first, so the sentence on screen is checked against what this server
   * actually advertises. The previous version of this test asserted the capability was ABSENT and
   * was written to fail the day a server shipped it; it did exactly that, and the fix was to make
   * the app honest rather than to pin the pessimistic wording. Keep that property: if the client
   * half ever ships, this must fail again rather than assert "we don't deliver it" forever.
   *
   * MUTATION-PROVEN (previous form): making `serverSupportsBackgroundPush` return the wrong branch
   * turns this RED — the section makes a claim about background push that does not match the server.
   */
  test('the notifications section admits Waxwing does not deliver background push yet (FR-NOTIF-02)', async ({
    page,
  }) => {
    const session = (await alice.session()) as unknown as SessionDoc
    expect(usableVapidKey(session), premiseFailure(session)).toBe(true)

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
      'This server supports notifications while Waxwing is closed, but Waxwing does not deliver them yet',
    )
    // …and it does not simultaneously claim the server cannot. The two strings are mutually
    // exclusive by construction, so this is the assertion a future edit cannot satisfy by rendering
    // both.
    await expect(notifications).not.toContainText(
      'Notifications while Waxwing is fully closed are not available with this server',
    )
    // The load-bearing negative: nothing on this screen may claim background push WORKS. There is no
    // string in the bundle that does — this is the guard against someone adding one back.
    await expect(notifications).not.toContainText('also supports notifications while')
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
