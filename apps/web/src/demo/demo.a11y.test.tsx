import { render } from '@testing-library/react'
import type { Mailbox } from '@waxwing/jmap'
import { describe, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { registerDemoI18n } from './i18n'
import { LoginView } from './LoginView'
import { MailboxListView } from './MailboxListView'
import { MessageListView, type MessageRow } from './MessageListView'
import { MessageView } from './MessageView'

// Demo strings live in a demo-scoped bundle (kept out of the shipped common.json); register
// them onto the shared i18next instance so the rendered demo views resolve their labels.
registerDemoI18n()

const noop = () => {}

const inbox: Mailbox = {
  id: 'mb-in',
  name: 'Inbox',
  parentId: null,
  role: 'inbox',
  sortOrder: 0,
  totalEmails: 25,
  unreadEmails: 3,
  totalThreads: 25,
  unreadThreads: 3,
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
}

const rows: MessageRow[] = [
  {
    id: 'e-1',
    sender: 'Bob Baker',
    subject: 'Hello',
    preview: 'A preview',
    receivedAt: '2026-07-09T10:00:00Z',
    hasAttachment: true,
    unread: true,
  },
]

describe('demo accessibility', () => {
  it('login view (OAuth-unavailable variant) has no axe violations', async () => {
    const { container } = render(
      <LoginView
        serverUrl="http://192.168.1.50:5173"
        onServerUrlChange={noop}
        onBasicSubmit={noop}
        onOAuth={noop}
        oauthAvailable={false}
        defaultUsername="alice@waxwing.test"
        defaultPassword="pw"
        busy={false}
      />,
    )
    await expectNoA11yViolations(container)
  })

  it('the read workspace views have no axe violations', async () => {
    const { container } = render(
      <div>
        <MailboxListView mailboxes={[inbox]} selectedId="mb-in" onSelect={noop} />
        <MessageListView
          rows={rows}
          position={0}
          total={25}
          pageSize={10}
          selectedId="e-1"
          busy={false}
          onSelect={noop}
          onPrev={noop}
          onNext={noop}
        />
        <MessageView
          subject="Hello"
          from="Bob <bob@waxwing.test>"
          to="Alice <alice@waxwing.test>"
          date="9 Jul 2026, 10:00"
          textBody="Plain text body"
          htmlBody="<p>Hello</p>"
          mode="html"
          onToggleMode={noop}
          attachments={[
            {
              key: 'blob-1',
              blobId: 'blob-1',
              type: 'message/rfc822',
              name: 'forwarded.eml',
              size: 312,
              isMessage: true,
            },
          ]}
          onDownload={noop}
          onParse={noop}
          parsed={{}}
          rawJson="{}"
          busy={false}
        />
      </div>,
    )
    // iframes:false — jsdom cannot postMessage into the sandboxed srcdoc frame, and axe would
    // otherwise try to cross into it; the frame's own content is not under a11y test here.
    await expectNoA11yViolations(container, { iframes: false })
  })
})
