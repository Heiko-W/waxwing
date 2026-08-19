/**
 * The shared inline-preview policy (M5.17).
 *
 * The assertions that carry weight are the refusals: `text/html` must never reach a frame, and
 * every unlisted type must fall through to "download it and open it yourself". Both are the kind
 * of rule that a later "just add one more type" quietly breaks.
 */

import { describe, expect, it } from 'vitest'
import { isPreviewable, previewSurface } from './preview-policy'

describe('images', () => {
  it('renders raster images in an <img>', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']) {
      expect(previewSurface(type), type).toBe('image')
    }
  })

  it('renders SVG in an <img>, never a frame', () => {
    // Secure static mode is a guarantee about `<img>` specifically: no scripts, no external
    // fetches. The same file in a frame would be an ordinary document that can do both.
    expect(previewSurface('image/svg+xml')).toBe('image')
  })
})

describe('framed documents', () => {
  it('frames a PDF', () => {
    expect(previewSurface('application/pdf')).toBe('frame')
  })

  it('frames plain text', () => {
    expect(previewSurface('text/plain')).toBe('frame')
  })

  it('reads a type that carries parameters', () => {
    // A FileNode type comes from whatever uploaded the file; `charset` on it is ordinary.
    expect(previewSurface('text/plain; charset=utf-8')).toBe('frame')
    expect(previewSurface('APPLICATION/PDF')).toBe('frame')
    expect(previewSurface('  application/pdf  ')).toBe('frame')
  })
})

describe('what it refuses', () => {
  it('refuses HTML', () => {
    // The one type that must not reach a frame: it would arrive without the sanitizer the mail
    // body frame exists to apply.
    expect(previewSurface('text/html')).toBeNull()
    expect(previewSurface('application/xhtml+xml')).toBeNull()
  })

  it('refuses other text types rather than admitting the whole family', () => {
    expect(previewSurface('text/csv')).toBeNull()
    expect(previewSurface('text/xml')).toBeNull()
  })

  it('refuses everything unlisted', () => {
    for (const type of [
      'application/zip',
      'application/octet-stream',
      'message/rfc822',
      'video/mp4',
      'audio/mpeg',
    ]) {
      expect(previewSurface(type), type).toBeNull()
    }
  })

  it('refuses a missing type instead of guessing', () => {
    expect(previewSurface(null)).toBeNull()
    expect(previewSurface(undefined)).toBeNull()
    expect(previewSurface('')).toBeNull()
  })
})

describe('isPreviewable', () => {
  it('agrees with previewSurface', () => {
    for (const type of ['image/png', 'application/pdf', 'text/html', 'application/zip', '']) {
      expect(isPreviewable(type), type).toBe(previewSurface(type) !== null)
    }
  })
})
