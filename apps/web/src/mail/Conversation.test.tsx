import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EmailBodyPart, EmailBodyValue } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import { SessionContext } from '../app/session/context'
import type { SessionContextValue } from '../app/session/types'
import {
  type EmailBodyRow,
  putEmailBody,
  putEmails,
  putMailboxes,
  putThreads,
  type ReplicaDb,
  ReplicaProvider,
} from '../sync'
import { setActiveEngine } from '../sync/engine'
import { email, freshDb, mailbox, thread } from '../sync/test-utils'
import { ToastProvider } from '../ui'
import { Conversation } from './Conversation'
import { AUTO_MARK_READ_DELAY_MS } from './MessageView'

function part(over: Partial<EmailBodyPart> = {}): EmailBodyPart {
  return {
    partId: 't1',
    blobId: null,
    size: 0,
    headers: [],
    name: null,
    type: 'text/plain',
    charset: null,
    disposition: null,
    cid: null,
    language: null,
    location: null,
    subParts: null,
    ...over,
  }
}
const val = (v: string): EmailBodyValue => ({
  value: v,
  isEncodingProblem: false,
  isTruncated: false,
})

function bodyRow(id: string): EmailBodyRow & { authResults: string[] } {
  return {
    accountId: 'a',
    id,
    bodyValues: { t1: val(`body of ${id}`) },
    bodyStructure: part(),
    textBody: [part()],
    htmlBody: [part()],
    attachments: [],
    hasAttachment: false,
    authResults: [],
    fetchedAt: 1,
    lastAccessedAt: 1,
    bytes: 0,
    ablob: [],
  }
}

const session = { getClient: () => null } as unknown as SessionContextValue
const dispatch = vi.fn()
const fetchEnvelopes = vi.fn(async () => {})
let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  fetchEnvelopes.mockReset()
  setActiveEngine({
    dispatch,
    fetchBody: vi.fn(async () => {}),
    fetchEnvelopes,
  } as unknown as Parameters<typeof setActiveEngine>[0])
  await putMailboxes(db, 'a', [mailbox('inbox', { role: 'inbox' })])
  await putThreads(db, 'a', [thread('t1', ['e1', 'e2'])])
  await putEmails(db, 'a', [
    email('e1', {
      threadId: 't1',
      from: [{ name: 'Alice', email: 'a@x.test' }],
      preview: 'first preview',
      subject: 'Group chat',
      keywords: { $seen: true },
    }),
    email('e2', {
      threadId: 't1',
      from: [{ name: 'Bob', email: 'b@x.test' }],
      preview: 'second preview',
      subject: 'Group chat',
      keywords: { $seen: true },
    }),
  ])
  await putEmailBody(db, bodyRow('e1'))
  await putEmailBody(db, bodyRow('e2'))
})

afterEach(async () => {
  // Real timers FIRST: `db.delete()` is a Dexie round-trip, and fake-indexeddb does not complete
  // one while the clock is faked and nobody is advancing it.
  vi.useRealTimers()
  setActiveEngine(null)
  await db.delete()
})

/**
 * The ids of every "$seen = true" intent dispatched so far, in order — i.e. every message something
 * has decided to mark READ. Asserting on the whole list rather than with a pair of
 * `toHaveBeenCalledWith` / `not.toHaveBeenCalledWith` checks is deliberate: it names the offending
 * sibling in the failure message instead of just reporting that an absence assertion tripped.
 */
interface KeywordIntent {
  readonly kind: string
  readonly keyword?: string
  readonly value?: boolean
  readonly emailIds: readonly string[]
}

function markedReadIds(): string[] {
  return dispatch.mock.calls
    .map((call) => call[0] as KeywordIntent)
    .filter((intent) => intent.kind === 'setKeywords' && intent.keyword === '$seen')
    .filter((intent) => intent.value === true)
    .flatMap((intent) => [...intent.emailIds])
}

/**
 * Step the FAKE clock until `predicate` holds. The replica's liveQueries settle on faked timers
 * (`advanceTimersByTimeAsync` flushes microtasks between ticks), so a barrier can be a state the
 * test DRIVES the app into rather than one it hopes has arrived by some wall-clock deadline.
 *
 * `waitFor` cannot serve here: with the clock faked it never resolves in this file's setup, and
 * with the clock real it cannot promise that a pending dwell has fired — which is the only thing
 * an "and this other message was NOT marked read" assertion can be built on.
 *
 * Throws rather than falling through when the predicate never holds: a barrier that quietly gives
 * up hands every assertion after it to chance, which is precisely the failure being fixed here.
 */
async function advanceUntil(what: string, predicate: () => boolean, stepMs = 10): Promise<void> {
  for (let step = 0; step < 500; step++) {
    if (predicate()) return
    await vi.advanceTimersByTimeAsync(stepMs)
  }
  throw new Error(`barrier never held: ${what}`)
}

function renderConversation(emailId: string) {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <SessionContext.Provider value={session}>
          <ToastProvider>
            <ReplicaProvider accountId="a" db={db}>
              <Conversation emailId={emailId} mailboxId="inbox" />
            </ReplicaProvider>
          </ToastProvider>
        </SessionContext.Provider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

describe('Conversation', () => {
  it('expands the opened/newest message and collapses the rest', async () => {
    renderConversation('e2')
    // Subject heading + thread count.
    expect(await screen.findByRole('heading', { name: 'Group chat' })).toBeInTheDocument()
    expect(await screen.findByText('2 messages in this conversation')).toBeInTheDocument()
    // The older message is collapsed (its preview is shown as a button).
    expect(await screen.findByText('first preview')).toBeInTheDocument()
    // Exactly one expanded message → one action toolbar.
    await waitFor(() =>
      expect(screen.getAllByRole('toolbar', { name: 'Message actions' })).toHaveLength(1),
    )
  })

  it('expands a collapsed message on demand', async () => {
    const user = userEvent.setup()
    renderConversation('e2')
    await user.click(await screen.findByText('first preview'))
    await waitFor(() =>
      expect(screen.getAllByRole('toolbar', { name: 'Message actions' })).toHaveLength(2),
    )
  })

  it('collapses an expanded thread message again via its collapse control', async () => {
    const user = userEvent.setup()
    renderConversation('e2')
    // Expand the older e1 → two messages open.
    await user.click(await screen.findByText('first preview'))
    await waitFor(() =>
      expect(screen.getAllByRole('toolbar', { name: 'Message actions' })).toHaveLength(2),
    )
    // The disclosure is reversible: collapsing e1 (first in stored order) returns it to a preview.
    const collapse = screen.getAllByRole('button', { name: 'Collapse message' })
    await user.click(collapse[0] as HTMLElement)
    await waitFor(() =>
      expect(screen.getAllByRole('toolbar', { name: 'Message actions' })).toHaveLength(1),
    )
    expect(screen.getByText('first preview')).toBeInTheDocument()
  })

  it('auto-marks only the opened message read, never the auto-expanded newest', async () => {
    // Both unread; open the OLDER e1. e1 (opened) is marked read after the dwell; e2 (newest,
    // auto-expanded for reading) must NOT be — opening one message never marks a sibling read.
    //
    // The BARRIER is the whole test, and getting it wrong is why this assertion was decorative
    // until now. "e2 was not marked read" is an assertion of ABSENCE, and an absence asserted under
    // a barrier that does not cover the thing it denies proves nothing — the recurring hazard §13
    // B10 tracks (it has bitten M3.8's chord suite and G2's swipe-reveal race already; this is the
    // third). The obvious barrier — wait until e1's own dispatch lands — is exactly that mistake:
    // `Conversation` starts with only the OPENED id expanded and merges the thread's newest in an
    // effect, so e2 mounts a commit later, arms its dwell later, and is still pending at the
    // instant e1's fires. Under that barrier `!autoMark` could be deleted from MessageView's dwell
    // guard and all 79 tests stayed green.
    //
    // So the barrier is "both messages are MOUNTED" (two action toolbars = e2's dwell is armed, if
    // it arms at all), and only then is the clock driven past both dwells. Fake timers, not a
    // wall-clock `waitFor`: the point is to reach a state where every timer that was ever going to
    // fire has fired, which no timeout can promise.
    await putEmails(db, 'a', [
      email('e1', { threadId: 't1', keywords: {} }),
      email('e2', { threadId: 't1', keywords: {} }),
    ])
    // After the async seeding above — fake-indexeddb stalls if the clock is faked during it.
    vi.useFakeTimers()
    renderConversation('e1')
    await advanceUntil(
      'both thread messages are expanded',
      () => screen.queryAllByRole('toolbar', { name: 'Message actions' }).length === 2,
    )
    // Both dwells are now armed (if e2 arms one at all). Four dwell lengths is far past both.
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS * 4)
    // Exactly one message read, and it is the one the reader opened.
    expect(markedReadIds()).toEqual(['e1'])
  })

  it('hydrates a thread member whose envelope the replica is missing', async () => {
    // Thread t1 = [e1, e2] but only e1 is present (collapsed-threads backfill stored the anchor
    // only); opening e1 must request the missing e2 rather than leave it a permanent skeleton.
    await db.emails.delete(['a', 'e2'])
    renderConversation('e1')
    await waitFor(() =>
      expect(fetchEnvelopes).toHaveBeenCalledWith(expect.arrayContaining(['e1', 'e2'])),
    )
  })
})
