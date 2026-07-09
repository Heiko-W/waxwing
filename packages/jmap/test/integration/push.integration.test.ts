/**
 * SP.3 integration test — push transports against the live P0.4 Stalwart fixture.
 *
 * Like the SP.1 suite this is NOT a hermetic unit test: it opens real WebSocket / SSE push
 * channels to a running Stalwart, triggers mail, and asserts `StateChange` delivery — then
 * restarts the container and asserts the channel reconnects and keeps delivering. Bring the
 * fixture up first:
 *
 *   pnpm e2e:server                              # up + provision + smoke
 *   pnpm --filter @waxwing/jmap test:integration # this suite
 *   pnpm e2e:server:down                         # always tear down
 *
 * The suite auto-skips when the fixture is unreachable (mirrors the SP.1 skip behaviour).
 *
 * Auth: HTTP Basic (the fixture's shared dev credentials). Both transports authenticate the
 * same way the SP.3 probe proved works — a fetch-based SSE reader with an `Authorization`
 * header, and (in Node/undici) a WebSocket handshake carrying the header.
 */

import { execFileSync } from 'node:child_process'
import {
  basic,
  Capabilities,
  getSession,
  JmapClient,
  MailboxRoles,
  Methods,
  type PushChannel,
  type PushStatus,
  SseChannel,
  type StateChange,
  WebSocketChannel,
} from '@waxwing/jmap'
import { beforeAll, describe, expect, it } from 'vitest'

const BASE = 'http://localhost:18080'
const USERNAME = 'alice@waxwing.test'
const PASSWORD = 'waxwing-e2e-Pw1!'
const CONTAINER = 'waxwing-stalwart-dev'

const auth = basic(USERNAME, PASSWORD)

/** Reachability probe so the suite skips cleanly when the fixture is down. */
async function fixtureReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/.well-known/jmap`, { redirect: 'follow' })
    return res.ok
  } catch {
    return false
  }
}
const AVAILABLE = await fixtureReachable()

let client: JmapClient
let accountId: string
let inboxId: string

/** Waits for the next StateChange whose `changed[accountId]` satisfies `predicate`. */
function nextStateChange(
  channel: PushChannel,
  predicate: (types: Record<string, string>) => boolean,
  timeoutMs = 15_000,
): Promise<{ change: StateChange; types: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`no matching StateChange within ${timeoutMs}ms`))
    }, timeoutMs)
    const unsubscribe = channel.subscribe((change) => {
      const types = change.changed[accountId]
      if (types && predicate(types)) {
        clearTimeout(timer)
        unsubscribe()
        resolve({ change, types })
      }
    })
  })
}

/** Waits until the channel reports the given status. */
function waitForStatus(
  channel: PushChannel,
  status: PushStatus,
  timeoutMs = 20_000,
): Promise<void> {
  if (channel.status === status) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`status did not reach "${status}" within ${timeoutMs}ms`))
    }, timeoutMs)
    const unsubscribe = channel.onStatus((next) => {
      if (next === status) {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
  })
}

/**
 * Resolves once the channel has left `open` (a drop) and returned to `open` — a full
 * reconnect cycle. Race-free: `docker restart` blocks the event loop, so the drop event is
 * still queued when we subscribe here.
 */
function waitForReconnect(channel: PushChannel, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let sawDrop = channel.status !== 'open'
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`did not reconnect within ${timeoutMs}ms`))
    }, timeoutMs)
    const unsubscribe = channel.onStatus((next) => {
      if (next !== 'open') {
        sawDrop = true
      } else if (sawDrop) {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
  })
}

/** Files a fresh Email into the Inbox via Email/set (a JMAP import); returns the new id. */
async function deliverMail(label: string): Promise<string> {
  const request = client.request()
  const handle = request.invoke(Methods.emailSet, {
    accountId,
    create: {
      seed: {
        mailboxIds: { [inboxId]: true },
        keywords: {},
        from: [{ name: 'Alice', email: USERNAME }],
        to: [{ name: 'Alice', email: USERNAME }],
        subject: `Waxwing SP.3 push ${label} ${Date.now().toString(36)}`,
        textBody: [{ partId: 'text', type: 'text/plain' }],
        bodyValues: {
          text: { value: `push probe ${label}`, isEncodingProblem: false, isTruncated: false },
        },
      },
    },
  })
  const result = (await request.send()).get(handle)
  const created = result.created?.seed
  if (!created) throw new Error(`Email/set failed: ${JSON.stringify(result.notCreated)}`)
  return created.id
}

function restartFixture(): void {
  execFileSync('docker', ['restart', CONTAINER], { stdio: 'ignore' })
}

beforeAll(async () => {
  if (!AVAILABLE) return
  const session = await getSession(BASE, auth)
  accountId = session.primaryAccounts[Capabilities.mail] ?? ''
  client = new JmapClient({ session, auth, sessionUrl: BASE })

  const mailboxes = client.request()
  const handle = mailboxes.invoke(Methods.mailboxGet, { accountId, ids: null })
  const { list } = (await mailboxes.send()).get(handle)
  const inbox = list.find((mailbox) => mailbox.role === MailboxRoles.inbox) ?? list[0]
  if (!inbox) throw new Error('no mailbox found on the account')
  inboxId = inbox.id
}, 30_000)

describe.skipIf(!AVAILABLE)('SP.3 · push transports ↔ live Stalwart fixture', () => {
  it('exposes the WebSocket capability with supportsPush', () => {
    const cap = client.session.capabilities[Capabilities.webSocket]
    expect(cap).toBeDefined()
    expect((cap as { supportsPush?: boolean }).supportsPush).toBe(true)
  })

  // One shared scenario per transport: open → StateChange on incoming mail (with latency) →
  // container restart → reconnect → StateChange on a subsequent mail.
  const transports: { name: string; make: () => PushChannel }[] = [
    {
      name: 'WebSocket (RFC 8887)',
      make: () =>
        new WebSocketChannel({
          session: client.session,
          auth,
          dataTypes: ['Email', 'Mailbox', 'Thread', 'EmailDelivery'],
        }),
    },
    {
      name: 'SSE (fetch reader)',
      make: () => new SseChannel({ session: client.session, auth, types: '*' }),
    },
  ]

  for (const { name, make } of transports) {
    it(`${name}: delivers StateChange for incoming mail and survives a restart`, async () => {
      const channel = make()
      const errors: Error[] = []
      channel.onError((error) => errors.push(error))
      channel.open()
      try {
        await waitForStatus(channel, 'open')

        // 1) StateChange for a freshly delivered mail — measure latency.
        const firstChange = nextStateChange(channel, (types) => 'Email' in types)
        const t0 = Date.now()
        await deliverMail('initial')
        const { types } = await firstChange
        const latency = Date.now() - t0
        expect(types.Email).toBeTruthy()
        expect(types.Mailbox).toBeTruthy()
        console.log(
          `[SP.3] ${name}: StateChange latency ${latency}ms; changed types = ${Object.keys(types).join(', ')}`,
        )

        // 2) Restart Stalwart mid-channel; the channel must reconnect on its own.
        console.log(`[SP.3] ${name}: restarting ${CONTAINER} ...`)
        const reconnected = waitForReconnect(channel, 40_000)
        restartFixture()
        await reconnected
        console.log(`[SP.3] ${name}: reconnected`)

        // 3) A StateChange must still arrive for mail delivered after the restart.
        const secondChange = nextStateChange(channel, (types) => 'Email' in types, 20_000)
        const t1 = Date.now()
        await deliverMail('post-restart')
        const after = await secondChange
        console.log(`[SP.3] ${name}: post-restart StateChange latency ${Date.now() - t1}ms`)
        expect(after.types.Email).toBeTruthy()
      } finally {
        channel.close()
      }
    }, 90_000)
  }
})
