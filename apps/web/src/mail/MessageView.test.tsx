import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EmailBodyPart, EmailBodyValue } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
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
/** Every external link opens through `window.open`; the FR-RD-08 tests assert on exactly this. */
let openSpy: MockInstance<typeof window.open>

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
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

  it('the Archive button is disabled while reading a message already IN Archive', async () => {
    // `useTriage` refuses `to === from`, so this button was enabled over a dispatch that could never
    // happen: click, no move, no toast, no undo — "archived nothing, said nothing" (6da2350) on the
    // mouse path. Trash always had the equivalent (it swaps to Delete inside Trash); Archive did not.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen(), 'archive')
    // Junk IS a real move from Archive, and it enables as soon as its liveQuery lands — waiting for
    // it is what proves the assertion below is the self-move gate rather than an unresolved query.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark as junk' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
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

  // ---- phishing friction (M3.9, FR-RD-08) ----

  /**
   * Click a link inside the real body frame — no mock anywhere in the path: MessageView renders
   * MailBodyFrame, which mounts the real `mountMailFrame`, whose real listener resolves the target
   * and calls back into `useLinkOpener`.
   *
   * Two things a browser does that jsdom does not, done by hand: fire `load` for an assigned
   * `srcdoc`, and parse it into the child document. Everything downstream is production code, and
   * the click is dispatched from the FRAME's realm — the only way this reaches the app at all
   * (see the cross-realm note in `@waxwing/mail-html`'s `frame.ts`).
   */
  async function clickBodyLink(href: string, text: string): Promise<void> {
    const frame = (await screen.findByTitle(/^Message:/)) as HTMLIFrameElement
    // The iframe being IN the DOM does not mean it has been mounted: `mountMailFrame` runs in a
    // passive effect, and findByTitle's MutationObserver can resolve before React flushes it. An
    // assigned srcdoc is the observable proof that it ran — and therefore that the click listener
    // this whole helper depends on exists. (Without this wait the tests pass or fail on tick
    // alignment; they were doing exactly that.)
    await waitFor(() => expect(frame.srcdoc).not.toBe(''))
    await act(async () => {
      frame.dispatchEvent(new Event('load'))
    })
    const doc = frame.contentDocument
    if (doc === null) throw new Error('no contentDocument')
    doc.body.innerHTML = `<a href="${href}">${text}</a>`
    const link = doc.querySelector('a')
    const view = doc.defaultView
    if (link === null || view === null) throw new Error('no link')
    await act(async () => {
      link.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }

  it('opens a benign link straight away, with no dialog and no opener handle', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('https://bank.test/login', 'bank.test')
    expect(openSpy).toHaveBeenCalledWith('https://bank.test/login', '_blank', 'noopener,noreferrer')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('raises the interstitial for a link whose text names a different host', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    const dialog = await screen.findByRole('dialog', { name: 'This link may not be genuine' })
    // Both hosts named, and nothing opened while the reader decides.
    expect(within(dialog).getByText('bank.test')).toBeInTheDocument()
    expect(within(dialog).getByText('paypa1-secure.ru')).toBeInTheDocument()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('raises the interstitial for a protocol-relative href, through the real frame (D1)', async () => {
    // End-to-end proof of the base fix: nothing mocked between the click and the verdict. The href
    // never parses on its own, and `window.open` would resolve it against the app document and land
    // on evil.tld — the same destination `https://evil.tld/steal` has always warned about.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('//evil.tld/steal', 'bank.test')
    const dialog = await screen.findByRole('dialog', { name: 'This link may not be genuine' })
    expect(within(dialog).getByText('evil.tld')).toBeInTheDocument()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('raises the interstitial for a host hidden behind display:none markup (D3)', async () => {
    // The sanitizer keeps `display:none` on purpose, so the reader sees exactly `bank.test` while
    // `textContent` is `!bank.test`. Driven through the real frame, which is what reads textContent.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('https://evil.tld/', '<span style="display:none">!</span>bank.test')
    const dialog = await screen.findByRole('dialog', { name: 'This link may not be genuine' })
    expect(within(dialog).getByText('bank.test')).toBeInTheDocument()
    expect(within(dialog).getByText('evil.tld')).toBeInTheDocument()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('Cancel does NOT open the link', async () => {
    // The single most important assertion in this file: the friction has to actually stop it.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(openSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('focuses Cancel when the interstitial opens, and Escape backs out without opening', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    )
    await user.keyboard('{Escape}')
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('Open anyway opens the link the reader was warned about, and only that link', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    const user = userEvent.setup()
    renderView(seen())
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Open anyway' }))
    expect(openSpy).toHaveBeenCalledExactlyOnceWith(
      'https://paypa1-secure.ru/login',
      '_blank',
      'noopener,noreferrer',
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('offers no way to stop being asked — the friction cannot be trained away', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen({ from: [{ name: 'Alice', email: 'alice@x.test' }] }))
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/don't ask|do not ask|always|trust/i)).not.toBeInTheDocument()
  })

  it('opens a mailto: link normally — there is no host to compare', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('mailto:support@bank.test', 'bank.test')
    expect(openSpy).toHaveBeenCalledWith(
      'mailto:support@bank.test',
      '_blank',
      'noopener,noreferrer',
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('has no a11y violations on the interstitial', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen())
    await clickBodyLink('https://paypa1-secure.ru/login', 'bank.test')
    await screen.findByRole('dialog')
    // Dialog portals to document.body, outside the RTL container — scan the default root.
    await expectNoA11yViolations(undefined, { iframes: false })
  })

  // ---- the sender's real address (M3.9, FR-RD-08) ----

  it('shows the real address next to the display name, always — no hover involved', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen({ from: [{ name: 'Alice', email: 'alice@x.test' }] }))
    const header = (await screen.findByText('Alice')).closest('header')
    expect(header).not.toBeNull()
    // Present in the DOM without a pointer ever touching it, and not the details disclosure —
    // that is still collapsed.
    expect(within(header as HTMLElement).getByText('alice@x.test')).toBeInTheDocument()
    expect(screen.queryByText('Message-ID')).not.toBeInTheDocument()
  })

  it('does not repeat the address when it IS the display name', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen({ from: [{ name: null, email: 'alice@x.test' }] }))
    const header = (await screen.findByText('alice@x.test')).closest('header')
    expect(within(header as HTMLElement).getAllByText('alice@x.test')).toHaveLength(1)
  })

  it('marks a display name that impersonates a different address', async () => {
    // From: "security@bank.test" <attacker@evil.tld> — the trick no hover affordance catches on a
    // touch screen, which is why the marker is always on.
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen({ from: [{ name: 'security@bank.test', email: 'attacker@evil.tld' }] }))
    expect(
      await screen.findByText("The name shown is not the sender's real address"),
    ).toBeInTheDocument()
    expect(screen.getByText('attacker@evil.tld')).toBeInTheDocument()
  })

  it('does NOT mark an ordinary sender', async () => {
    await putEmailBody(db, textBodyRow('e1', 'body'))
    renderView(seen({ from: [{ name: 'Alice', email: 'alice@x.test' }] }))
    await screen.findByText('Alice')
    expect(
      screen.queryByText("The name shown is not the sender's real address"),
    ).not.toBeInTheDocument()
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
