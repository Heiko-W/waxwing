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
  setActiveEngine(null)
  await db.delete()
})

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
    await putEmails(db, 'a', [
      email('e1', { threadId: 't1', keywords: {} }),
      email('e2', { threadId: 't1', keywords: {} }),
    ])
    renderConversation('e1')
    await waitFor(
      () =>
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ keyword: '$seen', value: true, emailIds: ['e1'] }),
          expect.anything(),
        ),
      { timeout: 3000 },
    )
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ keyword: '$seen', value: true, emailIds: ['e2'] }),
      expect.anything(),
    )
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
