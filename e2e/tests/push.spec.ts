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

/**
 * `draft-ietf-jmap-emailpush-03` — the WIRE CONTRACT, against the real server (ADR-017 amendment,
 * 2026-08-21).
 *
 * The unit suite proves what Waxwing builds; only a real Stalwart can prove the server accepts it.
 * Three things are at stake here and none of them is visible to a unit test:
 *
 *  - **The fixture is new enough.** `emailPush` arrived in v0.16.16 and the fixture runs v0.16.18.
 *    If someone pins it back, the capability assertion below is the thing that says so — rather than
 *    the app silently falling back to the contentless banner and every unit test staying green.
 *  - **`using` really is required, and really is enough.** RFC 8620 §3.3 lets a server fail the whole
 *    request over an unknown capability, so the URN is opted into per call. That opt-in is one line
 *    and it is not exercised by any assertion a mock can make.
 *  - **The property set is the one the server knows.** `properties` is validated: an entry Stalwart
 *    does not recognise comes back as `invalidProperties`. So the negative case below is not decoration
 *    — it is the positive control that proves the acceptance above means something.
 *
 * **No browser push is involved and none could be.** Playwright cannot observe a closed app, and a
 * real endpoint would need a push service; ADR-017 already records that the closed-app half is
 * hand-verified per platform. What is automatable is the request/response pair, and that is what this
 * covers. The subscription created here is destroyed in the same test; Stalwart will POST one
 * `PushVerification` at the unroutable `push.example.com` in the meantime, which fails in the
 * background and leaves nothing behind.
 */
test.describe('draft-ietf-jmap-emailpush-03 wire contract', () => {
  const EMAILPUSH_URN = 'urn:ietf:params:jmap:emailpush'
  /** Must stay in step with `EMAIL_PUSH_PROPERTIES` in apps/web/src/notify/push-subscribe.ts. */
  const PROPERTIES = ['from', 'subject', 'preview', 'receivedAt']

  /**
   * One authenticated JMAP request, run from the page so the same-origin proxy applies.
   *
   * The endpoint is READ OFF THE SESSION, exactly as the client does (`buildConfigFromSession`),
   * and not spelled out here. It was, once — `/jmap/api`, an endpoint Stalwart does not serve: it
   * answers 404 there and JMAP lives at the advertised `apiUrl` (`/jmap/`). The 404 body has no
   * `methodResponses`, which made the positive test below throw on `[0]` and — far worse — made the
   * negative test two tests down pass for the wrong reason, since "no subscription was created"
   * is exactly what a 404 produces. A test that asserts an absence must reach the server first.
   */
  async function jmap(
    page: Page,
    using: string[],
    methodCalls: unknown[],
  ): Promise<Record<string, unknown>> {
    return page.evaluate(
      async ([body, credentials]) => {
        const auth = `Basic ${btoa(credentials as string)}`
        const session = (await (
          await fetch('/jmap/session', { headers: { authorization: auth } })
        ).json()) as { apiUrl: string }
        const response = await fetch(session.apiUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: auth },
          body: JSON.stringify(body),
        })
        return (await response.json()) as Record<string, unknown>
      },
      [{ using, methodCalls }, `${CREDENTIALS.user}:${CREDENTIALS.pass}`] as const,
    )
  }

  test('the fixture advertises the capability, and accepts the exact config Waxwing sends', async ({
    page,
  }) => {
    await page.goto('/')

    const session = await page.evaluate(async (credentials) => {
      const response = await fetch('/jmap/session', {
        headers: { authorization: `Basic ${btoa(credentials)}` },
      })
      return (await response.json()) as {
        capabilities: Record<string, unknown>
        primaryAccounts: Record<string, string>
      }
    }, `${CREDENTIALS.user}:${CREDENTIALS.pass}`)

    // The version guard. Everything below is meaningless if this is absent, and the app is right to
    // fall back to the contentless banner when it is.
    expect(Object.keys(session.capabilities)).toContain(EMAILPUSH_URN)

    const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'] ?? ''
    expect(accountId).toBeTruthy()

    const created = await jmap(
      page,
      ['urn:ietf:params:jmap:core', EMAILPUSH_URN],
      [
        [
          'PushSubscription/set',
          {
            create: {
              probe: {
                deviceClientId: 'waxwing-e2e-emailpush',
                // Stalwart validates the URL at create time and rejects a literal private or
                // reserved IP; a hostname is not resolved until it tries to send. This one never
                // resolves inside the container, which is exactly what is wanted — nothing is
                // delivered anywhere and the verification POST fails in the background.
                url: 'https://push.example.com/waxwing-e2e-emailpush',
                keys: null,
                types: ['EmailDelivery'],
                emailPush: { [accountId]: { filter: null, properties: PROPERTIES } },
              },
            },
          },
          'p0',
        ],
      ],
    )

    const createResult = (created.methodResponses as [string, Record<string, unknown>, string][])[0]
    expect(createResult?.[0]).toBe('PushSubscription/set')
    const notCreated = createResult?.[1].notCreated as Record<string, unknown> | null | undefined
    // Assert the failure map FIRST: a `notCreated.probe` carries the server's own explanation, and
    // reading it beats reading `created === null` and guessing why.
    expect(notCreated ?? null).toBeNull()
    const createdMap = createResult?.[1].created as Record<string, { id: string }> | null
    const subscriptionId = createdMap?.probe?.id
    expect(subscriptionId).toBeTruthy()

    try {
      /**
       * The positive control. Without it, "the server accepted our config" could equally mean "the
       * server ignores `emailPush` entirely" — and this whole feature would be a no-op that every
       * test in the repo passes.
       */
      const rejected = await jmap(
        page,
        ['urn:ietf:params:jmap:core', EMAILPUSH_URN],
        [
          [
            'PushSubscription/set',
            {
              update: {
                [subscriptionId as string]: {
                  emailPush: {
                    [accountId]: { filter: null, properties: ['definitelyNotAProperty'] },
                  },
                },
              },
            },
            'p1',
          ],
        ],
      )
      const updateResult = (
        rejected.methodResponses as [string, Record<string, unknown>, string][]
      )[0]
      const notUpdated = updateResult?.[1].notUpdated as Record<
        string,
        { type: string; properties?: string[] }
      > | null
      expect(notUpdated?.[subscriptionId as string]?.type).toBe('invalidProperties')
    } finally {
      await jmap(
        page,
        ['urn:ietf:params:jmap:core'],
        [['PushSubscription/set', { destroy: [subscriptionId] }, 'p2']],
      )
    }
  })

  /**
   * The other half of RFC 8620 §3.3 — and the answer this fixture gives is NOT the one this test
   * was written expecting, so read the measurement before changing it back.
   *
   * It asserted that a `PushSubscription/set` carrying `emailPush` while `using` names only
   * `urn:ietf:params:jmap:core` is REFUSED, on the theory that the per-call opt-in in `client.ts`
   * would otherwise be dead code. Measured against the fixture (Stalwart v0.16.18, 21.08.2026,
   * `alice@waxwing.test`), that is simply not what happens:
   *
   *  - the subscription is created, whether or not the URN is named;
   *  - the configuration is KEPT — a follow-up `PushSubscription/get` with
   *    `properties: ['emailPush']` reads back the exact map that was sent, `urgency` and all;
   *  - the property list is validated identically either way (a bogus entry is `invalidProperties`
   *    at create time as well as at update time).
   *
   * So this server does not police the opt-in, and no test run against it can prove that Waxwing's
   * `using: [Capabilities.emailPush]` is load-bearing — the unit suite pins that Waxwing sends it,
   * which is the client's half of §3.3 and all the client controls.
   *
   * What is still worth asserting, and is what the original comment actually named as the failure
   * mode, is that the configuration is never SILENTLY DROPPED: a server that takes the create and
   * quietly forgets `emailPush` would leave Waxwing believing it had contentful push while every
   * notification arrived empty, and nothing else in the suite would notice. Both outcomes therefore
   * pass — refusal (a server that does police it) and acceptance-with-the-config-stored — and the
   * one in between fails. That keeps the test honest if Stalwart ever tightens this.
   */
  test('never takes the property and silently drops it, `using` or no `using`', async ({
    page,
  }) => {
    await page.goto('/')

    const session = await page.evaluate(async (credentials) => {
      const response = await fetch('/jmap/session', {
        headers: { authorization: `Basic ${btoa(credentials)}` },
      })
      return (await response.json()) as { primaryAccounts: Record<string, string> }
    }, `${CREDENTIALS.user}:${CREDENTIALS.pass}`)
    const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'] ?? ''

    const response = await jmap(
      page,
      ['urn:ietf:params:jmap:core'],
      [
        [
          'PushSubscription/set',
          {
            create: {
              probe: {
                deviceClientId: 'waxwing-e2e-emailpush-nousing',
                url: 'https://push.example.com/waxwing-e2e-nousing',
                keys: null,
                types: ['EmailDelivery'],
                emailPush: { [accountId]: { filter: null, properties: PROPERTIES } },
              },
            },
          },
          'p0',
        ],
      ],
    )

    // A request-level problem document or a method-level refusal is a pass — that is a server that
    // polices the opt-in, and nothing was created to inspect.
    const responses = response.methodResponses as
      | [string, Record<string, unknown>, string][]
      | undefined
    const createdMap = responses?.[0]?.[1].created as Record<string, { id: string }> | null
    const subscriptionId = createdMap?.probe?.id
    if (subscriptionId === undefined) return

    // It WAS created (this fixture's answer). Then the configuration has to actually be there.
    // `emailPush` is not in the default property set — `PushSubscription/get` without an explicit
    // `properties` returns id/deviceClientId/verificationCode/expires/types and nothing else — so it
    // must be asked for by name or this assertion would read an absence that means nothing.
    try {
      const stored = await jmap(
        page,
        ['urn:ietf:params:jmap:core', EMAILPUSH_URN],
        [
          [
            'PushSubscription/get',
            { ids: [subscriptionId], properties: ['id', 'emailPush'] },
            'p1',
          ],
        ],
      )
      const list = (stored.methodResponses as [string, Record<string, unknown>, string][])[0]?.[1]
        .list as Array<{ emailPush?: Record<string, { properties?: string[] }> | null }> | undefined
      expect(list?.[0]?.emailPush?.[accountId]?.properties).toEqual(PROPERTIES)
    } finally {
      await jmap(
        page,
        ['urn:ietf:params:jmap:core'],
        [['PushSubscription/set', { destroy: [subscriptionId] }, 'p2']],
      )
    }
  })
})
