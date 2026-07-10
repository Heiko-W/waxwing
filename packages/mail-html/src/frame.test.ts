// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildFrameDocument, mountMailFrame } from './frame'

describe('buildFrameDocument', () => {
  it('embeds a strict inner CSP with no script and a light background', () => {
    const doc = buildFrameDocument('<p>hi</p>')
    expect(doc).toContain('http-equiv="Content-Security-Policy"')
    expect(doc).toContain("script-src 'none'")
    expect(doc).toContain('img-src blob: data:')
    expect(doc).not.toContain('https:') // default: no remote images allowed
    expect(doc).toContain('background:#ffffff')
    expect(doc).toContain('<p>hi</p>')
  })

  it('permits remote https images in the CSP only when allowRemote', () => {
    const doc = buildFrameDocument('<p>hi</p>', { allowRemote: true })
    expect(doc).toContain('img-src blob: data: https:')
  })
})

describe('mountMailFrame', () => {
  it('mounts under a script-free sandbox and sets srcdoc', () => {
    const iframe = document.createElement('iframe')
    const controller = mountMailFrame(iframe, buildFrameDocument('<p>hi</p>'))

    const sandbox = iframe.getAttribute('sandbox') ?? ''
    expect(sandbox).toBe('allow-same-origin')
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-top-navigation')
    expect(iframe.srcdoc).toContain('<p>hi</p>')

    // The height/link wiring only runs on a real 'load' with an accessible contentDocument (a
    // browser); here we assert teardown is safe to call.
    expect(() => controller.destroy()).not.toThrow()
  })
})
