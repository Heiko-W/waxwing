// Waxwing M1.6 large-mailbox seeder (dependency-free, Node >= 22 builtins only).
//
// Fills a dedicated "Large" mailbox on alice's account with N deterministic messages (default
// 100 000) so the M1.9 read E2E + M4.8 perf pass can measure the virtualized message list
// (FR-LST-01: sustained 60 fps with 100 k+ messages) and select-all/bulk-move over a big folder.
//
// IDEMPOTENT: every seeded mail carries the `wlarge` keyword; a reseed destroys the previous
// `wlarge` batch first (paged), so re-running yields the same folder. Talks to the container
// DIRECTLY at BASE_URL (127.0.0.1:18080), never the advertised session URLs.
//
// Usage:  node e2e/stalwart/seed-large.mjs [count]      (needs `pnpm e2e:server` up)

import { BASE_URL, DOMAIN, PASSWORD } from './fixture.mjs'

const CORE = 'urn:ietf:params:jmap:core'
const MAIL = 'urn:ietf:params:jmap:mail'

/** Marks seeded mail so a reseed can find and remove the previous batch. */
export const LARGE_KEYWORD = 'wlarge'
export const LARGE_MAILBOX_NAME = 'Large'

/** Conservative chunk under Stalwart's maxObjectsInSet (500, per SP.5). */
const CHUNK = 500

/**
 * Spacing between consecutive messages, and the reason this seeder is not free to choose it.
 *
 * The app syncs a RECENT WINDOW, not a whole mailbox: `backfill.ts` queries
 * `inMailbox AND receivedAt >= now − offline.cacheDays` (default 30 days). A corpus spread wider
 * than that window is invisible to the client no matter how large it is.
 *
 * This bit, measured: at the original one-minute spacing, 100 000 messages spanned 69 days from a
 * HARDCODED base of 2026-07-01 — so every single one fell outside the window, `Email/query` returned
 * `total: 0`, and the perf suite reported an empty folder while the server happily answered 100 000
 * to the same question. Test data with a pinned timestamp has an expiry date.
 *
 * 20 s × 100 000 = 23 days, comfortably inside a 30-day window with room for a slower default.
 */
const SPACING_MS = 20_000

const alice = () => `alice@${DOMAIN}`
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

async function findOrCreateMailbox(accountId, name) {
  const got = await jmap([
    ['Mailbox/get', { accountId, ids: null, properties: ['id', 'name'] }, '0'],
  ])
  const existing = got.methodResponses[0][1].list.find((mailbox) => mailbox.name === name)
  if (existing) return existing.id
  const created = await jmap([
    ['Mailbox/set', { accountId, create: { m: { name, parentId: null } } }, '0'],
  ])
  const id = created.methodResponses[0][1].created?.m?.id
  if (!id)
    throw new Error(
      `could not create mailbox "${name}": ${JSON.stringify(created.methodResponses[0][1])}`,
    )
  return id
}

/** Destroy every `wlarge` mail in the mailbox, paged 500 at a time. Returns the count removed. */
async function destroyExisting(accountId, mailboxId) {
  let removed = 0
  for (;;) {
    const queried = await jmap([
      [
        'Email/query',
        { accountId, filter: { inMailbox: mailboxId, hasKeyword: LARGE_KEYWORD }, limit: CHUNK },
        '0',
      ],
    ])
    const ids = queried.methodResponses[0][1].ids ?? []
    if (ids.length === 0) return removed
    await jmap([['Email/set', { accountId, destroy: ids }, '0']])
    removed += ids.length
  }
}

/**
 * One deterministic email creation object. Newest-first: `receivedAt` decreases by
 * {@link SPACING_MS} per index.
 */
function creation(mailboxId, index, baseMs) {
  const sender = ['bob', 'carol', 'dave'][index % 3]
  const keywords = { [LARGE_KEYWORD]: true }
  if (index % 3 === 0) keywords.$seen = true
  if (index % 11 === 0) keywords.$flagged = true
  const receivedAt = `${new Date(baseMs - index * SPACING_MS).toISOString().slice(0, 19)}Z`
  return {
    mailboxIds: { [mailboxId]: true },
    keywords,
    receivedAt,
    from: [
      { name: `${sender[0].toUpperCase()}${sender.slice(1)} Sender`, email: `${sender}@${DOMAIN}` },
    ],
    to: [{ name: 'Alice Anderson', email: alice() }],
    subject: `Large mailbox — message ${index}`,
    textBody: [{ partId: 't', type: 'text/plain' }],
    bodyValues: {
      t: { value: `Message number ${index} in the 100k-message performance fixture.` },
    },
  }
}

export async function seedLargeMailbox(count = 100_000) {
  const session = await getSession()
  const accountId = session.primaryAccounts[MAIL]
  const mailboxId = await findOrCreateMailbox(accountId, LARGE_MAILBOX_NAME)
  const removed = await destroyExisting(accountId, mailboxId)

  // Midnight TODAY, not a pinned date: deterministic across reseeds within a day (so the corpus is
  // stable while a suite runs) without going stale the way a hardcoded timestamp does — see
  // SPACING_MS for what that cost the first time.
  const baseMs = new Date(new Date().toISOString().slice(0, 10)).getTime()
  let created = 0
  for (let start = 0; start < count; start += CHUNK) {
    const create = {}
    for (let i = start; i < Math.min(start + CHUNK, count); i += 1) {
      create[`m${i}`] = creation(mailboxId, i, baseMs)
    }
    const response = await jmap([['Email/set', { accountId, create }, '0']])
    const result = response.methodResponses[0][1]
    created += Object.keys(result.created ?? {}).length
    const notCreated = Object.keys(result.notCreated ?? {}).length
    if (notCreated > 0) {
      throw new Error(
        `chunk at ${start}: ${notCreated} notCreated — ${JSON.stringify(result.notCreated)}`,
      )
    }
    if (start % (CHUNK * 20) === 0) {
      process.stdout.write(`[seed-large] ${created}/${count}\r`)
    }
  }
  return { accountId, mailboxId, removed, created }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = process.argv[2] ? Number.parseInt(process.argv[2], 10) : 100_000
  seedLargeMailbox(count)
    .then((summary) => {
      console.log(
        `\n[seed-large] mailbox ${summary.mailboxId} ("${LARGE_MAILBOX_NAME}"): removed ${summary.removed}, created ${summary.created}`,
      )
    })
    .catch((error) => {
      console.error('[seed-large] failed:', error.message)
      process.exit(1)
    })
}
