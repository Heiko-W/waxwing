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
  pdf: 'Quarterly report (PDF)',
  plain: 'Lunch on Thursday?',
  thread: 'Q3 planning sync',
  phishing: 'Your account needs verification',
  rfc822: 'Fwd: the original quarterly figures',
}

/**
 * The M3.9 phishing corpus (FR-RD-06 auth-results + FR-RD-08). One imported message carries every
 * hostile pattern at once, because they co-occur in the real thing:
 *
 *  - TWO `Authentication-Results` headers. The topmost is what a trusting MTA would have prepended
 *    (dmarc=FAIL); the one below is the SENDER'S OWN FORGERY (dmarc=pass). RFC 8621 §4.1.2 makes
 *    `header:X:asText` return the *last* instance — i.e. the attacker's — so a client that asks the
 *    obvious way renders "dmarc=pass" for a message that failed. `:asText:all` + `[0]` is the fix,
 *    and this message is what proves it live.
 *  - A display name that IS an email address, different from the real one (`"security@bank.test"
 *    <mallory@evil.tld>`) — the trick no hover affordance catches on touch.
 *  - A link whose TEXT claims `https://bank.test/account` but whose href goes to `paypa1-secure.ru`.
 *  - A benign link in the same body, so the warning's false-positive rate is asserted too.
 */
export const READ_PHISHING = {
  /** The forged authserv-id — must NEVER be what the UI attributes the results to. */
  forgedAuthserv: 'forged.attacker.test',
  /** The topmost (trusted-position) authserv-id — this is what the UI must report. */
  trustedAuthserv: 'mx.waxwing.test',
  displayName: 'security@bank.test',
  realAddress: 'mallory@evil.tld',
  linkText: 'https://bank.test/account',
  linkTarget: 'https://paypa1-secure.ru/login',
  benignText: 'the Waxwing handbook',
  benignTarget: 'https://example.invalid/handbook',
}

/**
 * A minimal but genuinely valid PDF, carried as an ordinary attachment.
 *
 * It exists for one assertion the rest of the corpus cannot make: the attachment PREVIEW renders a
 * `blob:` URL inside an `<iframe sandbox="">`, and `frame-src 'self'` does not cover `blob:` — so
 * the preview was CSP-blocked in every build, showing an empty panel under `aria-expanded="true"`.
 * Only a real browser sees that; a policy-string unit test pins the fix but would never have found
 * the defect. `image/*` previews go through `<img>` and were unaffected, which is why nobody noticed.
 */
export const READ_PDF = { filename: 'quarterly-report.pdf', text: 'Waxwing preview probe' }

/** 1-page PDF, hand-assembled so the xref offsets are right. Rendered by the browser's viewer. */
function pdfBytes() {
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R' +
      '/Resources<</Font<</F1 5 0 R>>>>>>endobj\n',
    `4 0 obj<</Length 63>>stream\nBT /F1 12 Tf 20 50 Td (${READ_PDF.text}) Tj ET\nendstream endobj\n`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (const object of objects) {
    offsets.push(pdf.length)
    pdf += object
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return pdf
}

/** The carrier message whose attachment is that PDF. */
function pdfCreation(inboxId, receivedAt, blobId) {
  return {
    mailboxIds: { [inboxId]: true },
    keywords: { [READ_KEYWORD]: true, $seen: true },
    receivedAt,
    messageId: ['pdf-report@waxwing.test'],
    from: [{ name: 'Bob Baker', email: bob() }],
    to: [{ name: 'Alice Anderson', email: alice() }],
    subject: READ_SUBJECTS.pdf,
    textBody: [{ partId: 't', type: 'text/plain' }],
    bodyValues: { t: { value: 'The quarterly report is attached.' } },
    attachments: [
      { blobId, type: 'application/pdf', name: READ_PDF.filename, disposition: 'attachment' },
    ],
  }
}

/** Subject/body of the inner message carried as a `message/rfc822` attachment (FR-RD-07). */
export const READ_NESTED = {
  subject: 'Quarterly figures Q2',
  body: 'The Q2 figures are attached to the original message. — Carol',
  from: 'carol@waxwing.test',
  filename: 'original.eml',
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

/**
 * `fetch` with a bounded retry on 429.
 *
 * This seeder runs before EVERY test in the read suite — thirty-odd reseeds per run, each one a
 * session fetch, three blob uploads, an `Email/set` and an `Email/import`. Stalwart applies its
 * default request throttle to all of it, and on a slow two-core CI runner the burst crosses it:
 * the suite then fails with `HTTP 429` from the FIXTURE, which looks exactly like a product defect
 * in the report and is not one.
 *
 * Retrying rather than raising the server's limit is deliberate. The limit is Stalwart's real
 * behaviour, an app that trips it has to cope, and a fixture configured to be more permissive than
 * production would hide precisely the class of bug worth finding. What the seeder needs is not more
 * headroom but patience: it is scaffolding, not the thing under test.
 */
async function fetchThrottled(url, init, attempt = 0) {
  const res = await fetch(url, init)
  if (res.status !== 429 || attempt >= 5) return res
  // Honour `Retry-After` when it is sent; otherwise back off 250ms, 500ms, 1s, 2s, 4s.
  const header = Number.parseInt(res.headers.get('retry-after') ?? '', 10)
  const waitMs = Number.isFinite(header) ? header * 1000 : 250 * 2 ** attempt
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  return fetchThrottled(url, init, attempt + 1)
}

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

/** Upload raw bytes and return the blobId (the `.eml` and nested-message vectors). */
async function uploadBlob(accountId, contentType, body) {
  const res = await fetchThrottled(`${BASE_URL}/jmap/upload/${accountId}/`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': contentType },
    body,
  })
  if (!res.ok) throw new Error(`blob upload failed: HTTP ${res.status} — ${await res.text()}`)
  return (await res.json()).blobId
}

/**
 * The phishing message as RAW RFC 5322. It must be IMPORTED, not created via `Email/set`: only a
 * raw blob can carry two `Authentication-Results` headers, and `Email/set`'s `header:X:asText` form
 * RFC-2047-encodes the value on write (verified against the fixture), which a real MTA never does.
 */
function phishingRaw(receivedAt) {
  const P = READ_PHISHING
  const html = [
    '<html><body>',
    '<p>Dear customer, your account needs verification.</p>',
    `<p><a href="${P.linkTarget}">${P.linkText}</a></p>`,
    `<p>See also <a href="${P.benignTarget}">${P.benignText}</a>.</p>`,
    '</body></html>',
  ].join('\n')
  return [
    // TOPMOST = the trusted position (what our MTA would prepend). It FAILS.
    `Authentication-Results: ${P.trustedAuthserv}; spf=fail smtp.mailfrom=${P.realAddress}; dkim=fail; dmarc=fail header.from=bank.test`,
    // BELOW = travelled with the message. The attacker wrote this one himself. It "passes".
    `Authentication-Results: ${P.forgedAuthserv}; spf=pass smtp.mailfrom=${P.displayName}; dkim=pass header.d=bank.test; dmarc=pass header.from=bank.test`,
    'Message-ID: <phish-1@evil.tld>',
    `From: "${P.displayName}" <${P.realAddress}>`,
    'To: "Alice Anderson" <alice@waxwing.test>',
    `Subject: ${READ_SUBJECTS.phishing}`,
    `Date: ${new Date(receivedAt).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '',
  ].join('\r\n')
}

/** The inner RFC 5322 message that rides along as a `message/rfc822` attachment (FR-RD-07). */
function nestedRaw() {
  return [
    'Message-ID: <nested-q2@waxwing.test>',
    `From: "Carol Chen" <${READ_NESTED.from}>`,
    'To: "Bob Baker" <bob@waxwing.test>',
    `Subject: ${READ_NESTED.subject}`,
    'Date: Mon, 13 Jul 2026 09:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    READ_NESTED.body,
    '',
  ].join('\r\n')
}

/** The carrier message whose only attachment is the nested `message/rfc822` blob (FR-RD-07). */
function rfc822Creation(inboxId, receivedAt, innerBlobId) {
  return {
    mailboxIds: { [inboxId]: true },
    keywords: { [READ_KEYWORD]: true, $seen: true },
    receivedAt,
    messageId: ['fwd-quarterly@waxwing.test'],
    from: [{ name: 'Bob Baker', email: bob() }],
    to: [{ name: 'Alice Anderson', email: alice() }],
    subject: READ_SUBJECTS.rfc822,
    textBody: [{ partId: 't', type: 'text/plain' }],
    bodyValues: { t: { value: 'Forwarding the original message as an attachment.' } },
    attachments: [
      {
        blobId: innerBlobId,
        type: 'message/rfc822',
        name: READ_NESTED.filename,
        disposition: 'attachment',
      },
    ],
  }
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
    messageId: ['newsletter-42@waxwing.test'],
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
    messageId: ['lunch-thursday@waxwing.test'],
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

  // BARE message-ids — no angle brackets. RFC 8621 §4.1.2: `messageId` is the Message-ID header
  // value "with the surrounding angle brackets removed"; the server adds them back on the wire.
  // Passing `<id>` here yielded a literal `Message-ID: <<q3-1@waxwing.test>>` in the raw message
  // (proven against the fixture in M3.9). Threading survived it, so nothing caught it until the
  // header-details view started SHOWING the message-id. `seed-write.mjs:172` had it right all along.
  const q1 = 'q3-1@waxwing.test'
  const q2 = 'q3-2@waxwing.test'
  const q3 = 'q3-3@waxwing.test'

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
    rfc822: rfc822Creation(
      inboxId,
      at(5),
      await uploadBlob(accountId, 'message/rfc822', nestedRaw()),
    ),
    pdf: pdfCreation(inboxId, at(7), await uploadBlob(accountId, 'application/pdf', pdfBytes())),
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

  // The phishing message goes in via Email/import — see phishingRaw() for why Email/set cannot
  // express it. `keywords` here is what makes destroyExisting() find it on the next reseed.
  const phishBlob = await uploadBlob(accountId, 'message/rfc822', phishingRaw(at(6)))
  const imported = await jmap([
    [
      'Email/import',
      {
        accountId,
        emails: {
          phish: {
            blobId: phishBlob,
            mailboxIds: { [inboxId]: true },
            keywords: { [READ_KEYWORD]: true },
            receivedAt: at(6),
          },
        },
      },
      '0',
    ],
  ])
  const importResult = imported.methodResponses[0][1]
  if (importResult?.created?.phish === undefined) {
    throw new Error(
      `phishing import failed: ${JSON.stringify(importResult?.notCreated ?? imported.methodResponses[0])}`,
    )
  }

  return { accountId, inboxId, removed, created: created + 1 }
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
