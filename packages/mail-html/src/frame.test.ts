// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFrameDocument, linkTextOf, type MailLinkInfo, mountMailFrame } from './frame'

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

    // Teardown is safe to call even when nothing was wired (no ResizeObserver in this environment
    // unless a test installs one — the height guard has its own describe below).
    expect(() => controller.destroy()).not.toThrow()
  })
})

/**
 * The auto-height guard. jsdom has no `ResizeObserver` and computes no layout, so both halves are
 * supplied: a stub observer whose callback the test fires by hand, and a `scrollHeight` the test
 * sets. Everything between the two — the 2px dead band, the clamp, the rate guard, the disconnect —
 * is the real `mountMailFrame` code path.
 *
 * `disconnect()` stops the stub from delivering, exactly as a real one does; that is what makes a
 * frozen height VISIBLE to these tests rather than silently identical to a working one.
 */
function mountObserved(): {
  fire: (height: number) => void
  heights: number[]
  isDisconnected: () => boolean
  destroy: () => void
} {
  const heights: number[] = []
  let notify: (() => void) | undefined
  let disconnected = false
  let scrollHeight = 0

  class StubResizeObserver {
    constructor(callback: () => void) {
      notify = callback
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      disconnected = true
    }
  }
  vi.stubGlobal('ResizeObserver', StubResizeObserver)

  const iframe = document.createElement('iframe')
  document.body.append(iframe)
  const controller = mountMailFrame(iframe, buildFrameDocument('<p>hi</p>'), {
    onHeight: (px) => heights.push(px),
  })
  iframe.dispatchEvent(new Event('load'))
  const doc = iframe.contentDocument
  if (doc === null) throw new Error('no contentDocument')
  Object.defineProperty(doc.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })

  return {
    fire: (height) => {
      scrollHeight = height
      if (!disconnected) notify?.()
    },
    heights,
    isDisconnected: () => disconnected,
    destroy: () => controller.destroy(),
  }
}

describe('mountMailFrame — the height guard is an OSCILLATION guard, not a lifetime cap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps resizing for as long as the updates stay settled', () => {
    // What the counter this replaced actually did: it counted every legitimate resize and never
    // reset, so update 51 disconnected the observer and the iframe height froze for the rest of the
    // message. `text.ts` emits a `<details>` per quote level and the frame is script-free, so ~25
    // open/close cycles of ordinary reading — or 50 images decoding one after another — spent the
    // whole budget on a message that never oscillated at all.
    const frame = mountObserved()
    for (let i = 0; i < 200; i += 1) {
      vi.advanceTimersByTime(100) // 10 per window, far below the rate a feedback loop delivers
      frame.fire(100 + i * 10)
    }
    expect(frame.heights).toHaveLength(200)
    expect(frame.heights.at(-1)).toBe(2090)
    expect(frame.isDisconnected()).toBe(false)
    frame.destroy()
  })

  it('still terminates a genuine feedback loop', () => {
    // The case the cap existed for: content whose height depends on the frame's height (a
    // `min-height:100vh` block) delivers an update every frame and never settles. Nothing here
    // advances the clock, so the whole burst lands in one window and the guard disconnects.
    const frame = mountObserved()
    for (let i = 0; i < 200; i += 1) frame.fire(i % 2 === 0 ? 300 : 600)
    expect(frame.isDisconnected()).toBe(true)
    expect(frame.heights.length).toBeLessThan(40)
    frame.destroy()
  })

  it('does not carry a spent burst into the next window', () => {
    // The difference between a rate guard and the lifetime cap, stated as a fixture: a burst that
    // stops short of the budget must leave no debt behind. 25 + 25 is over the old cap and under
    // this one, twice.
    const frame = mountObserved()
    for (let i = 0; i < 25; i += 1) frame.fire(100 + i * 10)
    vi.advanceTimersByTime(1000)
    for (let i = 0; i < 25; i += 1) frame.fire(1000 + i * 10)
    expect(frame.isDisconnected()).toBe(false)
    expect(frame.heights).toHaveLength(50)
    frame.destroy()
  })

  it('clamps the height itself, whatever the rate', () => {
    const frame = mountObserved()
    frame.fire(999999)
    expect(frame.heights).toEqual([20000])
    frame.destroy()
  })

  it('ignores a change smaller than the 2px dead band', () => {
    const frame = mountObserved()
    frame.fire(400)
    frame.fire(401)
    expect(frame.heights).toEqual([400])
    frame.destroy()
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
      raw: 'bank.test',
      separated: 'bank.test',
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
      raw: 'Click here',
      separated: 'Click here',
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
      raw: '',
      separated: '',
    })
  })

  it('reports an image-map <area>’s own alt as its text', () => {
    // An <area> has no child nodes at all, so its `alt` is the only text a reader ever gets from it —
    // and it is the label the browser renders and announces. Empty here would mean "claims nothing".
    const onLink = vi.fn()
    const { doc } = mountWithBody(
      '<map name="m"><area href="https://evil.ru/x" shape="rect" coords="0,0,9,9" alt="bank.test"></map>',
      onLink,
    )
    clickIn(doc, 'area')
    expect(onLink).toHaveBeenCalledWith('https://evil.ru/x', {
      href: 'https://evil.ru/x',
      text: 'bank.test',
      raw: 'bank.test',
      separated: 'bank.test',
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

  it('hands the classifier BOTH renderings when the anchor has element children', () => {
    // The wave-2 fix, at the seam where it actually has to hold: `mountMailFrame` must not go on
    // passing one `textContent` string. `info.text` is what `use-link-opener` feeds `classifyLink`,
    // so if it ever loses the separated rendering the phishing gate silently reopens.
    const onLink = vi.fn()
    const { doc } = mountWithBody(
      '<a href="https://evil.ru/x"><span style="color:#fff">evil.ru/</span>bank.test</a>',
      onLink,
    )
    clickIn(doc, 'a')
    const info = onLink.mock.calls[0]?.[1] as MailLinkInfo
    expect(info.raw).toBe('evil.ru/bank.test')
    expect(info.separated).toBe('evil.ru/ bank.test')
    expect(info.text).toContain('evil.ru/ bank.test')
    expect(info.text).toContain('evil.ru/bank.test')
  })
})

describe('linkTextOf — the boundary-aware rendering (wave-2)', () => {
  function textOf(html: string) {
    const host = document.createElement('div')
    host.innerHTML = html
    const link = host.querySelector('a')
    if (link === null) throw new Error('no anchor')
    return linkTextOf(link)
  }

  it('agrees with textContent on the RAW rendering, for an anchor holding no image', () => {
    // Narrowed in wave 3, because the fixtures only ever prove this much: RAW is textContent for the
    // anchors below, and textContent PLUS descendant alts in general (see the alt cases further
    // down). What the classifier's legitimate-styled-host case depends on is the no-separator
    // concatenation — `<b>bank</b>.test` names `bank.test` in this rendering and no other.
    for (const html of [
      '<a href="x">bank.test</a>',
      '<a href="x"><b>bank</b>.test</a>',
      '<a href="x"><span>a</span><i>b</i>c</a>',
      '<a href="x">  spaced  </a>',
      '<a href="x"></a>',
    ]) {
      const host = document.createElement('div')
      host.innerHTML = html
      const link = host.querySelector('a')
      if (link === null) throw new Error('no anchor')
      expect(linkTextOf(link).raw).toBe((link.textContent ?? '').trim())
    }
  })

  it('inserts a separator at every element boundary, on both sides', () => {
    expect(textOf('<a href="x"><span>evil.tld/</span>bank.test</a>').separated).toBe(
      'evil.tld/ bank.test',
    )
    expect(textOf('<a href="x">bank.test<span>x9</span></a>').separated).toBe('bank.test x9')
    expect(textOf('<a href="x">a<span>b</span>c</a>').separated).toBe('a b c')
  })

  it('separates at an EMPTY element too — a <br> is a line the reader sees', () => {
    // A parent-identity heuristic would miss this: both text nodes are children of the <a>.
    // Two spaces, because the <br> contributes a boundary on each side. Runs of whitespace are
    // irrelevant downstream — `claimedHosts` splits on `\S+` — so they are pinned, not collapsed.
    expect(textOf('<a href="x">evil.tld/<br>bank.test</a>').separated).toBe('evil.tld/  bank.test')
  })

  it('descends the whole subtree, not just the anchor’s own children', () => {
    // One boundary per nesting level; see the note above on why the run length does not matter.
    expect(textOf('<a href="x"><b><i><u>evil.tld/</u></i></b>bank.test</a>').separated).toBe(
      'evil.tld/   bank.test',
    )
  })

  it('ignores comments, exactly as textContent does', () => {
    const parts = textOf('<a href="x">bank<!-- .evil.tld -->.test</a>')
    expect(parts.raw).toBe('bank.test')
    expect(parts.separated).toBe('bank.test')
  })

  it('does NOT separate at a comment — the boundary is an ELEMENT, and a comment is not one', () => {
    // SEPARATED's invariant stated exactly: a space at every element boundary, and only there. Two
    // sibling TEXT nodes with a comment between them are one run in both renderings. That is
    // deliberate and it is not a hole: a comment renders nothing, so `bank.test<!--c-->x9` is what
    // the READER sees fused too — there is no gap between what is shown and what is classified,
    // which is the only property this pair of renderings is for.
    const parts = textOf('<a href="x">bank.test<!--c-->x9</a>')
    expect(parts.raw).toBe('bank.testx9')
    expect(parts.separated).toBe('bank.testx9')
  })

  it('emits an <img alt> into BOTH renderings, fenced like any other element', () => {
    // The wave-3 fix. `textContent` ignores `alt`, so an image-only link claimed nothing — while
    // `sanitize` strips the remote `src` by default, which is exactly what makes the browser render
    // the `alt` string to the reader. See `linkTextOf`'s header.
    const parts = textOf('<a href="x"><img alt="Sign in to bank.test"></a>')
    expect(parts.raw).toBe('Sign in to bank.test')
    expect(parts.separated).toBe('Sign in to bank.test')
  })

  it('puts an alt in a word of its own, so it cannot be glued to neighbouring text', () => {
    // The same splicing family the separated rendering exists for, one element type further on:
    // without the boundary, `evil.tld/` + an alt of `bank.test` would fuse into one host-shaped word
    // whose path happens to spell the visible host.
    expect(textOf('<a href="x">evil.tld/<img alt="bank.test"></a>').separated).toBe(
      'evil.tld/ bank.test',
    )
    expect(textOf('<a href="x"><img alt="bank.test">x9</a>').separated).toBe('bank.test x9')
  })

  it('reads an alt on an image nested below the anchor, not only a direct child', () => {
    expect(textOf('<a href="x"><b><i><img alt="bank.test"></i></b></a>').raw).toBe('bank.test')
  })

  it('emits nothing for an image with no alt, or an empty one', () => {
    expect(textOf('<a href="x"><img src="data:image/gif;base64,R0lGOD"></a>').raw).toBe('')
    expect(textOf('<a href="x"><img alt=""></a>').raw).toBe('')
  })

  it('does NOT read a title, on the very elements whose attributes it DOES read', () => {
    // A deliberate false-positive judgement, pinned so it cannot drift silently in either direction.
    // `title="shop.example.com"` on a tracked link is an ordinary newsletter shape; warning on it
    // would spend budget on text nobody read. The residual — a `title` naming a host is invisible to
    // the gate — is recorded in ADR-016.
    //
    // The fixture matters as much as the assertion. Until wave 4 this pinned `title` on `<a>` and
    // `<span>`, which `attrTextOf` returns `''` for unconditionally — so the test passed whether or
    // not the decision held, and adding `title` to the return value kept the whole suite green. The
    // elements below are the ones the function actually inspects, which is the only place the
    // decision could drift.
    for (const html of [
      '<a href="x"><img alt="Sign in" title="bank.test"></a>',
      '<a href="x"><input type="image" alt="Sign in" title="bank.test"></a>',
      '<a href="x"><input type="submit" value="Sign in" title="bank.test"></a>',
      '<a href="x"><option label="Sign in" title="bank.test"></option></a>',
    ]) {
      const parts = textOf(html)
      expect(parts.raw).toBe('Sign in')
      expect(parts.separated).toBe('Sign in')
    }
  })

  it('does not read an alt off an element that renders none', () => {
    // `alt` is rendered-in-place-of-content for `<img>`, `<area>` and an image button only. Reading
    // it anywhere else would invent text no reader is shown.
    expect(textOf('<a href="x"><span alt="bank.test">Sign in</span></a>').raw).toBe('Sign in')
    expect(textOf('<a href="x"><input type="text" alt="bank.test" value="Sign in"></a>').raw).toBe(
      'Sign in',
    )
  })

  // ---- A4b: the same defect as the <img alt>, under the other tags `sanitize` permits ----

  it('reads the alt of an <input type="image">, which renders as the button’s label', () => {
    // `sanitize` strips the remote `src` (the privacy default), and per the HTML spec an image button
    // whose image is unavailable renders its `alt` as the button label. So the reader sees the host
    // and the walk saw nothing at all — A4b, and the wave-3 `<img alt>` fix under a different tag.
    const parts = textOf('<a href="x"><input type="image" alt="Sign in to bank.test"></a>')
    expect(parts.raw).toBe('Sign in to bank.test')
    expect(parts.separated).toBe('Sign in to bank.test')
  })

  it('reads an <input value>, which is the label of a button and the contents of a field', () => {
    for (const type of ['submit', 'reset', 'button', 'text', 'email', 'url', 'search']) {
      expect(textOf(`<a href="x"><input type="${type}" value="bank.test"></a>`).raw).toBe(
        'bank.test',
      )
    }
    // No `type` at all is `text` per the spec, so the value is painted and is read.
    expect(textOf('<a href="x"><input value="bank.test"></a>').raw).toBe('bank.test')
  })

  it('reads an <input placeholder>, which is painted while the field is empty', () => {
    expect(textOf('<a href="x"><input placeholder="bank.test"></a>').raw).toBe('bank.test')
    expect(textOf('<a href="x"><textarea placeholder="bank.test"></textarea></a>').raw).toBe(
      'bank.test',
    )
  })

  it('reads an <option>/<optgroup> label, which replaces the entry’s own text', () => {
    expect(
      textOf('<a href="x"><select><option label="bank.test">x</option></select></a>').raw,
    ).toBe('bank.testx')
    expect(textOf('<a href="x"><optgroup label="bank.test"></optgroup></a>').raw).toBe('bank.test')
  })

  it.each([
    'hidden',
    'checkbox',
    'radio',
    'file',
    'color',
    'range',
    'password',
  ])('does NOT read the value of an <input type="%s">, whose control never paints it', (type) => {
    // Reading these would invent claims: a `type=hidden` value is universally present in real
    // markup and renders nothing, and a password is painted as bullets. See `attrTextOf`'s table.
    expect(textOf(`<a href="x">Sign in<input type="${type}" value="bank.test"></a>`).raw).toBe(
      'Sign in',
    )
  })

  it.each([
    '<button value="bank.test">Sign in</button>',
    '<li value="7">Sign in</li>',
    '<data value="bank.test">Sign in</data>',
    '<table summary="bank.test"><tr><td>Sign in</td></tr></table>',
    '<abbr title="bank.test">Sign in</abbr>',
  ])('does not read %s — that attribute is painted nowhere', (inner) => {
    expect(textOf(`<a href="x">${inner}</a>`).raw).toBe('Sign in')
  })

  it('puts an attribute-borne label in a word of its own, like any other content', () => {
    expect(textOf('<a href="x">evil.tld/<input type="image" alt="bank.test"></a>').separated).toBe(
      'evil.tld/ bank.test',
    )
    expect(
      textOf('<a href="x">evil.tld/<input type="submit" value="bank.test"></a>').separated,
    ).toBe('evil.tld/ bank.test')
  })

  it('does not overflow the stack on a deeply nested anchor', () => {
    // Mail is attacker-authored, so the walk is iterative rather than recursive: 20 000 nested spans
    // is a few hundred bytes of gzipped HTML and would kill a recursive walk on the click that
    // matters most. Built node by node because jsdom's own `innerHTML` parser recurses and blows up
    // first — which is itself a fair warning about how cheap this input is to write.
    // Bottom-up: jsdom notifies every ancestor on each insertion, so growing downward is quadratic
    // AND recursive in jsdom itself, long before it reaches the code under test.
    let inner: Element = document.createElement('span')
    inner.append(document.createTextNode('bank.test'))
    for (let i = 0; i < 20_000; i += 1) {
      const span = document.createElement('span')
      span.append(inner)
      inner = span
    }
    const link = document.createElement('a')
    link.append(inner)
    expect(linkTextOf(link).raw).toBe('bank.test')
    expect(linkTextOf(link).separated).toBe('bank.test')
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
