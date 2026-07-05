/**
 * SP.1 integration test — @waxwing/jmap against the live P0.4 Stalwart fixture.
 *
 * This is deliberately NOT a unit test: it talks to a real Stalwart JMAP server over the
 * network and is kept out of the hermetic `pnpm test` run (own directory, own vitest config,
 * `*.integration.test.ts` suffix). Bring the fixture up first:
 *
 *   pnpm e2e:server                              # up + provision + smoke
 *   pnpm --filter @waxwing/jmap test:integration # this suite
 *   pnpm e2e:server:down                         # always tear down
 *
 * Every assertion goes exclusively through the typed `@waxwing/jmap` public API — the same
 * surface an app consumes. It exercises the SP.1 Done-when end to end: session discovery,
 * role-mailbox listing, a real Email/set create followed by a back-referenced
 * Email/query -> Email/get, and a blob upload/download round-trip.
 */

import { basic, Capabilities, getSession, JmapClient, MailboxRoles, Methods } from '@waxwing/jmap'
import { beforeAll, describe, expect, it } from 'vitest'

/** Base origin of the P0.4 fixture (README: plain HTTP on localhost:18080). */
const BASE = 'http://localhost:18080'
/** Shared dev credentials for the provisioned test account. */
const USERNAME = 'alice@waxwing.test'
const PASSWORD = 'waxwing-e2e-Pw1!'

/** Unique per run so re-runs against an already-up fixture never collide. */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const SUBJECT = `Waxwing SP.1 integration ${RUN_ID}`
const BODY = `Hello from the Waxwing SP.1 integration test (${RUN_ID}).`

const auth = basic(USERNAME, PASSWORD)

// Established once in beforeAll and reused across the ordered `it` blocks (vitest runs the
// tests in a file sequentially, so the seed step is visible to the read step).
let client: JmapClient
let accountId: string
let mailboxId: string
let capabilityKeys: string[]

beforeAll(async () => {
  // Step 1 — session discovery through the typed API. `getSession` follows the well-known
  // 307 -> /jmap/session redirect and normalises the URL templates for us.
  const session = await getSession(BASE, auth)
  capabilityKeys = Object.keys(session.capabilities)

  accountId = session.primaryAccounts[Capabilities.mail] ?? ''
  client = new JmapClient({ session, auth, sessionUrl: BASE })
}, 30_000)

describe('SP.1 · @waxwing/jmap ↔ live Stalwart fixture', () => {
  it('getSession advertises core+mail capabilities and a primary mail account', () => {
    const session = client.session

    // Capabilities the app relies on are present (RFC 8620 core + RFC 8621 mail).
    expect(capabilityKeys).toContain(Capabilities.core)
    expect(capabilityKeys).toContain(Capabilities.mail)

    // A usable, authenticated session: our username, a non-empty accounts map, and a
    // primary account for mail that resolves to a real Account object.
    expect(session.username).toBe(USERNAME)
    expect(Object.keys(session.accounts).length).toBeGreaterThan(0)
    expect(accountId).not.toBe('')
    expect(session.accounts[accountId]).toBeDefined()

    // The session carried real, POSTable endpoints (normalised to absolute URLs).
    expect(session.apiUrl).toMatch(/^https?:\/\//)
    expect(session.uploadUrl).toContain('{accountId}')
    expect(session.downloadUrl).toContain('{blobId}')
  })

  it('lists the account mailboxes and finds the standard role mailboxes', async () => {
    // Step 2 — Mailbox/get for the whole account (ids: null = every mailbox).
    const request = client.request()
    const handle = request.invoke(Methods.mailboxGet, { accountId, ids: null })
    const response = (await request.send()).get(handle)

    expect(response.accountId).toBe(accountId)
    expect(response.list.length).toBeGreaterThan(0)

    // A fresh Stalwart account is seeded with the standard folders, so at least one mailbox
    // must carry an IANA role — and specifically an Inbox we can file the seed email into.
    const withRole = response.list.filter((mailbox) => mailbox.role !== null)
    expect(withRole.length).toBeGreaterThan(0)

    const inbox = response.list.find((mailbox) => mailbox.role === MailboxRoles.inbox)
    // Fall back to any mailbox that accepts new items, should a server omit the inbox role.
    const target = inbox ?? response.list.find((mailbox) => mailbox.myRights.mayAddItems)
    expect(target).toBeDefined()
    if (!target) throw new Error('no writable mailbox found on the account')
    mailboxId = target.id
  })

  it('seeds an email (Email/set) then reads it back via Email/query → Email/get', async () => {
    // Step 3a — create a real message with Email/set (a JMAP "import"): file it in the
    // target mailbox, mark it seen, and give it a plaintext body.
    const create = client.request()
    const setHandle = create.invoke(Methods.emailSet, {
      accountId,
      create: {
        seed: {
          mailboxIds: { [mailboxId]: true },
          keywords: { $seen: true },
          from: [{ name: 'Alice', email: USERNAME }],
          to: [{ name: 'Alice', email: USERNAME }],
          subject: SUBJECT,
          textBody: [{ partId: 'text', type: 'text/plain' }],
          bodyValues: {
            text: { value: BODY, isEncodingProblem: false, isTruncated: false },
          },
        },
      },
    })
    const setResponse = (await create.send()).get(setHandle)

    // If Stalwart refuses the create, surface the exact SetError so the failure is documented
    // rather than silently swallowed (see the header comment's fallback note).
    const notCreated = setResponse.notCreated?.seed
    expect(notCreated, `Email/set rejected the seed: ${JSON.stringify(notCreated)}`).toBeUndefined()

    const created = setResponse.created?.seed
    expect(created).toBeDefined()
    const createdId = created?.id
    expect(createdId).toBeTruthy()

    // Step 3b — a single request that back-references the query's ids into the get
    // (RFC 8620 §3.7): this is the query -> get chain the client is built to express.
    const read = client.request()
    const query = read.invoke(Methods.emailQuery, {
      accountId,
      filter: { inMailbox: mailboxId },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: 50,
    })
    const get = read.invoke(Methods.emailGet, {
      accountId,
      '#ids': query.ref('/ids'),
      properties: [
        'id',
        'subject',
        'from',
        'to',
        'receivedAt',
        'preview',
        'textBody',
        'bodyValues',
      ],
      fetchTextBodyValues: true,
    })
    const responses = await read.send()
    const queryResult = responses.get(query)
    const getResult = responses.get(get)

    // The query saw our freshly-created email…
    expect(queryResult.ids).toContain(createdId)

    // …and the back-referenced get returned it with the content we wrote.
    const fetched = getResult.list.find((email) => email.id === createdId)
    expect(fetched).toBeDefined()
    if (!fetched) throw new Error('seeded email not returned by Email/get')
    expect(fetched.subject).toBe(SUBJECT)

    const partId = fetched.textBody[0]?.partId ?? undefined
    expect(partId).toBeTruthy()
    const bodyValue = partId ? fetched.bodyValues[partId] : undefined
    // Servers may normalise the trailing newline of a text/plain body; compare trimmed.
    expect(bodyValue?.value.trim()).toBe(BODY)
  })

  it('round-trips a blob: upload bytes, download the returned blobId, compare', async () => {
    // Step 4 — distinct, non-trivial bytes (incl. a non-ASCII char) so a truncation or
    // encoding bug can't pass by accident.
    const payload = new TextEncoder().encode(`waxwing-blob ${RUN_ID} · round-trip ✔`)

    const uploaded = await client.upload(accountId, payload, { type: 'application/octet-stream' })
    expect(uploaded.blobId).toBeTruthy()
    expect(uploaded.size).toBe(payload.byteLength)

    const downloaded = await client.download(
      accountId,
      uploaded.blobId,
      'application/octet-stream',
      'waxwing-blob.bin',
    )

    // Byte-for-byte identity.
    expect(downloaded.byteLength).toBe(payload.byteLength)
    expect(Array.from(downloaded)).toEqual(Array.from(payload))
  })
})
