// Waxwing M2.9 write-suite helpers (dependency-free, Node >= 22 builtins only).
//
// The write suite drives the REAL app to COMPOSE + SEND, then verifies the outcome by talking to
// the Stalwart container DIRECTLY over JMAP (never the app's sync): a JMAP poll of the recipient
// (bob) proves real delivery, and a JMAP read of the sender (alice) proves the Sent-side refile.
// DP-1 (verified live 2026-07-11): `EmailSubmission/set` alice→bob DELIVERS to bob's Inbox and
// `onSuccessUpdateEmail` moves alice's copy Drafts→Sent + clears `$draft` + sets `$seen`.
//
// Determinism: every outbound message the suite generates carries the `[wwrite]` subject prefix;
// `resetWriteMail()` destroys any prior `[wwrite]` mail across alice+bob so a rerun starts clean.
// Talks to the container at BASE_URL (127.0.0.1:18080), never the advertised (browser-origin) URLs.

import { BASE_URL, DOMAIN, PASSWORD } from './fixture.mjs'
import { fetchThrottled } from './http.mjs'

const CORE = 'urn:ietf:params:jmap:core'
const MAIL = 'urn:ietf:params:jmap:mail'

/** Subject prefix on every write-suite message (the reset key + the poll token base). */
export const WRITE_PREFIX = '[wwrite]'
/** The subject-filter token (JMAP `subject` is a tokenized contains-match; `[]` don't tokenize). */
export const WRITE_TOKEN = 'wwrite'

export const ACCOUNTS = {
  alice: `alice@${DOMAIN}`,
  bob: `bob@${DOMAIN}`,
}

const authHeader = (login) => `Basic ${Buffer.from(`${login}:${PASSWORD}`).toString('base64')}`

/** A tiny per-account JMAP client against the container (Basic auth). */
export function jmapAs(login) {
  async function session() {
    const res = await fetchThrottled(`${BASE_URL}/.well-known/jmap`, {
      headers: { Authorization: authHeader(login), Accept: 'application/json' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`session ${login}: HTTP ${res.status} (is the fixture up?)`)
    return res.json()
  }
  async function account() {
    return (await session()).primaryAccounts[MAIL]
  }
  async function call(using, methodCalls) {
    const res = await fetchThrottled(`${BASE_URL}/jmap/`, {
      method: 'POST',
      headers: {
        Authorization: authHeader(login),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ using, methodCalls }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`jmap ${login}: HTTP ${res.status} — ${text}`)
    return JSON.parse(text)
  }
  async function mailboxes() {
    const acc = await account()
    const res = await call(
      [CORE, MAIL],
      [['Mailbox/get', { accountId: acc, ids: null, properties: ['id', 'role', 'name'] }, '0']],
    )
    return res.methodResponses[0][1].list
  }
  /** Emails whose subject contains `token`, returning the requested props. */
  async function query(token, properties = ['subject']) {
    const acc = await account()
    const q = await call(
      [CORE, MAIL],
      [['Email/query', { accountId: acc, filter: { subject: token } }, '0']],
    )
    const ids = q.methodResponses[0][1].ids
    if (ids.length === 0) return []
    const g = await call([CORE, MAIL], [['Email/get', { accountId: acc, ids, properties }, '0']])
    return g.methodResponses[0][1].list
  }
  return { login, session, account, call, mailboxes, query }
}

/** The role of each mailbox id, for asserting placement (Inbox vs Junk vs Sent). */
export async function mailboxRoles(client) {
  const list = await client.mailboxes()
  return new Map(list.map((m) => [m.id, m.role ?? m.name]))
}

/** Poll `client` for messages whose subject contains `token`; returns [] on timeout. */
export async function pollMail(client, token, properties = ['subject', 'mailboxIds'], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const intervalMs = opts.intervalMs ?? 1000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const msgs = await client.query(token, properties)
    if (msgs.length > 0) return msgs
    if (Date.now() > deadline) return []
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Assert `client` has NO mail matching `token` for the whole window (undo-send non-delivery). */
export async function expectNoMail(client, token, windowMs = 12_000) {
  const deadline = Date.now() + windowMs
  for (;;) {
    const msgs = await client.query(token, ['subject'])
    if (msgs.length > 0) return msgs // delivered — caller asserts this is empty
    if (Date.now() > deadline) return []
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** One email by id, with the requested props (or null if gone). */
export async function emailById(client, id, properties = ['keywords']) {
  const acc = await client.account()
  const g = await client.call(
    [CORE, MAIL],
    [['Email/get', { accountId: acc, ids: [id], properties }, '0']],
  )
  return g.methodResponses[0][1].list[0] ?? null
}

/** Poll one email by id until `predicate(email)` holds or the timeout elapses (returns the last read). */
export async function pollEmail(client, id, predicate, properties = ['keywords'], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const email = await emailById(client, id, properties)
    if (email && predicate(email)) return email
    if (Date.now() > deadline) return email
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/**
 * Remove any `[wwrite]` mail across alice + bob so each run starts clean. Idempotent. Filters by a
 * subject SUBSTRING in JS (not a JMAP `subject` filter) because `[wwrite]` does not tokenize to a
 * reliable match term.
 */
export async function resetWriteMail() {
  let removed = 0
  for (const login of [ACCOUNTS.alice, ACCOUNTS.bob]) {
    const client = jmapAs(login)
    const acc = await client.account()
    const q = await client.call(
      [CORE, MAIL],
      [
        [
          'Email/query',
          { accountId: acc, sort: [{ property: 'receivedAt', isAscending: false }], limit: 200 },
          '0',
        ],
      ],
    )
    const ids = q.methodResponses[0][1].ids
    if (ids.length === 0) continue
    const g = await client.call(
      [CORE, MAIL],
      [['Email/get', { accountId: acc, ids, properties: ['subject'] }, '0']],
    )
    const toDestroy = g.methodResponses[0][1].list
      .filter((m) => (m.subject ?? '').includes(WRITE_PREFIX))
      .map((m) => m.id)
    if (toDestroy.length > 0) {
      await client.call([CORE, MAIL], [['Email/set', { accountId: acc, destroy: toDestroy }, '0']])
      removed += toDestroy.length
    }
  }
  return removed
}

/**
 * Seed a source message FROM bob in alice's Inbox with a stable Message-ID, so the reply spec can
 * assert `inReplyTo`/`references` threading + the source flagged `$answered`. Returns the id +
 * (bracket-stripped) messageId the app will thread against.
 */
export async function seedReplySource() {
  const client = jmapAs(ACCOUNTS.alice)
  const acc = await client.account()
  const inbox = (await client.mailboxes()).find((m) => m.role === 'inbox')
  if (!inbox) throw new Error('alice has no inbox')
  const token = `replysrc-${Date.now()}`
  const messageId = `wwrite-${token}@${DOMAIN}`
  const subject = `${WRITE_PREFIX} ${token}`
  const res = await client.call(
    [CORE, MAIL],
    [
      [
        'Email/set',
        {
          accountId: acc,
          create: {
            src: {
              mailboxIds: { [inbox.id]: true },
              keywords: {},
              from: [{ name: 'Bob', email: ACCOUNTS.bob }],
              to: [{ email: ACCOUNTS.alice }],
              subject,
              messageId: [messageId],
              htmlBody: [{ partId: 'h', type: 'text/html' }],
              bodyValues: {
                h: {
                  value: '<p>Could you please advise?</p>',
                  isEncodingProblem: false,
                  isTruncated: false,
                },
              },
            },
          },
        },
        '0',
      ],
    ],
  )
  const created = res.methodResponses[0][1].created?.src
  if (!created) {
    throw new Error(
      `seedReplySource failed: ${JSON.stringify(res.methodResponses[0][1].notCreated)}`,
    )
  }
  return { emailId: created.id, messageId, subject, token }
}
