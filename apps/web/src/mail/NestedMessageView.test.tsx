import { render, screen } from '@testing-library/react'
import type { Email } from '@waxwing/jmap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NestedMessageView } from './NestedMessageView'
import type { ParsedMessage } from './use-parsed-message'

// MailBodyFrame mounts a real sandboxed iframe; stub it so the test can read the props the security
// posture depends on (bodyHtml + allowRemote) without a cross-realm iframe.
vi.mock('./MailBodyFrame', () => ({
  MailBodyFrame: (props: { bodyHtml: string; allowRemote: boolean; title: string }) => (
    <div
      data-testid="body-frame"
      data-allow-remote={String(props.allowRemote)}
      data-title={props.title}
    >
      {props.bodyHtml}
    </div>
  ),
}))

// The hook is tested separately; drive the view by mocking its return.
const state = vi.hoisted(() => ({ current: null as unknown as ParsedMessage }))
vi.mock('./use-parsed-message', () => ({
  useParsedMessage: () => state.current,
}))

function parsed(over: Partial<Email> = {}): Email {
  return {
    subject: 'Quarterly report',
    from: [{ name: 'Alice', email: 'alice@x.test' }],
    to: null,
    sentAt: '2026-07-12T14:30:00Z',
    preview: '',
    textBody: [],
    htmlBody: [],
    bodyValues: {},
    ...over,
  } as unknown as Email
}

afterEach(() => vi.clearAllMocks())

describe('NestedMessageView', () => {
  it('shows a spinner while loading', () => {
    state.current = { message: null, loading: true, error: null }
    render(<NestedMessageView accountId="a" blobId="b1" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('shows a localized message when the blob is not parsable', () => {
    state.current = { message: null, loading: false, error: 'notParsable' }
    render(<NestedMessageView accountId="a" blobId="b1" />)
    expect(screen.getByText("This attached message couldn't be opened.")).toBeInTheDocument()
  })

  it('shows the offline message when there is no connection', () => {
    state.current = { message: null, loading: false, error: 'offline' }
    render(<NestedMessageView accountId="a" blobId="b1" />)
    expect(screen.getByText('Connect to open this message.')).toBeInTheDocument()
  })

  it('renders the header and a plain-text body', () => {
    state.current = {
      message: parsed({
        textBody: [{ partId: 't1', type: 'text/plain' } as Email['textBody'][number]],
        bodyValues: { t1: { value: 'hello nested', isEncodingProblem: false, isTruncated: false } },
      }),
      loading: false,
      error: null,
    }
    render(<NestedMessageView accountId="a" blobId="b1" />)

    expect(screen.getByText('Quarterly report')).toBeInTheDocument()
    expect(screen.getByText('Alice <alice@x.test>')).toBeInTheDocument()
    const frame = screen.getByTestId('body-frame')
    expect(frame).toHaveTextContent('hello nested')
    // The inner sender is untrusted: remote content stays blocked regardless of the outer allowlist.
    expect(frame).toHaveAttribute('data-allow-remote', 'false')
  })

  it('shows the spinner, NOT the error, on the pre-fetch transition frame', () => {
    // The hook's fetch runs in a passive effect (after first paint), so the very first frame is
    // {message: null, loading: false, error: null} — no message YET, but no error either. Rendering
    // the error there flashed "couldn't be opened" on every successful open. It must be a spinner.
    state.current = { message: null, loading: false, error: null }
    render(<NestedMessageView accountId="a" blobId="b1" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText("This attached message couldn't be opened.")).not.toBeInTheDocument()
  })

  it('flags a truncated body rather than showing it silently clipped', () => {
    state.current = {
      message: parsed({
        htmlBody: [{ partId: 'h1', type: 'text/html' } as Email['htmlBody'][number]],
        bodyValues: {
          h1: { value: '<p>clipped…</p>', isEncodingProblem: false, isTruncated: true },
        },
      }),
      loading: false,
      error: null,
    }
    render(<NestedMessageView accountId="a" blobId="b1" />)
    expect(screen.getByText(/Showing the beginning of this message only/)).toBeInTheDocument()
  })

  it('sanitizes an HTML body and still blocks remote content', () => {
    state.current = {
      message: parsed({
        htmlBody: [{ partId: 'h1', type: 'text/html' } as Email['htmlBody'][number]],
        bodyValues: {
          h1: {
            value: '<p>hi</p><script>alert(1)</script>',
            isEncodingProblem: false,
            isTruncated: false,
          },
        },
      }),
      loading: false,
      error: null,
    }
    render(<NestedMessageView accountId="a" blobId="b1" />)

    const frame = screen.getByTestId('body-frame')
    // Real sanitize() ran: the script is gone, the paragraph stays.
    expect(frame).toHaveTextContent('hi')
    expect(frame.textContent).not.toContain('<script>')
    expect(frame).toHaveAttribute('data-allow-remote', 'false')
    expect(frame).toHaveAttribute('data-title', 'Attached message: Quarterly report')
  })
})
