import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EmailBodyPart } from '@waxwing/jmap'
import { JmapHttpError } from '@waxwing/jmap'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../ui'
import { AttachmentList } from './AttachmentList'

/**
 * What the attachment strip says when a download does not arrive (R-11, the rest of W-11).
 *
 * Every action here reaches the network, in an app whose whole point is working offline — and none
 * of them had a `catch`. Clicking Download on a blob that is not cached, with no connection, did
 * exactly nothing: the spinner went out (`finally`), the rejection went to the console, and the
 * reader was told neither that it had failed nor why. `MessageSourceDialog` and `NestedMessageView`
 * next door have classified and shown their failures all along.
 *
 * The mock is the real `classifyBlobError` (only the fetcher is faked), so what these assert is the
 * whole path from the thrown error to the sentence on screen.
 */
const fetchBlob = vi.fn()
vi.mock('./use-blob', async () => {
  const actual = await vi.importActual<typeof import('./use-blob')>('./use-blob')
  return { ...actual, useBlobFetcher: () => fetchBlob }
})
vi.mock('./NestedMessageView', () => ({ NestedMessageView: () => <div /> }))

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

function ui(parts: EmailBodyPart[]): ReactNode {
  return (
    <ToastProvider>
      <AttachmentList accountId="a" attachments={parts} />
    </ToastProvider>
  )
}

/** Every rejection Node saw go unhandled during a test — the console-only failure, made visible. */
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason)
}

beforeEach(() => {
  unhandled.length = 0
  fetchBlob.mockReset()
  process.on('unhandledRejection', onUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
})

/** Let the click's promise chain and the toast's render settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

describe('AttachmentList when a download fails', () => {
  it('names the file and the reason when Download hits an unreachable network', async () => {
    // `fetch` rejects with a TypeError when the network is unreachable — the same discrimination
    // `classifySourceError` makes for the source dialog.
    fetchBlob.mockRejectedValue(new TypeError('Failed to fetch'))
    const user = userEvent.setup()
    render(ui([part({ blobId: 'b1', name: 'doc.pdf' })]))

    await user.click(screen.getByRole('button', { name: 'Download doc.pdf' }))
    expect(
      await screen.findByText('doc.pdf could not be downloaded — you are offline.'),
    ).toBeVisible()
    await settle()
    expect(unhandled).toEqual([])
  })

  it('says a 404 is gone from the server rather than "offline"', async () => {
    fetchBlob.mockRejectedValue(new JmapHttpError(404, ''))
    const user = userEvent.setup()
    render(ui([part({ blobId: 'b1', name: 'pic.png', type: 'image/png' })]))

    await user.click(screen.getByRole('button', { name: 'Preview: pic.png' }))
    expect(await screen.findByText('pic.png is no longer on the server.')).toBeVisible()
    await settle()
    expect(unhandled).toEqual([])
  })

  it('speaks up when there is no connected client at all', async () => {
    // `useBlobFetcher` answers `null` when the session has no client. Silent before: the code
    // returned early and the spinner simply went out again.
    fetchBlob.mockResolvedValue(null)
    const user = userEvent.setup()
    render(ui([part({ blobId: 'b1', name: 'doc.pdf' })]))

    await user.click(screen.getByRole('button', { name: 'Download doc.pdf' }))
    expect(
      await screen.findByText('doc.pdf could not be downloaded — you are offline.'),
    ).toBeVisible()
  })

  it('still archives what it could get and names what is missing from it', async () => {
    // `Promise.all` used to fail the WHOLE batch on one unreachable blob: no zip, no message, for a
    // message whose other attachments were sitting in the replica.
    fetchBlob.mockImplementation(async (ref: { blobId: string }) => {
      if (ref.blobId === 'b2') throw new TypeError('Failed to fetch')
      return new Blob(['x'])
    })
    const user = userEvent.setup()
    render(ui([part({ blobId: 'b1', name: 'a.pdf' }), part({ blobId: 'b2', name: 'b.pdf' })]))

    await user.click(screen.getByRole('button', { name: 'Save all' }))
    expect(
      await screen.findByText(
        'The archive was saved without these, which could not be downloaded: b.pdf.',
      ),
    ).toBeVisible()
    await settle()
    expect(unhandled).toEqual([])
  })

  it('says no archive was saved when nothing could be fetched', async () => {
    fetchBlob.mockRejectedValue(new TypeError('Failed to fetch'))
    const user = userEvent.setup()
    render(ui([part({ blobId: 'b1', name: 'a.pdf' }), part({ blobId: 'b2', name: 'b.pdf' })]))

    await user.click(screen.getByRole('button', { name: 'Save all' }))
    expect(
      await screen.findByText('Nothing could be downloaded, so no archive was saved.'),
    ).toBeVisible()
    await settle()
    expect(unhandled).toEqual([])
  })

  it('says nothing at all when the download works', async () => {
    fetchBlob.mockResolvedValue(new Blob(['x']))
    const user = userEvent.setup()
    render(ui([part({ blobId: 'b1', name: 'doc.pdf' })]))

    await user.click(screen.getByRole('button', { name: 'Download doc.pdf' }))
    await settle()
    expect(screen.queryByText(/could not be downloaded/)).toBeNull()
  })
})
