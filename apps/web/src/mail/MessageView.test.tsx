import { render, screen, waitFor, within } from '@testing-library/react'
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
  type EmailRow,
  putEmailBody,
  putMailboxes,
  type ReplicaDb,
  ReplicaProvider,
  toEmailRow,
} from '../sync'
import { setActiveEngine } from '../sync/engine'
import { email, freshDb, mailbox } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { AUTO_MARK_READ_DELAY_MS, MessageView } from './MessageView'

function part(over: Partial<EmailBodyPart> = {}): EmailBodyPart {
  return {
    partId: null,
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

function textBodyRow(id: string, text: string): EmailBodyRow {
  return {
    accountId: 'a',
    id,
    bodyValues: { t1: val(text) },
    bodyStructure: part({ partId: 't1' }),
    textBody: [part({ partId: 't1', type: 'text/plain' })],
    htmlBody: [part({ partId: 't1', type: 'text/plain' })],
    attachments: [],
    hasAttachment: false,
    fetchedAt: 1,
    lastAccessedAt: 1,
  }
}

function htmlRemoteRow(id: string): EmailBodyRow {
  const html = '<p>Hi</p><img src="https://track.test/pixel.png" alt="x">'
  return {
    accountId: 'a',
    id,
    bodyValues: { h1: val(html) },
    bodyStructure: part({ partId: 'h1', type: 'text/html' }),
    textBody: [],
    htmlBody: [part({ partId: 'h1', type: 'text/html' })],
    attachments: [],
    hasAttachment: false,
    fetchedAt: 1,
    lastAccessedAt: 1,
  }
}

const session = { getClient: () => null } as unknown as SessionContextValue
const dispatch = vi.fn()
let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  setActiveEngine({
    dispatch,
    fetchBody: vi.fn(async () => {}),
  } as unknown as Parameters<typeof setActiveEngine>[0])
  await putMailboxes(db, 'a', [
    mailbox('inbox', { role: 'inbox' }),
    mailbox('archive', { role: 'archive' }),
    mailbox('junk', { role: 'junk' }),
    mailbox('trash', { role: 'trash' }),
  ])
})

afterEach(async () => {
  vi.useRealTimers()
  setActiveEngine(null)
  await db.delete()
})

function seen(over: Parameters<typeof email>[1] = {}): EmailRow {
  return toEmailRow('a', email('e1', { keywords: { $seen: true }, ...over }))
}

function renderView(row: EmailRow, mailboxId: string | undefined = 'inbox') {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <SessionContext.Provider value={session}>
          <ToastProvider>
            <ReplicaProvider accountId="a" db={db}>
              <MessageView email={row} mailboxId={mailboxId} />
            </ReplicaProvider>
          </ToastProvider>
        </SessionContext.Provider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

describe('MessageView', () => {
  it('renders the sender and subject in the header', async () => {
    await putEmailBody(db, textBodyRow('e1', 'hello world'))
    renderView(seen({ from: [{ name: 'Alice', email: 'alice@x.test' }], subject: 'Hello' }))
    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Hello' })).toBeInTheDocument()
  })

  it('archives by dispatching a move to the archive mailbox', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen(), 'inbox')
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' }),
      expect.anything(),
    )
  })

  it('marks unread by dispatching a $seen=false keyword change', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await user.click(screen.getByRole('button', { name: 'Mark as unread' }))
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'setKeywords',
        keyword: '$seen',
        value: false,
        emailIds: ['e1'],
      }),
      expect.anything(),
    )
  })

  it('confirms before permanently deleting a message in Trash', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen(), 'trash')
    // A single click on Delete opens a confirmation — it must NOT destroy immediately.
    // (findBy: the Trash button only becomes "Delete" once the trash mailbox liveQuery resolves.)
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(dispatch).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: 'Delete' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'destroyEmails', emailIds: ['e1'] }),
      expect.anything(),
    )
  })

  it('shows the remote-content banner and hides it after Load images', async () => {
    await putEmailBody(db, htmlRemoteRow('e1'))
    const user = userEvent.setup()
    renderView(seen({ subject: 'Newsletter' }))
    expect(await screen.findByText('Remote content blocked')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Load images' }))
    await waitFor(() =>
      expect(screen.queryByText('Remote content blocked')).not.toBeInTheDocument(),
    )
  })

  it('auto-marks the message read after the dwell delay', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    // Enable fake timers only AFTER async DB seeding — fake-indexeddb stalls on faked timers.
    vi.useFakeTimers()
    renderView(toEmailRow('a', email('e1', { keywords: {} }))) // unread
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'setKeywords',
        keyword: '$seen',
        value: true,
        emailIds: ['e1'],
      }),
      expect.anything(),
    )
  })

  it('has no a11y violations', async () => {
    await putEmailBody(db, textBodyRow('e1', 'accessible body'))
    const { container } = renderView(seen({ subject: 'A11y' }))
    await screen.findByText('Alice')
    await expectNoA11yViolations(container)
  })
})
