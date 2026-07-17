import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EmailBodyPart } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentList } from './AttachmentList'

// Blob download is irrelevant here — stub it so the list needs no ReplicaProvider.
vi.mock('./use-blob', () => ({ useBlobFetcher: () => vi.fn(async () => null) }))
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
    // Exactly one Open message button — for the .eml, not the PDF.
    expect(await screen.findAllByRole('button', { name: 'Open message' })).toHaveLength(1)
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

    await user.click(await screen.findByRole('button', { name: 'Open message' }))
    expect(screen.getByTestId('nested-b2')).toBeInTheDocument()
    // Label flips to the collapse action.
    await user.click(screen.getByRole('button', { name: 'Hide message' }))
    expect(screen.queryByTestId('nested-b2')).not.toBeInTheDocument()
  })
})
