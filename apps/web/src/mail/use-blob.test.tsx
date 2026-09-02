import { renderHook, waitFor } from '@testing-library/react'
import { BlobTooLargeError, DEFAULT_MAX_DOWNLOAD_BYTES, JmapHttpError } from '@waxwing/jmap'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyBlobError, downloadCeiling, useBlobFetcher } from './use-blob'

/**
 * The ceiling on one attachment download (R-11 — the half of W-11 that was never wired up).
 *
 * W-11 gave `downloadBlob` a `maxBytes` option and a 256 MB backstop, and noted that a caller who
 * already knows the size should pass it "plus a small tolerance". No app caller did: a grep for
 * `maxBytes` outside `packages/jmap` came back empty, so every attachment click ran on the backstop
 * alone — two orders of magnitude above anything a JMAP server will accept as an upload.
 */
const download = vi.fn()
vi.mock('../app/session/context', () => ({
  useSession: () => ({ getClient: () => ({ download }) }),
}))

beforeEach(() => {
  download.mockReset()
  download.mockResolvedValue(new Uint8Array([1, 2, 3]))
})

describe('downloadCeiling', () => {
  it('leaves room for a server that is a little wrong about its own bytes', () => {
    // Not `size` exactly. `EmailBodyPart.size` is a number the SERVER wrote about its own data, and
    // a client that turns a small disagreement into "this attachment cannot be opened" has traded a
    // rare denial-of-service for a common false refusal.
    expect(downloadCeiling(1024)).toBeGreaterThan(1024)
  })

  it('never raises the ceiling above the package backstop, however big the claim', () => {
    // Otherwise a hostile part could lift its own limit simply by claiming to be enormous.
    expect(downloadCeiling(10 * DEFAULT_MAX_DOWNLOAD_BYTES)).toBe(DEFAULT_MAX_DOWNLOAD_BYTES)
  })

  it.each([
    ['an unknown size', undefined],
    ['zero', 0],
    ['a negative number', -1],
    ['NaN', Number.NaN],
  ])('falls back to the package backstop for %s', (_name, size) => {
    expect(downloadCeiling(size)).toBeUndefined()
  })
})

describe('useBlobFetcher', () => {
  it('passes a ceiling derived from the declared size', async () => {
    const { result } = renderHook(() => useBlobFetcher('a'))
    await result.current({ blobId: 'b1', type: 'image/png', name: 'p.png', size: 1024 })

    await waitFor(() => expect(download).toHaveBeenCalled())
    const options = download.mock.calls[0]?.[4] as { maxBytes?: number }
    expect(options.maxBytes).toBe(downloadCeiling(1024))
  })

  it('passes no ceiling when the caller has no size to give — the package default applies', async () => {
    const { result } = renderHook(() => useBlobFetcher('a'))
    await result.current({ blobId: 'b1', type: 'image/png', name: 'p.png' })

    await waitFor(() => expect(download).toHaveBeenCalled())
    expect(download.mock.calls[0]?.[4]).toEqual({})
  })
})

describe('classifyBlobError', () => {
  it('tells the ceiling refusal apart from the failures the source dialog already knew', () => {
    // The fourth case, and the reason it needs a class rather than a message match: nothing else can
    // distinguish "the server sent more than it promised" from a plain server error.
    expect(classifyBlobError(new BlobTooLargeError(1024, 2048))).toBe('tooLarge')
    expect(classifyBlobError(new TypeError('Failed to fetch'))).toBe('offline')
    expect(classifyBlobError(new JmapHttpError(404, ''))).toBe('notFound')
    expect(classifyBlobError(new JmapHttpError(500, ''))).toBe('failed')
  })
})
