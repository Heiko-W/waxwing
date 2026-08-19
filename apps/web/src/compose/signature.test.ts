import { describe, expect, it } from 'vitest'
import { htmlToPlainText } from './html-to-text'
import {
  applySignature,
  pickDefaultIdentity,
  replaceSignature,
  SIGNATURE_ATTR,
  signatureHtmlForIdentity,
} from './signature'

const SIG = '<div>— Jane Doe</div>'
const parse = (html: string): HTMLElement => new DOMParser().parseFromString(html, 'text/html').body
const marker = (html: string): Element | null => parse(html).querySelector(`[${SIGNATURE_ATTR}]`)
/** Document-order index of an element among the body's element children. */
const indexOf = (body: HTMLElement, selector: string): number =>
  [...body.children].findIndex((el) => el.matches(selector))

describe('applySignature', () => {
  it('seeds a marked signature into an empty draft', () => {
    const out = applySignature('', SIG)
    const sig = marker(out)
    expect(sig).not.toBeNull()
    expect(sig?.textContent).toContain('Jane Doe')
    expect(parse(out).querySelector('p')).not.toBeNull() // cursor slot present
  })

  it('places the signature after the leading empty block and before the quote (reply)', () => {
    const reply = '<p><br></p><p>On date, X wrote:</p><blockquote><p>hi</p></blockquote>'
    const body = parse(applySignature(reply, SIG))
    expect(marker(body.innerHTML)).not.toBeNull()
    const sigIndex = indexOf(body, `[${SIGNATURE_ATTR}]`)
    // Signature sits before the attribution + quote, after the leading empty slot.
    expect(sigIndex).toBe(1)
    expect(sigIndex).toBeLessThan(indexOf(body, 'blockquote'))
  })

  it('prepends the signature when there is no leading empty block', () => {
    const body = parse(applySignature('<p>typed already</p>', SIG))
    expect(indexOf(body, `[${SIGNATURE_ATTR}]`)).toBe(0)
  })

  it('is a no-op for an empty signature', () => {
    expect(applySignature('<p>keep</p>', '')).toBe('<p>keep</p>')
    expect(applySignature('<p>keep</p>', '   ')).toBe('<p>keep</p>')
  })
})

describe('replaceSignature', () => {
  it('swaps the signature contents, preserving the user text', () => {
    const seeded = applySignature('<p><br></p><p>my draft text</p>', SIG)
    const out = replaceSignature(seeded, '<div>— New Identity</div>')
    expect(marker(out)?.textContent).toContain('New Identity')
    expect(marker(out)?.textContent).not.toContain('Jane Doe')
    expect(parse(out).textContent).toContain('my draft text')
  })

  it('removes the container when the new signature is empty', () => {
    const seeded = applySignature('<p>x</p>', SIG)
    expect(marker(replaceSignature(seeded, ''))).toBeNull()
  })

  it('is a no-op when there is no marker (user deleted the signature)', () => {
    const body = '<p>no signature here</p>'
    expect(replaceSignature(body, '<div>new</div>')).toBe(body)
  })
})

describe('signatureHtmlForIdentity', () => {
  it('prefers the HTML signature, falls back to text, else empty', () => {
    expect(signatureHtmlForIdentity({ htmlSignature: '<b>h</b>', textSignature: 't' })).toBe(
      '<b>h</b>',
    )
    expect(signatureHtmlForIdentity({ htmlSignature: '', textSignature: 'plain' })).toContain(
      'plain',
    )
    expect(signatureHtmlForIdentity({ htmlSignature: '', textSignature: '' })).toBe('')
  })
})

describe('pickDefaultIdentity', () => {
  const ids = [{ email: 'a@x.test' }, { email: 'Me@X.test' }]
  it('matches the hint case-insensitively', () => {
    expect(pickDefaultIdentity(ids, 'me@x.test')?.email).toBe('Me@X.test')
  })
  it('falls back to the first identity when the hint misses or is absent', () => {
    expect(pickDefaultIdentity(ids, 'none@x.test')?.email).toBe('a@x.test')
    expect(pickDefaultIdentity(ids)?.email).toBe('a@x.test')
  })
  it('returns undefined for an empty list', () => {
    expect(pickDefaultIdentity([], 'x@y.test')).toBeUndefined()
  })
})

describe('plain-text alternative', () => {
  it('carries the signature and the quoted body into the text form', () => {
    const reply = '<p><br></p><p>On date, X wrote:</p><blockquote><p>original</p></blockquote>'
    const text = htmlToPlainText(applySignature(reply, SIG))
    expect(text).toContain('Jane Doe')
    expect(text).toContain('> original')
  })
})

/** The `style` attribute values on an already-sanitized string, in document order. */
const styleAttrs = (html: string): string[] =>
  [...parse(html).querySelectorAll('[style]')].map((el) => el.getAttribute('style') ?? '')

/**
 * `htmlSignature` is server data — an admin, another client, or our own M5.1 editor put it there —
 * and `signatureHtmlForIdentity` writes it into a contenteditable in the APP document, where the
 * composer's DOMPurify keeps `style`, `<form>` and `<input>`. That is the same door `quoted-html.ts`
 * measured the `position:fixed` overlay coming through on the quote path, so the signature path has
 * to be pinned against exactly the same attack.
 */
describe('signatureHtmlForIdentity — a signature is untrusted HTML in the app DOM', () => {
  it('strips a full-viewport overlay down to its paint, keeping the text', () => {
    const overlay =
      '<div style="position:fixed;inset:0;z-index:2147483647;background:#fff">Session expired — sign in again</div>'
    const out = signatureHtmlForIdentity({ htmlSignature: overlay, textSignature: '' })
    // Everything that makes it a PANEL is gone; a white background on an in-flow div is just paint.
    expect(styleAttrs(out)).toEqual(['background:#fff'])
    expect(out).not.toContain('position')
    expect(out).not.toContain('inset')
    expect(out).not.toContain('z-index')
    expect(parse(out).textContent).toContain('Session expired')
  })

  /**
   * Content FIRST in every fixture on purpose: the HTML parser hoists a LEADING `<style>`/`<script>`
   * into `<head>`, where `body.innerHTML` never sees it, so such a fixture would pass even if
   * nothing were dropped.
   */
  it.each([
    [
      'a stylesheet, which re-grants every property the style filter removed',
      'style',
      '<style>p{position:fixed;inset:0}</style>',
    ],
    ['a script', 'script', '<script>alert(1)</script>'],
    ['a keystroke-collecting input', 'input', '<input name="password">'],
    ['a textarea', 'textarea', '<textarea name="password"></textarea>'],
  ])('does not let %s survive in a signature', (_reason, tag, markup) => {
    const out = signatureHtmlForIdentity({
      htmlSignature: `<p>Jane Doe</p>${markup}`,
      textSignature: '',
    })
    expect(parse(out).querySelector(tag)).toBeNull()
    expect(parse(out).textContent).toContain('Jane Doe')
  })

  /**
   * The counter-test, and it carries as much weight as the ones above: a company logo and a link are
   * what a signature IS. A pass that sanitized those away would be reverted the first time someone
   * looked at their own mail, and the overlay would come back with it.
   */
  it('leaves the ordinary parts of a signature — emphasis, a link, an https logo — intact', () => {
    const sig =
      '<p><b>Jane Doe</b> — <i>Head of Everything</i><br>' +
      '<a href="https://acme.test/team/jane">acme.test</a><br>' +
      '<img src="https://acme.test/logo.png" alt="Acme" style="width:120px"></p>'
    const body = parse(signatureHtmlForIdentity({ htmlSignature: sig, textSignature: '' }))
    expect(body.querySelector('b')?.textContent).toBe('Jane Doe')
    expect(body.querySelector('i')?.textContent).toBe('Head of Everything')
    expect(body.querySelector('a')?.getAttribute('href')).toBe('https://acme.test/team/jane')
    expect(body.querySelector('img')?.getAttribute('src')).toBe('https://acme.test/logo.png')
    // Sizing survives, so the logo is still logo-sized rather than full-bleed.
    expect(body.querySelector('img')?.getAttribute('style')).toBe('width:120px')
  })

  /**
   * ORDER. Sanitizing has to run BEFORE the `.trim()` tests, not after: a signature that is nothing
   * but stripped markup must read as EMPTY here, so the text signature gets its turn. Sanitize
   * afterwards and the raw markup passes the trim test, `applySignature` seeds an empty marker
   * container, and the text alternative is never reached.
   */
  it.each([
    ['<style>p{position:fixed}</style>'],
    ['<svg><style>p{position:fixed}</style></svg>'],
    ['<input name="password">'],
  ])('treats %s as an empty signature and falls back to the text one', (htmlSignature) => {
    const out = signatureHtmlForIdentity({ htmlSignature, textSignature: 'Jane Doe' })
    expect(out).toContain('Jane Doe')
    expect(out).not.toContain('position')
    expect(out).not.toContain('password')
    // …and with nothing to fall back to, it is empty rather than a non-empty string of leftovers.
    expect(signatureHtmlForIdentity({ htmlSignature, textSignature: '' })).toBe('')
  })
})

/** The two halves composed: what the From-identity swap actually runs on a draft. */
describe('signature insertion for an identity whose HTML sanitizes away', () => {
  // Wrapped in `<svg>` so the fixture stays in the BODY: a leading bare `<style>` is hoisted into
  // `<head>` by the parser and would sanitize to '' even if nothing here dropped it.
  const OVERLAY_ONLY = '<svg><style>div{position:fixed;inset:0}</style></svg>'

  it('removes an existing marker container rather than filling it with the leftovers', () => {
    const seeded = applySignature('<p><br></p><p>my draft text</p>', SIG)
    const swapped = replaceSignature(
      seeded,
      signatureHtmlForIdentity({ htmlSignature: OVERLAY_ONLY, textSignature: '' }),
    )
    expect(marker(swapped)).toBeNull()
    expect(swapped).not.toContain('position')
    expect(parse(swapped).textContent).toContain('my draft text')
  })

  it('seeds no marker at all into a fresh draft', () => {
    const out = applySignature(
      '<p>typed already</p>',
      signatureHtmlForIdentity({ htmlSignature: OVERLAY_ONLY, textSignature: '' }),
    )
    expect(out).toBe('<p>typed already</p>')
    expect(marker(out)).toBeNull()
  })
})
