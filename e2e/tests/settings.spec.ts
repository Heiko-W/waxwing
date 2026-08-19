import { expect, type Page, test } from '@playwright/test'
import { ACCOUNTS, type JmapClient, jmapAs } from '../stalwart/seed-write.mjs'
import { CREDENTIALS, login, openComposer, openSettings, typeInEditor } from './helpers'

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
const SUBMISSION = 'urn:ietf:params:jmap:submission'
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
   * **This test has now been rewritten twice by its own instructions, which is the point of it.**
   * The first form asserted the capability was ABSENT and said it must fail the day a server shipped
   * RFC 9749; Stalwart v0.16.14 did, on 2026-07-20, and it failed. The second form asserted the app
   * admitted "we do not deliver it yet" and said it must fail again if the client half ever shipped.
   * M4.0 shipped it (owner decision D6a, ADR-017), and it failed. Both times the fix was to make the
   * app honest and follow it here — never to pin a wording that had stopped being true.
   *
   * What it guards NOW is the shape ADR-017 accepted: the good news may be stated, and never alone.
   * A closed-app banner names no sender and no subject, the folder list on this very screen does not
   * reach it, and the subscription lapses after seven days without a visit. All three are limits a
   * user cannot discover by using the feature — only by being told.
   *
   * **What this test deliberately does NOT do: verify a delivery.** Playwright cannot observe a
   * closed app, and Chromium here has no push service to mint an endpoint against, so
   * `pushManager.subscribe()` fails and the app degrades to `unsupported` — exactly as designed.
   * The closed-app half is verified by hand, per platform (see the M4.0 checklist). Asserting the
   * copy against a REAL v0.16.14 session is what this gate can honestly add, and it is not nothing:
   * it is the guard on `serverSupportsBackgroundPush` reaching the UI against a live server rather
   * than only against a hand-made session in jsdom.
   */
  test('the notifications section states background push AND its three limits (FR-NOTIF-02)', async ({
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
      'This server can also notify you while Waxwing is closed',
    )
    // The three limits, each of which a user would otherwise discover only by being let down.
    await expect(notifications).toContainText('never the sender or the subject')
    await expect(notifications).toContainText('folder setting above does not apply')
    await expect(notifications).toContainText('at least once a week')

    // …and it does not simultaneously claim the server cannot. The two strings are mutually
    // exclusive by construction, so this is the assertion a future edit cannot satisfy by rendering
    // both.
    await expect(notifications).not.toContainText(
      'Notifications while Waxwing is fully closed are not available with this server',
    )
    // The dead string from before M4.0. Its reinstatement would be a lie in the other direction.
    await expect(notifications).not.toContainText('does not deliver them yet')
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

/**
 * M5.1 — the identity editor, against the live server (FR-CMP-06, ADR-022).
 *
 * The point of these tests is the round trip, not the form: every assertion that matters reads
 * `Identity/get` back off the SERVER, and the composer check proves the third leg — that a write
 * here reaches the replica the From selector reads, without waiting for the next leadership session.
 *
 * Runs in the WRITE harness and mutates per-account state, so `afterEach` puts the account back:
 * a leftover second identity would make `FromField` render a From selector in every other suite.
 */
interface WireIdentity {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly textSignature: string
  readonly htmlSignature: string
  readonly mayDelete: boolean
}

/**
 * The account's own address, and the one a created identity uses too.
 *
 * RFC 8621 §6 allows several identities on the SAME address — "to allow for different settings the
 * user wants to pick between (for example, with different names/signatures)" — and that is exactly
 * what a second signature is. It also avoids the alias route: Stalwart mints an Identity for every
 * address an account owns, so provisioning an alias would give alice two identities in EVERY suite
 * and make the composer's From selector appear where no test expects it.
 */
const PRIMARY = 'alice@waxwing.test'
const SECOND_NAME = 'Alice (support)'

async function identitiesOf(): Promise<WireIdentity[]> {
  const args = await first<{ list: WireIdentity[]; state: string }>(
    alice,
    [CORE, SUBMISSION],
    ['Identity/get', { accountId: aliceAccountId, ids: null }, '0'],
  )
  return args.list
}

/**
 * Type into the HTML signature editor.
 *
 * NOT `typeInEditor(page, 'Signature', …)`: Playwright's `name` option matches a SUBSTRING, and this
 * form has both "Signature" and "Plain-text signature" — the shared helper resolves to two elements
 * and fails strict mode. Exactness is the whole point here.
 */
async function typeSignature(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Signature', exact: true }).click()
  await page.keyboard.type(text)
}

async function identityState(): Promise<string> {
  const args = await first<{ state: string }>(
    alice,
    [CORE, SUBMISSION],
    ['Identity/get', { accountId: aliceAccountId, ids: null }, '0'],
  )
  return args.state
}

test.describe('M5.1 identity editor', () => {
  test.afterEach(async () => {
    const list = await identitiesOf()
    // The account starts with exactly one identity; anything past the first is this suite's doing.
    const extra = list.slice(1).map((row) => row.id)
    const primary = list[0]
    await first(
      alice,
      [CORE, SUBMISSION],
      [
        'Identity/set',
        {
          accountId: aliceAccountId,
          ifInState: await identityState(),
          ...(extra.length > 0 ? { destroy: extra } : {}),
          ...(primary
            ? {
                update: {
                  [primary.id]: {
                    name: 'Alice Anderson (Waxwing e2e)',
                    htmlSignature: '',
                    textSignature: '',
                    replyTo: null,
                    bcc: null,
                  },
                },
              }
            : {}),
        },
        '0',
      ],
    )
  })

  test('edits the signature of an existing identity (FR-CMP-06)', async ({ page }) => {
    await login(page, CREDENTIALS.alice)
    await openSettings(page)

    const section = page.getByRole('region', { name: 'Identities' })
    await expect(section).toBeVisible()
    await expect(section).toContainText(PRIMARY)

    await section
      .getByRole('button', { name: /^Edit / })
      .first()
      .click()
    // The address of an existing identity is immutable (RFC 8621 §6) — the field says so by being
    // read-only, and a regression that made it editable would be invisible without this.
    await expect(page.getByLabel('Email address')).toHaveAttribute('readonly', '')

    await page.getByLabel('Display name').fill('Alice Alternate')
    await typeSignature(page, 'Kind regards, Alice')
    await page.getByRole('button', { name: 'Save identity' }).click()

    await expect
      .poll(async () => (await identitiesOf())[0]?.htmlSignature ?? '', POLL)
      .toContain('Kind regards, Alice')
    expect((await identitiesOf())[0]?.name).toBe('Alice Alternate')
  })

  test('creates a second identity, the composer offers it, and delete removes it', async ({
    page,
  }) => {
    await login(page, CREDENTIALS.alice)
    await openSettings(page)
    const section = page.getByRole('region', { name: 'Identities' })

    await section.getByRole('button', { name: 'Add identity' }).click()
    await page.getByLabel('Email address').fill(PRIMARY)
    await page.getByLabel('Display name').fill(SECOND_NAME)
    await typeSignature(page, 'Sent from my other address')
    await page.getByRole('button', { name: 'Create identity' }).click()

    await expect
      .poll(async () => (await identitiesOf()).map((identity) => identity.name), POLL)
      .toContain(SECOND_NAME)
    await expect(section).toContainText(SECOND_NAME)

    // THE REPLICA LEG: the engine pulls identities once per leadership session, so without the
    // mirror written by the editor this selector would not exist until the next sign-in. It is also
    // the first time `FromField` renders at all — it stays hidden while there is only one identity.
    await openComposer(page)
    const from = page.getByLabel('From', { exact: true })
    await expect(from).toBeVisible()
    await expect(from).toContainText(SECOND_NAME)
    await page.getByRole('button', { name: 'Close', exact: true }).click()

    await openSettings(page)
    // Two identities share the address, so the row is identified by the button that names it.
    await section
      .getByRole('button', { name: `Delete ${PRIMARY}` })
      .last()
      .click()
    await expect(page.getByRole('dialog', { name: 'Delete identity?' })).toBeVisible()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect
      .poll(async () => (await identitiesOf()).map((identity) => identity.name), POLL)
      .not.toContain(SECOND_NAME)
  })

  test('refuses an address the account does not own, and says why (ADR-022)', async ({ page }) => {
    const before = (await identitiesOf()).length
    await login(page, CREDENTIALS.alice)
    await openSettings(page)
    const section = page.getByRole('region', { name: 'Identities' })

    await section.getByRole('button', { name: 'Add identity' }).click()
    await page.getByLabel('Email address').fill('someone@example.com')
    await page.getByRole('button', { name: 'Create identity' }).click()

    // Stalwart answers `invalidProperties` + `properties: ["email"]` here, NOT the `forbiddenFrom`
    // RFC 8621 §6.3 defines for it — measured, and the reason that shape gets its own message.
    await expect(section).toContainText('not set up for your account')
    // Counted rather than compared against a fixed list: a server may legitimately start with more
    // than one identity (Stalwart mints one per address the account owns).
    expect(await identitiesOf()).toHaveLength(before)
  })
})
