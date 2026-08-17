// Waxwing SP.4 demo mail seeder (dependency-free, Node >= 22 builtins only).
//
// Seeds alice's INBOX over JMAP with a deterministic set of demo messages for the raw
// end-to-end demo (scripts/demo.mjs): a plain-text mail, an HTML mail carrying a <script> and
// a remote <img> (proves the sandboxed iframe), a mail with a message/rfc822 attachment (for
// the Email/parse button), plus filler to exercise paging (25 total).
//
// IDEMPOTENT: every seeded mail carries the `wdemo` keyword; a reseed destroys the previous
// `wdemo` mails first, so re-running `pnpm demo` always yields the same inbox.
//
// It talks to the container DIRECTLY at BASE_URL (127.0.0.1:18080), never the advertised
// session URLs — those may point at the browser origin (STALWART_PUBLIC_URL) during the demo
// and would not be reachable from here.

import { BASE_URL, DOMAIN, PASSWORD } from './fixture.mjs'
import { fetchThrottled } from './http.mjs'

const CORE = 'urn:ietf:params:jmap:core'
const MAIL = 'urn:ietf:params:jmap:mail'

/** Marks seeded mail so a reseed can find and remove the previous batch. */
export const DEMO_KEYWORD = 'wdemo'

// Stable subjects the Playwright demo spec asserts against.
export const DEMO_SUBJECTS = {
  plain: 'Waxwing demo — plain text hello',
  html: 'Waxwing demo — HTML with a script and an image',
  rfc822: 'Waxwing demo — forwarded message (.eml)',
  inner: 'Original quarterly figures',
}

export const DEMO_PLAIN_BODY =
  'Hello Alice — this is a plain-text demo message, delivered over JMAP and read end to end.'
export const DEMO_INNER_BODY =
  'These are the original quarterly figures that were forwarded to you as a .eml attachment.'

const alice = () => `alice@${DOMAIN}`
const bob = () => `bob@${DOMAIN}`
const carol = () => `carol@${DOMAIN}`
const authHeader = () => `Basic ${Buffer.from(`${alice()}:${PASSWORD}`).toString('base64')}`

async function getSession() {
  const res = await fetchThrottled(`${BASE_URL}/.well-known/jmap`, {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(`session fetch failed: HTTP ${res.status} (is the fixture up? pnpm e2e:server)`)
  }
  return res.json()
}

async function jmap(methodCalls) {
  const res = await fetchThrottled(`${BASE_URL}/jmap/`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ using: [CORE, MAIL], methodCalls }),
  })
  if (!res.ok) throw new Error(`JMAP request failed: HTTP ${res.status} — ${await res.text()}`)
  return res.json()
}

async function uploadBlob(accountId, contentType, body) {
  const res = await fetchThrottled(`${BASE_URL}/jmap/upload/${accountId}/`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': contentType },
    body,
  })
  if (!res.ok) throw new Error(`blob upload failed: HTTP ${res.status} — ${await res.text()}`)
  return res.json()
}

async function findInbox(accountId) {
  const body = await jmap([
    ['Mailbox/get', { accountId, ids: null, properties: ['id', 'role'] }, '0'],
  ])
  const list = body.methodResponses[0][1].list
  const inbox = list.find((mailbox) => mailbox.role === 'inbox') ?? list[0]
  if (!inbox) throw new Error('no inbox on the account')
  return inbox.id
}

async function destroyExisting(accountId, inboxId) {
  const queried = await jmap([
    [
      'Email/query',
      { accountId, filter: { inMailbox: inboxId, hasKeyword: DEMO_KEYWORD }, limit: 500 },
      '0',
    ],
  ])
  const ids = queried.methodResponses[0][1].ids ?? []
  if (ids.length === 0) return 0
  await jmap([['Email/set', { accountId, destroy: ids }, '0']])
  return ids.length
}

// RFC 5322 message used as the message/rfc822 attachment (parsed by the Email/parse button).
function innerMessage() {
  return [
    'From: Dave Original <dave@waxwing.test>',
    `To: Carol Chen <${carol()}>`,
    `Subject: ${DEMO_SUBJECTS.inner}`,
    'Date: Wed, 08 Jul 2026 09:30:00 +0000',
    'Message-ID: <inner-demo@waxwing.test>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    DEMO_INNER_BODY,
    '',
  ].join('\r\n')
}

function plainCreation(inboxId, receivedAt) {
  return {
    mailboxIds: { [inboxId]: true },
    keywords: { [DEMO_KEYWORD]: true },
    receivedAt,
    from: [{ name: 'Bob Baker', email: bob() }],
    to: [{ name: 'Alice Anderson', email: alice() }],
    subject: DEMO_SUBJECTS.plain,
    textBody: [{ partId: 't', type: 'text/plain' }],
    bodyValues: { t: { value: DEMO_PLAIN_BODY } },
  }
}

function htmlCreation(inboxId, receivedAt) {
  const html = [
    '<html><body>',
    '<h1>HTML demo message</h1>',
    '<p>This message carries an inline script and a remote image.</p>',
    // The naive iframe (sandbox="") must NOT run this script and must NOT leak the image.
    "<script>document.title = 'xss-should-not-run'; document.body.innerHTML += '<p>SCRIPT RAN</p>'</script>",
    '<img src="https://example.invalid/tracker.png" alt="remote tracker pixel">',
    '<p>End of HTML demo.</p>',
    '</body></html>',
  ].join('\n')
  return {
    mailboxIds: { [inboxId]: true },
    keywords: { [DEMO_KEYWORD]: true },
    receivedAt,
    from: [{ name: 'Bob Baker', email: bob() }],
    to: [{ name: 'Alice Anderson', email: alice() }],
    subject: DEMO_SUBJECTS.html,
    textBody: [{ partId: 't', type: 'text/plain' }],
    htmlBody: [{ partId: 'h', type: 'text/html' }],
    bodyValues: {
      t: { value: 'HTML demo message (plain-text alternative).' },
      h: { value: html },
    },
  }
}

function rfc822Creation(inboxId, receivedAt, innerBlobId) {
  return {
    mailboxIds: { [inboxId]: true },
    keywords: { [DEMO_KEYWORD]: true },
    receivedAt,
    from: [{ name: 'Carol Chen', email: carol() }],
    to: [{ name: 'Alice Anderson', email: alice() }],
    subject: DEMO_SUBJECTS.rfc822,
    textBody: [{ partId: 't', type: 'text/plain' }],
    bodyValues: { t: { value: 'Please see the forwarded message attached as forwarded.eml.' } },
    attachments: [
      {
        blobId: innerBlobId,
        type: 'message/rfc822',
        name: 'forwarded.eml',
        disposition: 'attachment',
      },
    ],
  }
}

function fillerCreation(inboxId, receivedAt, index) {
  const sender = index % 2 === 0 ? bob() : carol()
  const name = index % 2 === 0 ? 'Bob Baker' : 'Carol Chen'
  const seen = index % 3 === 0
  const keywords = { [DEMO_KEYWORD]: true }
  if (seen) keywords.$seen = true
  return {
    mailboxIds: { [inboxId]: true },
    keywords,
    receivedAt,
    from: [{ name, email: sender }],
    to: [{ name: 'Alice Anderson', email: alice() }],
    subject: `Waxwing demo — message ${index}`,
    textBody: [{ partId: 't', type: 'text/plain' }],
    bodyValues: { t: { value: `Filler demo message number ${index}, to exercise paging.` } },
  }
}

/**
 * Seeds (resetting first) alice's inbox with the demo mails. `total` is the mail count
 * (default 25). Returns a small summary.
 */
export async function seedDemoMail(total = 25) {
  const session = await getSession()
  const accountId = session.primaryAccounts[MAIL]
  if (!accountId) throw new Error('alice has no primary mail account (bad credentials?)')
  const inboxId = await findInbox(accountId)

  const removed = await destroyExisting(accountId, inboxId)

  const innerBlob = await uploadBlob(accountId, 'message/rfc822', innerMessage())

  // Newest first: receivedAt decreases by an hour per index so ordering is deterministic.
  const base = Date.now()
  const at = (index) => new Date(base - index * 3_600_000).toISOString()

  const create = {}
  create.m0 = htmlCreation(inboxId, at(0))
  create.m1 = rfc822Creation(inboxId, at(1), innerBlob.blobId)
  create.m2 = plainCreation(inboxId, at(2))
  for (let index = 3; index < total; index += 1) {
    create[`m${index}`] = fillerCreation(inboxId, at(index), index)
  }

  const response = await jmap([['Email/set', { accountId, create }, '0']])
  const result = response.methodResponses[0][1]
  const created = Object.keys(result.created ?? {}).length
  if (created !== total) {
    throw new Error(
      `expected ${total} created, got ${created}: ${JSON.stringify(result.notCreated ?? {})}`,
    )
  }
  return { accountId, inboxId, removed, created }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  seedDemoMail()
    .then((summary) => {
      console.log(
        `[seed-demo] inbox ${summary.inboxId}: removed ${summary.removed}, created ${summary.created}`,
      )
    })
    .catch((error) => {
      console.error(`[seed-demo] ${error.stack ?? error.message}`)
      process.exit(1)
    })
}
