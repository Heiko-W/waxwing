import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EmailBodyPart } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentList } from './AttachmentList'

// Blob download is irrelevant to most of this file — stub it so the list needs no ReplicaProvider.
// The filename tests need it to SUCCEED, though (a null blob returns before the anchor is built),
// so it hands back a one-byte blob rather than null.
vi.mock('./use-blob', () => ({ useBlobFetcher: () => vi.fn(async () => new Blob(['x'])) }))
// The nested view is tested separately; stub it so this test needs no session/JMAP client.
vi.mock('./NestedMessageView', () => ({
  NestedMessageView: (props: { blobId: string }) => (
    <div data-testid={`nested-${props.blobId}`}>nested body</div>
  ),
}))

function part(over: Partial<EmailBodyPart>): EmailBodyPart {
  return {
    partId: null,
    blobId: 'b1',
    size: 1024,
    headers: [],
    name: 'file',
    type: 'application/pdf',
    charset: null,
    disposition: 'attachment',
    cid: null,
    language: null,
    location: null,
    subParts: null,
    ...over,
  } as unknown as EmailBodyPart
}

describe('AttachmentList — attached message/rfc822 (FR-RD-07)', () => {
  it('offers Open message on a message/rfc822 part and not on others', async () => {
    render(
      <AttachmentList
        accountId="a"
        attachments={[
          part({ blobId: 'b1', name: 'doc.pdf', type: 'application/pdf' }),
          part({ blobId: 'b2', name: 'fwd.eml', type: 'message/rfc822' }),
        ]}
      />,
    )
    // Exactly one Open message button — for the .eml, not the PDF. Matched by the accessible name,
    // which NAMES THE FILE (B20.1): three attachments used to render three buttons all called
    // "Open message", indistinguishable to anyone listening rather than looking.
    expect(await screen.findAllByRole('button', { name: /^Open message/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Open message: fwd.eml' })).toBeInTheDocument()
  })

  it('expands the nested view on click and collapses it again', async () => {
    const user = userEvent.setup()
    render(
      <AttachmentList
        accountId="a"
        attachments={[part({ blobId: 'b2', name: 'fwd.eml', type: 'message/rfc822' })]}
      />,
    )
    expect(screen.queryByTestId('nested-b2')).not.toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: 'Open message: fwd.eml' }))
    expect(screen.getByTestId('nested-b2')).toBeInTheDocument()
    // Label flips to the collapse action — still naming the file, and still PREFIXED by the visible
    // text so voice control can say what it reads (WCAG 2.5.3).
    await user.click(screen.getByRole('button', { name: 'Hide message: fwd.eml' }))
    expect(screen.queryByTestId('nested-b2')).not.toBeInTheDocument()
  })
})

/**
 * The filename is the SENDER's string, and this component is the only thing between it and the
 * reader. Both halves are pinned: what lands in `download`, and what the reader is shown — the
 * second is the one that is really ours, since Chromium and WebKit sanitize `download` themselves.
 */
describe('AttachmentList — a hostile filename', () => {
  /** `Invoice<U+202E>gpj.exe` renders as `Invoiceexe.jpg`: the visible extension is a lie. */
  const RLO = '\u202E'
  const SPOOFED = `Invoice${RLO}gpj.exe`

  it('shows the name with the bidi override removed, isolated in a <bdi>', async () => {
    render(<AttachmentList accountId="a" attachments={[part({ name: SPOOFED })]} />)
    const label = await screen.findByTitle('Invoicegpj.exe')
    expect(label.textContent).toBe('Invoicegpj.exe')
    expect(label.textContent).not.toContain(RLO)
    // Isolation, so a legitimately RTL name cannot reorder the size and buttons beside it either.
    expect(label.tagName).toBe('BDI')
  })

  it('names the file the same way in every accessible name', async () => {
    render(
      <AttachmentList accountId="a" attachments={[part({ name: SPOOFED, type: 'image/png' })]} />,
    )
    for (const name of ['Preview: Invoicegpj.exe', 'Download Invoicegpj.exe']) {
      expect(await screen.findByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: new RegExp(RLO) })).not.toBeInTheDocument()
  })

  it('puts a stripped name in the download attribute', async () => {
    const user = userEvent.setup()
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:test')
      .mockName('createObjectURL')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const names: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download)
    })

    render(
      <AttachmentList
        accountId="a"
        attachments={[part({ name: `../../${SPOOFED}`, type: 'application/pdf' })]}
      />,
    )
    await user.click(await screen.findByRole('button', { name: /^Download/ }))

    expect(createUrl).toHaveBeenCalled()
    expect(names).toEqual(['Invoicegpj.exe'])
  })
})
