// Waxwing M1.9 read-suite mail seeder (dependency-free, Node >= 22 builtins only).
//
// Seeds alice's INBOX over JMAP with the deterministic corpus the read E2E asserts against:
//   - an HTML newsletter carrying a remote tracking image (exercises the remote-content banner
//     + the sandboxed body frame),
//   - a plain-text message (the flag / move / delete action target),
//   - a three-message threaded conversation (exercises the M1.8 conversation view; collapsed to
//     one list row when the inbox window collapses threads).
//
// IDEMPOTENT: every seeded mail carries the `wread` keyword; a reseed destroys the previous
// `wread` batch first, so re-running the suite always yields the same inbox. It talks to the
// container directly at BASE_URL (127.0.0.1:18080), never the advertised session URLs — those
// point at the browser origin (STALWART_PUBLIC_URL) during the suite and are not reachable here.
//
// `deliverLiveMail()` creates a single fresh inbox message at call time: the read suite uses it
// to prove push → sync → liveQuery delivers new mail to an open client without a refresh. (The
// P0.4 fixture maps only the HTTP/JMAP port, not SMTP, so JMAP Email/set is the delivery vector;
// the state change it triggers drives the same push notification an SMTP delivery would.)

import { BASE_URL, DOMAIN, PASSWORD } from './fixture.mjs'

const CORE = 'urn:ietf:params:jmap:core'
const MAIL = 'urn:ietf:params:jmap:mail'

/** Marks seeded mail so a reseed can find and remove the previous batch. */
export const READ_KEYWORD = 'wread'

/** Stable subjects the read spec asserts against. */
export const READ_SUBJECTS = {
  newsletter: 'Waxwing Weekly — issue 42',
  plain: 'Lunch on Thursday?',
  thread: 'Q3 planning sync',
}

export const READ_BODIES = {
  plain:
    'Hi Alice — are you free for lunch on Thursday around noon? There is a new place near the office. — Bob',
  newsletterMarker: 'Local-first webmail is having a moment.',
  threadOldest: 'Kicking off Q3 planning. Please add your team objectives to the shared doc.',
  threadMiddle: 'Thanks Bob — I added the design objectives and two open questions.',
  threadNewest: 'Looks good. Let us lock the plan in the sync on Friday.',
}

/** The remote image host in the newsletter — the read spec asserts it is CSP-blocked. */
export const READ_REMOTE_HOST = 'newsletter.invalid'

const alice = () => `alice@${DOMAIN}`
const bob = () => `bob@${DOMAIN}`
const carol = () => `carol@${DOMAIN}`
const authHeader = () => `Basic ${Buffer.from(`${alice()}:${PASSWORD}`).toString('base64')}`

async function getSession() {
  const res = await fetch(`${BASE_URL}/.well-known/jmap`, {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(`session fetch failed: HTTP ${res.status} (is the fixture up? pnpm e2e:server)`)
  }
  return res.json()
}

async function jmap(methodCalls) {
  const res = await fetch(`${BASE_URL}/jmap/`, {
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

async function getMailboxes(accountId) {
  const body = await jmap([
    ['Mailbox/get', { accountId, ids: null, properties: ['id', 'role', 'name'] }, '0'],
  ])
  return body.methodResponses[0][1].list
}

async function findInbox(accountId) {
  const list = await getMailboxes(accountId)
  const inbox = list.find((mailbox) => mailbox.role === 'inbox') ?? list[0]
  if (!inbox) throw new Error('no inbox on the account')
  return inbox.id
}

/**
 * Ensure alice has an Archive mailbox — Stalwart seeds only Inbox/Drafts/Sent/Junk/Trash, so the
 * reading action bar's Archive button would otherwise stay disabled. Idempotent.
 */
async function ensureArchiveMailbox(accountId) {
  const list = await getMailboxes(accountId)
  if (list.some((mailbox) => mailbox.role === 'archive')) return
  await jmap([
    ['Mailbox/set', { accountId, create: { a: { name: 'Archive', role: 'archive' } } }, '0'],
  ])
}

async function destroyExisting(accountId) {
  // Across ALL mailboxes: a prior run may have moved/trashed a `wread` mail, so an inbox-scoped
  // query would leave orphans behind and make reseeds non-deterministic.
  const queried = await jmap([
    ['Email/query', { accountId, filter: { hasKeyword: READ_KEYWORD }, limit: 500 }, '0'],
  ])
  const ids = queried.methodResponses[0][1].ids ?? []
  if (ids.length === 0) return 0
  await jmap([['Email/set', { accountId, destroy: ids }, '0']])
  return ids.length
}

function newsletterCreation(inboxId, receivedAt) {
  const html = [
    '<html><body>',
    '<h1>Waxwing Weekly</h1>',
    '<p>Your issue 42 digest.</p>',
    // A remote tracking image: the reading pane blocks it (banner) and the CSP refuses the fetch.
    `<img src="https://${READ_REMOTE_HOST}/pixel.png" alt="tracking pixel" width="1" height="1">`,
    '<h2>Top story</h2>',
    `<p>${READ_BODIES.newsletterMarker}</p>`,
    '<p><a href="https://example.invalid/read-more">Read more</a></p>',
    '</body></html>',
  ].join('\n')
  return {
    mailboxIds: { [inboxId]: true },
    keywords: { [READ_KEYWORD]: true, $seen: true },
    receivedAt,
    messageId: ['<newsletter-42@waxwing.test>'],
    from: [{ name: 'Waxwing Weekly', email: bob() }],
    to: [{ name: 'Alice Anderson', email: alice() }],
    subject: READ_SUBJECTS.newsletter,
    textBody: [{ partId: 't', type: 'text/plain' }],
    htmlBody: [{ partId: 'h', type: 'text/html' }],
    bodyValues: {
      t: { value: `Waxwing Weekly issue 42. ${READ_BODIES.newsletterMarker}` },
      h: { value: html },
    },
  }
}

function plainCreation(inboxId, receivedAt) {
  return {
    mailboxIds: { [inboxId]: true },
    // Left UNREAD (no $seen) so the list shows the unread indicator and mark-read has a target.
    keywords: { [READ_KEYWORD]: true },
    receivedAt,
    messageId: ['<lunch-thursday@waxwing.test>'],
    from: [{ name: 'Bob Baker', email: bob() }],
    to: [{ name: 'Alice Anderson', email: alice() }],
    subject: READ_SUBJECTS.plain,
    textBody: [{ partId: 't', type: 'text/plain' }],
    bodyValues: { t: { value: READ_BODIES.plain } },
  }
}

/** One message of the Q3 thread; `refs` are the prior messageIds (References/In-Reply-To chain). */
function threadCreation(inboxId, receivedAt, { id, from, name, subject, body, refs, seen }) {
  const creation = {
    mailboxIds: { [inboxId]: true },
    keywords: seen ? { [READ_KEYWORD]: true, $seen: true } : { [READ_KEYWORD]: true },
    receivedAt,
    messageId: [id],
    from: [{ name, email: from }],
    to: [{ name: 'Alice Anderson', email: alice() }],
    subject,
    textBody: [{ partId: 't', type: 'text/plain' }],
    bodyValues: { t: { value: body } },
  }
  if (refs.length > 0) {
    creation.inReplyTo = [refs[refs.length - 1]]
    creation.references = refs
  }
  return creation
}

/**
 * Seeds (resetting the previous `wread` batch first) alice's inbox with the read corpus. Returns
 * the account/inbox ids and the created count.
 */
export async function seedReadMail() {
  const session = await getSession()
  const accountId = session.primaryAccounts[MAIL]
  if (!accountId) throw new Error('alice has no primary mail account (bad credentials?)')
  const inboxId = await findInbox(accountId)
  await ensureArchiveMailbox(accountId)

  const removed = await destroyExisting(accountId)

  // Newest first: receivedAt decreases by an hour per slot so list ordering is deterministic.
  const base = Date.now()
  const at = (slot) => new Date(base - slot * 3_600_000).toISOString()

  const q1 = '<q3-1@waxwing.test>'
  const q2 = '<q3-2@waxwing.test>'
  const q3 = '<q3-3@waxwing.test>'

  const create = {
    // Thread newest occupies the most recent slot so the collapsed thread row sorts on top.
    tNew: threadCreation(inboxId, at(0), {
      id: q3,
      from: bob(),
      name: 'Bob Baker',
      subject: `Re: ${READ_SUBJECTS.thread}`,
      body: READ_BODIES.threadNewest,
      refs: [q1, q2],
      seen: true,
    }),
    plain: plainCreation(inboxId, at(1)),
    newsletter: newsletterCreation(inboxId, at(2)),
    tMid: threadCreation(inboxId, at(3), {
      id: q2,
      from: carol(),
      name: 'Carol Chen',
      subject: `Re: ${READ_SUBJECTS.thread}`,
      body: READ_BODIES.threadMiddle,
      refs: [q1],
      seen: true,
    }),
    tOld: threadCreation(inboxId, at(4), {
      id: q1,
      from: bob(),
      name: 'Bob Baker',
      subject: READ_SUBJECTS.thread,
      body: READ_BODIES.threadOldest,
      refs: [],
      seen: true,
    }),
  }

  const response = await jmap([['Email/set', { accountId, create }, '0']])
  const result = response.methodResponses[0][1]
  const created = Object.keys(result.created ?? {}).length
  const expected = Object.keys(create).length
  if (created !== expected) {
    throw new Error(
      `expected ${expected} created, got ${created}: ${JSON.stringify(result.notCreated ?? {})}`,
    )
  }
  return { accountId, inboxId, removed, created }
}

/**
 * Delivers ONE fresh message to alice's inbox at call time (the read suite's live-update probe).
 * Returns the subject actually delivered (unique per call via the supplied tag).
 */
export async function deliverLiveMail(tag = 'live') {
  const session = await getSession()
  const accountId = session.primaryAccounts[MAIL]
  const inboxId = await findInbox(accountId)
  const subject = `Fresh delivery — ${tag}`
  const response = await jmap([
    [
      'Email/set',
      {
        accountId,
        create: {
          d: {
            mailboxIds: { [inboxId]: true },
            keywords: { [READ_KEYWORD]: true },
            receivedAt: new Date().toISOString(),
            from: [{ name: 'Carol Chen', email: carol() }],
            to: [{ name: 'Alice Anderson', email: alice() }],
            subject,
            textBody: [{ partId: 't', type: 'text/plain' }],
            bodyValues: {
              t: { value: `This message arrived while the client was open (${tag}).` },
            },
          },
        },
      },
      '0',
    ],
  ])
  const created = response.methodResponses[0][1].created?.d
  if (!created) {
    const notCreated = response.methodResponses[0][1].notCreated
    throw new Error(`live delivery failed: ${JSON.stringify(notCreated)}`)
  }
  return subject
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  seedReadMail()
    .then((summary) => {
      console.log(
        `[seed-read] inbox ${summary.inboxId}: removed ${summary.removed}, created ${summary.created}`,
      )
    })
    .catch((error) => {
      console.error(`[seed-read] ${error.stack ?? error.message}`)
      process.exit(1)
    })
}
