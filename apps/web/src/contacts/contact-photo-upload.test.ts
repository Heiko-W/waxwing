import { afterEach, describe, expect, it, vi } from 'vitest'
import { scalePhoto } from './contact-photo-upload'

afterEach(() => {
  vi.unstubAllGlobals()
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
