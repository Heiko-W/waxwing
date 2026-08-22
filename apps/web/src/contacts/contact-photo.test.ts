import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blobToDataUri,
  PHOTO_MAX_BYTES,
  PHOTO_MAX_EDGE,
  PhotoTooLargeError,
  preparePhotoUri,
  scalePhoto,
} from './contact-photo'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('scalePhoto', () => {
  it('returns the original file unchanged when the runtime cannot decode it (jsdom / no createImageBitmap)', async () => {
    // jsdom has no createImageBitmap; the scaler must fall back rather than throw.
    vi.stubGlobal('createImageBitmap', undefined)
    const file = new File(['bytes'], 'me.png', { type: 'image/png' })
    const prepared = await scalePhoto(file)
    expect(prepared.blob).toBe(file)
    expect(prepared.mediaType).toBe('image/png')
  })

  it('falls back to a generic media type when the file has none', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    const file = new File(['bytes'], 'blob')
    const prepared = await scalePhoto(file)
    expect(prepared.mediaType).toBe('application/octet-stream')
  })
})

/**
 * The inline write path (JMAP gap analysis, B-1). Stalwart rejects `media[].blobId`
 * (`"blobIds in media is not supported."`, measured) and accepts a `data:` URI, so the photo goes
 * into the CARD — which is what makes the two ceilings below part of the contract rather than
 * tuning.
 */
describe('preparePhotoUri', () => {
  it('encodes the scaled bytes as a data: URI carrying the media type', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    const file = new File(['bytes'], 'me.png', { type: 'image/png' })
    const prepared = await preparePhotoUri(file)
    expect(prepared.mediaType).toBe('image/png')
    expect(prepared.uri).toMatch(/^data:image\/png;base64,/)
    // Round-trips: the payload really is the file's bytes.
    expect(atob(prepared.uri.split(',')[1] ?? '')).toBe('bytes')
  })

  it('refuses a photo that would not fit in a card', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    const giant = new File(['x'.repeat(PHOTO_MAX_BYTES + 1)], 'huge.png', { type: 'image/png' })
    await expect(preparePhotoUri(giant)).rejects.toBeInstanceOf(PhotoTooLargeError)
  })

  it('names the type itself — a typeless blob must not yield a type-less data: URI', async () => {
    const uri = await blobToDataUri(new Blob(['ab']), 'image/jpeg')
    expect(uri).toBe(`data:image/jpeg;base64,${btoa('ab')}`)
  })
})

describe('the scaler’s two ceilings', () => {
  /** A bitmap stub: `createImageBitmap` is the only thing jsdom is missing to run the real path. */
  function stubBitmap(width: number, height: number): void {
    vi.stubGlobal('createImageBitmap', async () => ({ width, height, close: () => {} }))
  }

  it('re-encodes an image that is small on screen but heavy on the wire', async () => {
    // 200px square — under the edge limit — but 300 KB of lossless PNG. Before the photo moved
    // into the card this was passed through; now the bytes are the constraint.
    stubBitmap(200, 200)
    const encoded: Blob[] = []
    const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement
    vi.spyOn(document, 'createElement').mockImplementation(
      () =>
        Object.assign(canvas, {
          getContext: () => ({ drawImage: () => {} }),
          toBlob: (cb: (blob: Blob) => void) => {
            const blob = new Blob(['small'], { type: 'image/jpeg' })
            encoded.push(blob)
            cb(blob)
          },
        }) as unknown as HTMLElement,
    )
    const heavy = new File(['y'.repeat(PHOTO_MAX_BYTES + 1)], 'flat.png', { type: 'image/png' })
    const prepared = await scalePhoto(heavy)
    expect(encoded.length, 'the heavy file was re-encoded').toBe(1)
    expect(prepared.mediaType).toBe('image/jpeg')
    expect(prepared.blob.size).toBeLessThan(PHOTO_MAX_BYTES)
  })

  it('scales the longest edge down to PHOTO_MAX_EDGE, which is sized for the 5rem avatar', () => {
    // Stated as a rule, not a number: 256 covers an 80px (5rem) avatar at 3× device pixels.
    expect(PHOTO_MAX_EDGE).toBeGreaterThanOrEqual(80 * 3)
  })
})
