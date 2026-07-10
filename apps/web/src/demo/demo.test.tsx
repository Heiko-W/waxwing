import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Mailbox } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import { registerDemoI18n } from './i18n'
import { LoginView } from './LoginView'
import { MailboxListView } from './MailboxListView'
import { MessageListView, type MessageRow } from './MessageListView'
import { type AttachmentRow, MessageView } from './MessageView'

// The demo's strings live in a demo-scoped bundle (kept out of the shipped common.json), so
// register them onto the shared i18next instance before rendering any demo view here.
registerDemoI18n()

function makeMailbox(overrides: Partial<Mailbox>): Mailbox {
  return {
    id: 'mb-1',
    name: 'Inbox',
    parentId: null,
    role: 'inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    ...overrides,
  }
}

function makeRow(overrides: Partial<MessageRow>): MessageRow {
  return {
    id: 'e-1',
    sender: 'Bob Baker',
    subject: 'Hello',
    preview: 'A preview',
    receivedAt: '2026-07-09T10:00:00Z',
    hasAttachment: false,
    unread: false,
    ...overrides,
  }
}

const noop = () => {}

describe('LoginView', () => {
  it('submits Basic credentials from the fields', async () => {
    const user = userEvent.setup()
    const onBasicSubmit = vi.fn()
    render(
      <LoginView
        serverUrl="http://localhost:5173"
        onServerUrlChange={noop}
        onBasicSubmit={onBasicSubmit}
        onOAuth={noop}
        oauthAvailable
        defaultUsername="alice@waxwing.test"
        defaultPassword="pw"
        busy={false}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Sign in (Basic)' }))

    expect(onBasicSubmit).toHaveBeenCalledWith('alice@waxwing.test', 'pw')
  })

  it('lets the user edit the fields before submitting', async () => {
    const user = userEvent.setup()
    const onBasicSubmit = vi.fn()
    render(
      <LoginView
        serverUrl="http://localhost:5173"
        onServerUrlChange={noop}
        onBasicSubmit={onBasicSubmit}
        onOAuth={noop}
        oauthAvailable
        defaultUsername=""
        defaultPassword=""
        busy={false}
      />,
    )

    await user.type(screen.getByLabelText('Username'), 'bob@waxwing.test')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Sign in (Basic)' }))

    expect(onBasicSubmit).toHaveBeenCalledWith('bob@waxwing.test', 'secret')
  })

  it('enables OAuth in a secure context', async () => {
    const user = userEvent.setup()
    const onOAuth = vi.fn()
    render(
      <LoginView
        serverUrl="http://localhost:5173"
        onServerUrlChange={noop}
        onBasicSubmit={noop}
        onOAuth={onOAuth}
        oauthAvailable
        defaultUsername=""
        defaultPassword=""
        busy={false}
      />,
    )

    const button = screen.getByRole('button', { name: 'Sign in with OAuth' })
    expect(button).not.toHaveAttribute('aria-disabled', 'true')
    await user.click(button)
    expect(onOAuth).toHaveBeenCalledOnce()
  })

  it('disables OAuth on an insecure origin and explains why', async () => {
    const user = userEvent.setup()
    const onOAuth = vi.fn()
    render(
      <LoginView
        serverUrl="http://192.168.1.50:5173"
        onServerUrlChange={noop}
        onBasicSubmit={noop}
        onOAuth={onOAuth}
        oauthAvailable={false}
        defaultUsername=""
        defaultPassword=""
        busy={false}
      />,
    )

    const button = screen.getByRole('button', { name: 'Sign in with OAuth' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    await user.click(button)
    expect(onOAuth).not.toHaveBeenCalled()
    expect(screen.getByText(/secure context/i)).toBeInTheDocument()
  })
})

describe('MailboxListView', () => {
  it('renders each mailbox with its role and counts', () => {
    render(
      <MailboxListView
        mailboxes={[
          makeMailbox({
            id: 'mb-in',
            name: 'Inbox',
            role: 'inbox',
            totalEmails: 25,
            unreadEmails: 3,
          }),
          makeMailbox({
            id: 'mb-sent',
            name: 'Sent',
            role: 'sent',
            totalEmails: 4,
            unreadEmails: 0,
          }),
        ]}
        selectedId="mb-in"
        onSelect={noop}
      />,
    )

    expect(screen.getByText('Inbox')).toBeInTheDocument()
    expect(screen.getByText('Sent')).toBeInTheDocument()
    expect(screen.getByText('3 unread / 25 total')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Inbox/ })).toHaveAttribute('aria-current', 'true')
  })
})

describe('MessageListView paging', () => {
  const rows = Array.from({ length: 10 }, (_, index) => makeRow({ id: `e-${index}` }))

  it('disables Previous and shows the range on the first page', () => {
    render(
      <MessageListView
        rows={rows}
        position={0}
        total={25}
        pageSize={10}
        selectedId={null}
        busy={false}
        onSelect={noop}
        onPrev={noop}
        onNext={noop}
      />,
    )

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
    expect(screen.getByText('1–10 of 25')).toBeInTheDocument()
  })

  it('disables Next on the last page', () => {
    render(
      <MessageListView
        rows={Array.from({ length: 5 }, (_, index) => makeRow({ id: `e-${index}` }))}
        position={20}
        total={25}
        pageSize={10}
        selectedId={null}
        busy={false}
        onSelect={noop}
        onPrev={noop}
        onNext={noop}
      />,
    )

    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByText('21–25 of 25')).toBeInTheDocument()
  })

  it('invokes callbacks for paging and selection', async () => {
    const user = userEvent.setup()
    const onNext = vi.fn()
    const onSelect = vi.fn()
    render(
      <MessageListView
        rows={[makeRow({ id: 'e-42', subject: 'Pick me' })]}
        position={0}
        total={25}
        pageSize={10}
        selectedId={null}
        busy={false}
        onSelect={onSelect}
        onPrev={noop}
        onNext={onNext}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(onNext).toHaveBeenCalledOnce()

    await user.click(screen.getByText('Pick me'))
    expect(onSelect).toHaveBeenCalledWith('e-42')
  })
})

describe('MessageView', () => {
  const rfc822Attachment: AttachmentRow = {
    key: 'blob-1',
    blobId: 'blob-1',
    type: 'message/rfc822',
    name: 'forwarded.eml',
    size: 312,
    isMessage: true,
  }

  function renderMessage(overrides: Partial<Parameters<typeof MessageView>[0]> = {}) {
    return render(
      <MessageView
        subject="A subject"
        from="Bob <bob@waxwing.test>"
        to="Alice <alice@waxwing.test>"
        date="9 Jul 2026, 10:00"
        textBody="Plain text body"
        htmlBody="<p>Hello <b>world</b></p>"
        mode="html"
        onToggleMode={noop}
        attachments={[]}
        onDownload={noop}
        onParse={noop}
        parsed={{}}
        rawJson="{}"
        busy={false}
        {...overrides}
      />,
    )
  }

  it('renders the HTML body in a fully sandboxed iframe (no scripts, no same-origin)', () => {
    renderMessage()
    const frame = screen.getByTitle('HTML message body')
    expect(frame.tagName).toBe('IFRAME')
    // sandbox="" is the maximally-restrictive value: no allow-scripts, no allow-same-origin.
    expect(frame).toHaveAttribute('sandbox', '')
    expect(frame).toHaveAttribute('srcdoc', expect.stringContaining('<b>world</b>'))
  })

  it('shows the plain-text body in a <pre> in text mode', () => {
    renderMessage({ mode: 'text' })
    expect(screen.getByText('Plain text body')).toBeInTheDocument()
    expect(screen.queryByTitle('HTML message body')).not.toBeInTheDocument()
  })

  it('offers Email/parse for a message/rfc822 attachment', async () => {
    const user = userEvent.setup()
    const onParse = vi.fn()
    renderMessage({ attachments: [rfc822Attachment], onParse })

    await user.click(screen.getByRole('button', { name: 'Parse (Email/parse)' }))
    expect(onParse).toHaveBeenCalledWith(rfc822Attachment)
  })

  it('renders the parsed inner subject and body once Email/parse returns', () => {
    renderMessage({
      attachments: [rfc822Attachment],
      parsed: { 'blob-1': { subject: 'Inner subject', from: 'Dave', text: 'Inner body' } },
    })

    expect(screen.getByText('Inner subject')).toBeInTheDocument()
    expect(screen.getByText('Inner body')).toBeInTheDocument()
  })

  it('does not offer Email/parse for a non-message attachment', () => {
    renderMessage({
      attachments: [{ ...rfc822Attachment, type: 'application/pdf', isMessage: false }],
    })

    expect(screen.queryByRole('button', { name: 'Parse (Email/parse)' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
  })
})
