// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { buildFrameDocument, type MailLinkInfo, mountMailFrame } from './frame'

/**
 * Mount a frame and hand back its INNER document with `bodyHtml` in it, so a click can be dispatched
 * from the frame's own realm — which is the whole point of these tests (see the cross-realm note in
 * `frame.ts`).
 *
 * jsdom does not parse `srcdoc` into the child document and does not fire `load` when `srcdoc` is
 * assigned to an attached iframe, so the two things a browser does for us are done by hand: dispatch
 * `load`, then write the body. Everything after that — the listener wiring, the target resolution,
 * the text extraction — is the real `mountMailFrame` code path.
 */
function mountWithBody(bodyHtml: string, onLink: (href: string, info: MailLinkInfo) => void) {
  const iframe = document.createElement('iframe')
  document.body.append(iframe)
  const controller = mountMailFrame(iframe, buildFrameDocument(bodyHtml), { onLink })
  iframe.dispatchEvent(new Event('load'))
  const doc = iframe.contentDocument
  if (doc === null) throw new Error('no contentDocument')
  doc.body.innerHTML = bodyHtml
  return { iframe, doc, controller }
}

function clickIn(doc: Document, selector: string): void {
  const node = doc.querySelector(selector)
  if (node === null) throw new Error(`no ${selector}`)
  const view = doc.defaultView
  if (view === null) throw new Error('no defaultView')
  node.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true }))
}

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

    // The height wiring only runs on a real 'load' with a live ResizeObserver (a browser); here we
    // assert teardown is safe to call. Link interception IS covered — see below.
    expect(() => controller.destroy()).not.toThrow()
  })
})

describe('mountMailFrame — link interception (FR-RD-08)', () => {
  it('intercepts a click on a link in the frame and reports its href and visible text', () => {
    const onLink = vi.fn()
    const { doc } = mountWithBody('<p><a href="https://evil.ru/steal">bank.test</a></p>', onLink)
    clickIn(doc, 'a')
    expect(onLink).toHaveBeenCalledWith('https://evil.ru/steal', {
      href: 'https://evil.ru/steal',
      text: 'bank.test',
    })
  })

  it('resolves the link from a click on a node INSIDE it, across the realm boundary', () => {
    // The regression this file exists for: `event.target` is a node from the frame's realm, so the
    // old `target instanceof Element` (this realm's Element) was always false and onLink never
    // fired at all. jsdom gives each frame its own constructors, exactly as a browser does.
    const onLink = vi.fn()
    const { doc } = mountWithBody('<a href="https://evil.ru/x"><b>Click here</b></a>', onLink)
    expect(doc.querySelector('b') instanceof Element).toBe(false) // ← the trap, made explicit
    clickIn(doc, 'b')
    expect(onLink).toHaveBeenCalledWith('https://evil.ru/x', {
      href: 'https://evil.ru/x',
      text: 'Click here',
    })
  })

  it('prevents the frame from navigating itself', () => {
    // No sandbox flag stops same-frame navigation; preventDefault is the only thing that does.
    const onLink = vi.fn()
    const { doc } = mountWithBody('<a href="https://evil.ru/x">go</a>', onLink)
    const link = doc.querySelector('a')
    const view = doc.defaultView
    if (link === null || view === null) throw new Error('no link')
    const event = new view.MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('yields empty text for an image-only link', () => {
    const onLink = vi.fn()
    const { doc } = mountWithBody(
      '<a href="https://evil.ru/x"><img src="data:image/gif;base64,R0lGOD" alt=""></a>',
      onLink,
    )
    clickIn(doc, 'img')
    expect(onLink).toHaveBeenCalledWith('https://evil.ru/x', {
      href: 'https://evil.ru/x',
      text: '',
    })
  })

  it('yields empty text for an image-map <area>', () => {
    const onLink = vi.fn()
    const { doc } = mountWithBody(
      '<map name="m"><area href="https://evil.ru/x" shape="rect" coords="0,0,9,9" alt="a"></map>',
      onLink,
    )
    clickIn(doc, 'area')
    expect(onLink).toHaveBeenCalledWith('https://evil.ru/x', {
      href: 'https://evil.ru/x',
      text: '',
    })
  })

  it('trims the visible text but never truncates it', () => {
    // Truncating here would be a bypass, not a bound: padding the text past the cap is exactly how an
    // attacker hides the host their link claims. See `link-host.ts`'s header.
    const onLink = vi.fn()
    const tail = '!'.repeat(5000)
    const { doc } = mountWithBody(
      `<a href="https://evil.ru/x">\n   bank.test${tail}\n  </a>`,
      onLink,
    )
    clickIn(doc, 'a')
    const info = onLink.mock.calls[0]?.[1] as MailLinkInfo
    expect(info.text).toBe(`bank.test${tail}`)
  })

  it('intercepts an auxiliary (middle/ctrl) click too', () => {
    const onLink = vi.fn()
    const { doc } = mountWithBody('<a href="https://evil.ru/x">go</a>', onLink)
    const link = doc.querySelector('a')
    const view = doc.defaultView
    if (link === null || view === null) throw new Error('no link')
    link.dispatchEvent(new view.MouseEvent('auxclick', { bubbles: true, cancelable: true }))
    expect(onLink).toHaveBeenCalledOnce()
  })

  it('ignores a click that is not on a link', () => {
    const onLink = vi.fn()
    const { doc } = mountWithBody('<p id="p">just text</p>', onLink)
    clickIn(doc, '#p')
    expect(onLink).not.toHaveBeenCalled()
  })

  it('stops intercepting once destroyed', () => {
    // A fragment href, not an absolute one: with the listener gone the click reaches jsdom's own
    // anchor default action, and a fragment navigation is the one shape jsdom implements quietly.
    const onLink = vi.fn()
    const { doc, controller } = mountWithBody('<a href="#x">go</a>', onLink)
    controller.destroy()
    clickIn(doc, 'a')
    expect(onLink).not.toHaveBeenCalled()
  })
})
