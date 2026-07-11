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
