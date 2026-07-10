// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitize } from './sanitize'

/** No lowercase http/https URL survives anywhere in the output. */
function hasNoRemoteUrl(html: string): boolean {
  return !/https?:\/\//i.test(html)
}

describe('sanitize — XSS corpus', () => {
  it('strips <script>', () => {
    const { html } = sanitize('<p>hi</p><script>alert(1)</script>')
    expect(html).toContain('hi')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('strips inline event handlers', () => {
    const { html } = sanitize('<img src="cid:x" onerror="alert(1)">')
    expect(html.toLowerCase()).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })

  it('neutralizes javascript: hrefs', () => {
    const { html } = sanitize('<a href="javascript:alert(1)">x</a>')
    expect(html).not.toContain('javascript:')
  })

  it('drops SVG entirely (no <svg onload>, no <svg><script>)', () => {
    const { html } = sanitize('<svg onload="alert(1)"><script>alert(2)</script></svg><p>ok</p>')
    expect(html.toLowerCase()).not.toContain('<svg')
    expect(html.toLowerCase()).not.toContain('onload')
    expect(html).not.toContain('alert(')
    expect(html).toContain('ok')
  })

  it('strips a remote background from an inline style (CSS exfiltration)', () => {
    const result = sanitize('<div style="background:url(https://evil.example/x)">y</div>')
    expect(hasNoRemoteUrl(result.html)).toBe(true)
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote.some((b) => b.kind === 'style')).toBe(true)
  })

  it('forbids <meta http-equiv=refresh>', () => {
    const { html } = sanitize(
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><p>z</p>',
    )
    expect(html.toLowerCase()).not.toContain('<meta')
    expect(html.toLowerCase()).not.toContain('http-equiv')
  })

  it('forbids forms', () => {
    const { html } = sanitize('<form action="https://evil.example"><input name="a"></form><p>z</p>')
    expect(html.toLowerCase()).not.toContain('<form')
    expect(html).toContain('z')
  })

  it('neutralizes DOM-clobbering name/id', () => {
    const { html } = sanitize('<img name="body"><a id="location">x</a>')
    // SANITIZE_NAMED_PROPS prefixes clobbering names/ids so they cannot shadow document props.
    expect(html).not.toMatch(/\sname="body"/)
    expect(html).not.toMatch(/\sid="location"/)
  })

  it('forbids <base> injection', () => {
    const { html } = sanitize('<base href="https://evil.example/"><p>z</p>')
    expect(html.toLowerCase()).not.toContain('<base')
    expect(hasNoRemoteUrl(html)).toBe(true)
  })

  it('blocks a remote srcset', () => {
    const result = sanitize('<img srcset="https://evil.example/x 1x, https://evil.example/y 2x">')
    expect(hasNoRemoteUrl(result.html)).toBe(true)
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote.some((b) => b.kind === 'image')).toBe(true)
  })

  it('drops a non-image data: URL but the element survives', () => {
    const { html } = sanitize('<img src="data:text/html,<script>alert(1)</script>">')
    expect(html).not.toContain('data:text/html')
    expect(html).not.toContain('alert(1)')
  })

  it('keeps a data:image URL', () => {
    const { html } = sanitize('<img src="data:image/png;base64,iVBORw0KGgo=">')
    expect(html).toContain('data:image/png')
  })
})

describe('sanitize — remote-content policy', () => {
  it('blocks remote images by default and records them', () => {
    const result = sanitize('<img src="https://tracker.example/pixel.gif">')
    expect(hasNoRemoteUrl(result.html)).toBe(true)
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote).toHaveLength(1)
    expect(result.blockedRemote[0]?.url).toBe('https://tracker.example/pixel.gif')
  })

  it('keeps remote images when allowRemote is set', () => {
    const result = sanitize('<img src="https://cdn.example/logo.png">', { allowRemote: true })
    expect(result.html).toContain('https://cdn.example/logo.png')
    expect(result.hasRemoteContent).toBe(true)
    expect(result.blockedRemote).toHaveLength(0)
  })

  it('resolves cid: via the resolver, drops it when unresolved', () => {
    const resolved = sanitize('<img src="cid:logo@x">', {
      resolveCid: (id) => (id === 'logo@x' ? 'blob:https://app/abc' : null),
    })
    expect(resolved.html).toContain('blob:https://app/abc')

    const dropped = sanitize('<img src="cid:missing">', { resolveCid: () => null })
    expect(dropped.html).not.toContain('cid:')
    expect(dropped.html).not.toContain('missing')
  })

  it('preserves a benign anchor href', () => {
    const { html } = sanitize('<a href="https://example.com">link</a>')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('link')
  })

  it('leaves no remote URL when a mail packs many remote resources (zero-network proxy)', () => {
    // Stand-in for the Done-when "zero network requests" — a real browser network-spy E2E is M1.9/M4.7.
    const result = sanitize(
      '<img src="https://a.example/1.png">' +
        '<img srcset="https://b.example/2.png 1x">' +
        '<div style="background:url(https://c.example/3.png)">x</div>' +
        '<video poster="https://d.example/4.jpg"></video>',
    )
    expect(hasNoRemoteUrl(result.html)).toBe(true)
    expect(result.blockedRemote.length).toBeGreaterThan(0)
    expect(result.hasRemoteContent).toBe(true)
  })

  it('rejects a cid resolver that returns a non-image data: URL (buggy/hostile resolver)', () => {
    const result = sanitize('<img src="cid:x">', {
      resolveCid: () => 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    })
    expect(result.html).not.toContain('data:text/html')
  })

  it('keeps a cid resolver that returns a blob: URL', () => {
    const result = sanitize('<img src="cid:x">', { resolveCid: () => 'blob:https://app/abc' })
    expect(result.html).toContain('blob:https://app/abc')
  })
})
