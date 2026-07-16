import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EmailBodyPart, EmailBodyValue } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import { SessionContext } from '../app/session/context'
import type { SessionContextValue } from '../app/session/types'
import { useComposerStore } from '../compose'
import {
  type EmailBodyRow,
  type EmailRow,
  putEmailBody,
  putMailboxes,
  type ReplicaDb,
  ReplicaProvider,
  setPref,
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

function textBodyRow(id: string, text: string): EmailBodyRow & { authResults: string[] } {
  return {
    accountId: 'a',
    id,
    bodyValues: { t1: val(text) },
    bodyStructure: part({ partId: 't1' }),
    textBody: [part({ partId: 't1', type: 'text/plain' })],
    htmlBody: [part({ partId: 't1', type: 'text/plain' })],
    attachments: [],
    hasAttachment: false,
    authResults: [],
    fetchedAt: 1,
    lastAccessedAt: 1,
    bytes: 0,
    ablob: [],
  }
}

function htmlRemoteRow(id: string): EmailBodyRow & { authResults: string[] } {
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
    authResults: [],
    fetchedAt: 1,
    lastAccessedAt: 1,
    bytes: 0,
    ablob: [],
  }
}

const session = {
  getClient: () => null,
  connected: {
    jmapSession: {
      accounts: { a: { name: 'me@x.test', isPersonal: true } },
      username: 'me@x.test',
    },
  },
} as unknown as SessionContextValue
const dispatch = vi.fn()
let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined })
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
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined })
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

  it('reply seeds a draft addressed to the sender with a Re: subject and threading', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(
      seen({
        from: [{ name: 'Alice', email: 'alice@x.test' }],
        subject: 'Hi',
        messageId: ['<m1@x>'],
      }),
    )
    const reply = await screen.findByRole('button', { name: 'Reply' })
    await waitFor(() => expect(reply).toBeEnabled())
    await user.click(reply)
    const drafts = [...useComposerStore.getState().drafts.values()]
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.to).toEqual([{ name: 'Alice', email: 'alice@x.test' }])
    expect(drafts[0]?.subject).toBe('Re: Hi')
    expect(drafts[0]?.inReplyTo).toEqual(['<m1@x>'])
  })

  it('reply-all drops the signed-in user and keeps other recipients', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(
      seen({
        from: [{ name: 'Alice', email: 'alice@x.test' }],
        to: [
          { name: 'Me', email: 'me@x.test' },
          { name: 'Bob', email: 'bob@x.test' },
        ],
        subject: 'Hi',
      }),
    )
    const replyAll = await screen.findByRole('button', { name: 'Reply all' })
    await waitFor(() => expect(replyAll).toBeEnabled())
    await user.click(replyAll)
    const draft = [...useComposerStore.getState().drafts.values()][0]
    const cc = (draft?.cc ?? []).map((address) => address.email)
    expect(cc).toContain('bob@x.test')
    expect(cc).not.toContain('me@x.test')
  })

  it('forward yields an empty To, a Fwd: subject, and carries attachments', async () => {
    await putEmailBody(db, {
      ...textBodyRow('e1', 'body'),
      attachments: [part({ blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 10 })],
    })
    const user = userEvent.setup()
    renderView(seen({ subject: 'Hi' }))
    const forward = await screen.findByRole('button', { name: 'Forward' })
    await waitFor(() => expect(forward).toBeEnabled())
    await user.click(forward)
    const draft = [...useComposerStore.getState().drafts.values()][0]
    expect(draft?.to).toEqual([])
    expect(draft?.subject).toBe('Fwd: Hi')
    expect(draft?.attachments).toHaveLength(1)
    expect(draft?.inReplyTo).toBeNull()
  })

  it('archives by dispatching a move to the archive mailbox', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen(), 'inbox')
    // The Archive button is disabled until the archive-mailbox liveQuery resolves — wait for it
    // (clicking a disabled button is a silent no-op, which would flake the dispatch assertion).
    const archive = screen.getByRole('button', { name: 'Archive' })
    await waitFor(() => expect(archive).toBeEnabled())
    await user.click(archive)
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

  it('loads remote images with NO banner when the user has turned them on (M3.7)', async () => {
    // The user's setting overrides the deployment default — which is what makes the config a default
    // rather than a lock.
    await setPref(db, 'a', 'reading.remoteContent', 'allow')
    await putEmailBody(db, htmlRemoteRow('e1'))
    renderView(seen({ subject: 'Newsletter' }))
    // The pref arrives through liveQuery, so the first paint may still show the banner — what matters
    // is that it goes away without the user clicking anything.
    await waitFor(() =>
      expect(screen.queryByText('Remote content blocked')).not.toBeInTheDocument(),
    )
  })

  it('does NOT auto-mark read when the user has turned that off (M3.7)', async () => {
    // The pref has gated this dwell timer since M1.8 — M3.7 is the first release in which anyone
    // could actually set it.
    await setPref(db, 'a', 'reading.autoMarkRead', false)
    await putEmailBody(db, textBodyRow('e1', 'body'))
    vi.useFakeTimers()
    renderView(toEmailRow('a', email('e1', { keywords: {} })))
    await vi.advanceTimersByTimeAsync(AUTO_MARK_READ_DELAY_MS * 2)
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'setKeywords', keyword: '$seen' }),
      expect.anything(),
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

  // ---- header details (M3.9, FR-RD-06) ----

  async function openDetails(
    row: EmailRow,
    body?: EmailBodyRow & { authResults: string[] },
  ): Promise<HTMLElement> {
    await putEmailBody(db, body ?? textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(row)
    await user.click(await screen.findByRole('button', { name: 'Details' }))
    return screen.getByRole('article')
  }

  it('shows Bcc, the Message-ID and a differing Reply-To in the details', async () => {
    const details = await openDetails(
      seen({
        from: [{ name: 'Alice', email: 'alice@x.test' }],
        replyTo: [{ name: null, email: 'list@x.test' }],
        messageId: ['<m-42@x.test>'],
      }),
      { ...textBodyRow('e1', 'body'), bcc: [{ name: null, email: 'secret@x.test' }] },
    )
    expect(within(details).getByText('Reply-To')).toBeInTheDocument()
    expect(within(details).getByText('list@x.test')).toBeInTheDocument()
    expect(within(details).getByText('Bcc')).toBeInTheDocument()
    expect(within(details).getByText('secret@x.test')).toBeInTheDocument()
    expect(within(details).getByText('Message-ID')).toBeInTheDocument()
    expect(within(details).getByText('<m-42@x.test>')).toBeInTheDocument()
  })

  it('hides a Reply-To that merely repeats From — noise, not information', async () => {
    const details = await openDetails(
      seen({
        from: [{ name: 'Alice', email: 'alice@x.test' }],
        // Same mailbox, different display name and casing: still the same address.
        replyTo: [{ name: 'Alice Smith', email: 'ALICE@x.test' }],
      }),
    )
    expect(within(details).queryByText('Reply-To')).not.toBeInTheDocument()
  })

  it('names the Sender as acting on behalf of From', async () => {
    const details = await openDetails(seen({ from: [{ name: 'Alice', email: 'alice@x.test' }] }), {
      ...textBodyRow('e1', 'body'),
      sender: [{ name: 'Mailer', email: 'bounce@list.test' }],
    })
    expect(within(details).getByText(/on behalf of/)).toBeInTheDocument()
    expect(within(details).getByText(/bounce@list\.test/)).toBeInTheDocument()
  })

  it('shows Sent separately only when it diverges from the received time', async () => {
    const near = await openDetails(
      seen({ receivedAt: '2026-07-01T12:00:00Z', sentAt: '2026-07-01T11:58:00Z' }),
    )
    expect(within(near).queryByText('Sent')).not.toBeInTheDocument()
    cleanup()
    await db.emailBodies.clear()

    const far = await openDetails(
      seen({ receivedAt: '2026-07-01T12:00:00Z', sentAt: '2026-06-28T09:00:00Z' }),
    )
    expect(within(far).getByText('Sent')).toBeInTheDocument()
  })

  it('renders NO authentication block when the message carries no such header', async () => {
    const details = await openDetails(seen(), { ...textBodyRow('e1', 'body'), authResults: [] })
    expect(within(details).queryByText('Authentication')).not.toBeInTheDocument()
  })

  it('quotes the TOPMOST report and names who reported it — with no verdict', async () => {
    // The whole point of `:asText:all` + [0]: the forged report a phishing message carries is the
    // LAST one; our MTA's is the first. This asserts the fail, the authserv-id, and the absence of
    // any verdict styling.
    const details = await openDetails(seen(), {
      ...textBodyRow('e1', 'body'),
      authResults: [
        'mx.stalwart.test; dkim=fail header.d=paypal.test; dmarc=fail header.from=paypal.test',
        'mx.paypal.test; dkim=pass header.d=paypal.test; dmarc=pass header.from=paypal.test',
      ],
    })
    expect(within(details).getByText('Authentication')).toBeInTheDocument()
    expect(within(details).getByText(/Reported by mx\.stalwart\.test/)).toBeInTheDocument()
    expect(within(details).getByText(/dkim=fail · dmarc=fail/)).toBeInTheDocument()
    expect(within(details).queryByText(/dmarc=pass/)).not.toBeInTheDocument()
    expect(within(details).getByText(/cannot be verified/)).toBeInTheDocument()
  })

  it('renders no authentication block for a body row written before M3.9', async () => {
    // `authResults: undefined` is exactly "this row predates M3.9" — the engine re-fetches it, and
    // until it lands the details must simply omit the block rather than invent one.
    const details = await openDetails(seen(), textBodyRow('e1', 'body'))
    expect(within(details).queryByText('Authentication')).not.toBeInTheDocument()
  })

  // ---- overflow menu (M3.9) ----

  it('offers View source / Save as .eml from the overflow menu', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await user.click(await screen.findByRole('button', { name: 'More actions' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'View source' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Save as .eml' })).toBeInTheDocument()
  })

  it('does not mount the source dialog until View source is chosen', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await screen.findByText('Alice')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'View source' }))
    expect(await screen.findByRole('dialog', { name: 'Message source' })).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    await putEmailBody(db, textBodyRow('e1', 'accessible body'))
    const { container } = renderView(seen({ subject: 'A11y' }))
    await screen.findByText('Alice')
    // Wait for the body frame so the full reading chrome is scanned, not the loading spinner.
    await screen.findByTitle(/^Message:/)
    // Do not descend into the sandboxed body iframe: axe cannot postMessage into a sandboxed
    // srcdoc frame under jsdom (it throws "Respondable target must be a frame"), and the frame's
    // internal a11y is the @waxwing/mail-html package's concern. This scans the MessageView
    // chrome — header, action bar, banner, attachments.
    await expectNoA11yViolations(container, { iframes: false })
  })
})
