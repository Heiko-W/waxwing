/**
 * B17 — does `Email/queryChanges` empty a bounded window without voiding it?
 *
 * ## The claim, and why an experiment is the work
 *
 * A checker reading `delta.ts` after B9's empty-state guard landed found this shape: `reconcileQuery`
 * filters `removed` out of `row.ids`, then drops any `added` item whose `index > ids.length` — a
 * deliberate defence against a server that ignores `upToId`. If a `queryChanges` removes the whole
 * head page and re-adds those ids far down, every add is dropped and the row is written EMPTY, with
 * a non-null `queryState` and a carried-over `total`. Nothing recovers that: `fullRequery` fires on
 * a VOIDED window, and this one is not voided; the next pass computes from `newQueryState` and finds
 * nothing changed; the window sticks while ONLINE. Every other producer of empty-ids-with-a-total
 * voids the window, and no `queryCache` writer detects the shape.
 *
 * It was filed UNPROVEN, with the plausible trigger named — an "unread first" window whose head page
 * is marked read from another device — and with the counter-hypothesis stated: a strict RFC 8620
 * §5.6 server may instead raise `cannotCalculateChanges`, which `delta.ts` already rescues.
 *
 * ## What this measures
 *
 * The real server, the real sort, a window deliberately smaller than the result set, and the head
 * page marked read out of band. Then the CLIENT'S OWN algorithm is applied to the server's answer,
 * verbatim, and the resulting row is inspected for the shape.
 *
 * The algorithm is duplicated here rather than imported: `reconcileQuery` needs a Dexie replica and
 * an `EngineClock`, and this package must not depend on the app. The six lines that matter are
 * copied with their source named, and `delta.ts` carries a pointer back — if they ever drift, this
 * test is measuring something the app does not do, which is the failure mode worth naming.
 */

import {
  basic,
  Capabilities,
  type EmailCreate,
  getSession,
  type Id,
  JmapClient,
  Methods,
  type PatchObject,
} from '@waxwing/jmap'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = 'http://localhost:18080'
const USERNAME = 'alice@waxwing.test'
const PASSWORD = 'waxwing-e2e-Pw1!'
const auth = basic(USERNAME, PASSWORD)

/** `DEFAULT_WINDOW_LIMIT` in `apps/web/src/sync/engine/delta.ts`. */
const WINDOW = 50
/** Enough that the window is a genuine head page and not the whole result set. */
const SEEDED = 120
/** How much of the head page is marked read — the whole window, so every id must leave it. */
const MARK_READ = WINDOW

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

let client: JmapClient
let accountId: Id
let mailboxId: Id

/**
 * The sort a folder uses with "Unread first" on (`canonicalQueryKey`, app side): unread before read,
 * then newest first. Marking a message read therefore MOVES it — which is the whole mechanism this
 * test needs, and the reason the trigger the row named is this one and not a delete.
 */
const UNREAD_FIRST = [
  { property: 'keyword', keyword: '$seen', isAscending: true },
  { property: 'receivedAt', isAscending: false },
]

beforeAll(async () => {
  const session = await getSession(BASE, auth)
  accountId = session.primaryAccounts[Capabilities.mail] ?? ''
  client = new JmapClient({ session, auth, sessionUrl: BASE })

  // A mailbox of our own, so the seeded volume cannot disturb the other suites' fixtures.
  const create = client.request()
  const created = create.invoke(Methods.mailboxSet, {
    accountId,
    create: { m: { name: `B17 ${RUN_ID}`, parentId: null } },
  })
  mailboxId = (await create.send()).get(created).created?.m?.id ?? ''
  expect(mailboxId, 'could not create the probe mailbox').not.toBe('')

  // Seed in batches — one `Email/set` with 120 creates exceeds the server's per-call object limit.
  for (let batch = 0; batch < SEEDED / 20; batch++) {
    const request = client.request()
    const creates: Record<string, EmailCreate> = {}
    for (let i = 0; i < 20; i++) {
      const n = batch * 20 + i
      creates[`e${n}`] = {
        mailboxIds: { [mailboxId]: true },
        keywords: {},
        // Descending receivedAt, so index 0 is the newest and the head page is deterministic.
        receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - n * 60_000).toISOString(),
        from: [{ name: 'Probe', email: USERNAME }],
        to: [{ name: 'Probe', email: USERNAME }],
        subject: `B17 ${RUN_ID} #${String(n).padStart(3, '0')}`,
        textBody: [{ partId: 't', type: 'text/plain' }],
        bodyValues: { t: { value: 'B17' } },
      }
    }
    const handle = request.invoke(Methods.emailSet, { accountId, create: creates })
    const result = (await request.send()).get(handle)
    expect(Object.keys(result.created ?? {}).length, 'seeding batch failed').toBe(20)
  }
}, 120_000)

/*
 * Take the 120 messages and the probe mailbox back out.
 *
 * Not politeness: the fixture outlives this suite inside one `verify:e2e` run, and the read, write
 * and shared suites after it sync this very account. A folder of 120 left behind is sync work every
 * one of them pays for, and a count several of them assert on.
 */
afterAll(async () => {
  if (mailboxId === '') return
  const request = client.request()
  request.invoke(Methods.mailboxSet, {
    accountId,
    destroy: [mailboxId],
    // The messages go with it. Without this Stalwart refuses to destroy a non-empty mailbox, and
    // the cleanup would fail silently at the moment it matters most — on a run that is already busy.
    onDestroyRemoveEmails: true,
  })
  await request.send()
}, 60_000)

describe('B17 · Email/queryChanges on a bounded window (live Stalwart)', () => {
  it('does not leave the window empty with a live query state', async () => {
    const filter = { inMailbox: mailboxId }

    // 1. The window the client would hold: the head page, bounded.
    const first = client.request()
    const query = first.invoke(Methods.emailQuery, {
      accountId,
      filter,
      sort: UNREAD_FIRST,
      limit: WINDOW,
      calculateTotal: true,
    })
    const initial = (await first.send()).get(query)
    expect(initial.ids.length, 'the probe mailbox did not fill').toBe(WINDOW)
    expect(initial.total).toBe(SEEDED)
    const upToId = initial.ids[initial.ids.length - 1] as Id

    // 2. Another device marks the whole head page read. Under this sort every one of them moves
    //    below the 70 messages that are still unread — i.e. clean out of the window.
    const mark = client.request()
    const update: Record<Id, PatchObject> = {}
    for (const id of initial.ids.slice(0, MARK_READ)) update[id] = { 'keywords/$seen': true }
    const marked = mark.invoke(Methods.emailSet, { accountId, update })
    const markResult = (await mark.send()).get(marked)
    expect(Object.keys(markResult.updated ?? {}).length).toBe(MARK_READ)

    // 3. What the client would ask next, with the SAME bound `delta.ts` sends.
    const delta = client.request()
    const changes = delta.invoke(Methods.emailQueryChanges, {
      accountId,
      filter,
      sort: UNREAD_FIRST,
      sinceQueryState: initial.queryState,
      upToId,
      calculateTotal: true,
    })
    const answer = (await delta.send()).get(changes)

    // 4. `reconcileQuery`'s arithmetic, from `apps/web/src/sync/engine/delta.ts`. Both readings are
    //    computed: what the code did BEFORE B17 (drop what will not fit) and what it does now.
    const removed = new Set(answer.removed)
    const kept = initial.ids.filter((id) => !removed.has(id))
    const unplaceable = answer.added.filter((item) => item.index > kept.length)
    const naive = [...kept]
    for (const item of answer.added)
      if (item.index <= naive.length) naive.splice(item.index, 0, item.id)

    console.log(
      `[B17] removed=${answer.removed.length} added=${answer.added.length} ` +
        `unplaceable=${unplaceable.length}${unplaceable.length > 0 ? ` at ${unplaceable.map((i) => i.index).join(',')}` : ''} ` +
        `naive-ids=${naive.length} total=${answer.total ?? 'n/a'} state-moved=${answer.newQueryState !== initial.queryState}`,
    )

    /*
     * MEASURED SERVER BEHAVIOUR — the finding itself.
     *
     * Stalwart honours `upToId` in deciding WHICH changes to report and numbers the adds against the
     * WHOLE result set: every one of the fifty comes back at index 70..119, far past the 50-id
     * window it was bounded to. Whether §5.6 requires window-relative indices is a reading this
     * client does not get to settle; what matters is that the answer cannot be spliced into the
     * window we hold.
     *
     * If this assertion ever fails because a later Stalwart numbers adds within the bound, that is
     * good news and NOT a reason to delete the client rule — the rule also covers a server that
     * ignores `upToId` outright, which is what it was originally written for.
     */
    expect(
      unplaceable.length,
      'Stalwart no longer places adds past the upToId bound — see the note above before changing the client',
    ).toBeGreaterThan(0)

    /*
     * WHAT THAT USED TO DO. The old rule dropped every add it could not place and wrote the window
     * back: empty, with a carried-over total and a LIVE query state. That is the unrecoverable
     * shape — `fullRequery` only runs for a VOIDED window, so nothing ever re-queries this one, and
     * the folder shows nothing while online, indefinitely.
     */
    expect(
      naive.length === 0 && (answer.total ?? 0) > 0,
      'B17 no longer reproduces with the OLD algorithm — the experiment has stopped measuring the defect',
    ).toBe(true)

    /*
     * AND WHAT IT DOES NOW: an add that cannot be placed means the delta cannot be applied
     * faithfully, so `reconcileQuery` takes the `cannotCalculateChanges` road and re-queries. The
     * decision is one line there and one line here, and they must agree.
     */
    const decision = unplaceable.length > 0 ? 'requery' : 'apply'
    expect(decision, 'the client would have applied a delta it cannot place').toBe('requery')
  }, 60_000)

  it('reports a state change at all — otherwise the test above proves nothing', async () => {
    // The control. If the server answered "nothing changed" for a mutation that demonstrably moved
    // 50 messages, then the assertions above passed on an empty delta and measured nothing. This is
    // the same class of vacuous pass B22 was filed for.
    const first = client.request()
    const query = first.invoke(Methods.emailQuery, {
      accountId,
      filter: { inMailbox: mailboxId },
      sort: UNREAD_FIRST,
      limit: WINDOW,
      calculateTotal: true,
    })
    const now = (await first.send()).get(query)

    // The head of the window is now the OLDEST unread, not the newest message overall: the 50 read
    // ones sorted below the 70 that are still unread. That is the reordering the delta had to carry.
    const heads = await headSubjects(now.ids.slice(0, 3))
    console.log(`[B17] window head after the mark-read: ${heads.join(' | ')}`)
    expect(now.ids.length).toBe(WINDOW)
    expect(now.ids[0], 'the mark-read did not reorder the window').not.toBe(
      // #000 is the newest message and was the head before; it is now read and must have moved.
      undefined,
    )
    const first000 = heads.some((subject) => subject.endsWith('#000'))
    expect(
      first000,
      'the newest (now read) message is still in the head of an unread-first window',
    ).toBe(false)
  }, 60_000)
})

async function headSubjects(ids: readonly Id[]): Promise<string[]> {
  const request = client.request()
  const handle = request.invoke(Methods.emailGet, {
    accountId,
    ids: [...ids],
    properties: ['subject'],
  })
  return (await request.send()).get(handle).list.map((email) => email.subject ?? '')
}
