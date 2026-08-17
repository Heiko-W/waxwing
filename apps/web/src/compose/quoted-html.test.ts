import { describe, expect, it } from 'vitest'
import { sanitizeQuotedHtml } from './quoted-html'

/** The `style` attribute values left on the result, in document order (`[]` when none survived). */
function styles(html: string): string[] {
  const doc = new DOMParser().parseFromString(sanitizeQuotedHtml(html), 'text/html')
  return Array.from(doc.body.querySelectorAll('[style]')).map(
    (element) => element.getAttribute('style') ?? '',
  )
}

describe('sanitizeQuotedHtml — the overlay family', () => {
  /**
   * The measured attack, whole: a fixed, full-viewport, top-of-stack white panel inside the reply's
   * contenteditable. Everything that makes it a PANEL has to go; the paint may stay, because a white
   * background on an in-flow `<div>` is just a quoted white background.
   */
  it('strips the full-viewport fixed overlay down to its paint', () => {
    const overlay =
      '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:#fff">Sign in</div>'
    const out = sanitizeQuotedHtml(overlay)
    expect(styles(overlay)).toEqual(['background:#fff'])
    // The TEXT stays — this is a quote, not a deletion.
    expect(out).toContain('Sign in')
  })

  it.each([
    ['position:fixed'],
    ['position:absolute'],
    ['position:sticky'],
    ['position:relative'],
    ['top:0'],
    ['left:0'],
    ['right:0'],
    ['bottom:0'],
    ['inset:0'],
    ['z-index:2147483647'],
    ['float:left'],
    ['display:none'],
    ['visibility:hidden'],
    ['opacity:0'],
    ['transform:translateY(-100%)'],
    ['overflow:hidden'],
    ['clip-path:inset(0)'],
    ['pointer-events:none'],
    ['mix-blend-mode:multiply'],
    ['cursor:pointer'],
    ['content:"x"'],
  ])('drops %s', (declaration) => {
    expect(styles(`<div style="${declaration}">x</div>`)).toEqual([])
  })

  it('drops negative offsets on properties it otherwise allows', () => {
    expect(styles('<div style="margin-left:-9999px">x</div>')).toEqual([])
    expect(styles('<div style="margin:0 0 0 -100px">x</div>')).toEqual([])
    expect(styles('<div style="padding-top:calc(100% - 8px)">x</div>')).toEqual([])
  })

  it.each([
    ['100vw'],
    ['100vh'],
    ['50dvh'],
    ['10svmin'],
    ['80lvw'],
  ])('drops width sized in %s', (value) => {
    expect(styles(`<div style="width:${value}">x</div>`)).toEqual([])
  })

  it('keeps a container-relative size, which is what mail actually lays out with', () => {
    // A bare `<td>` is dropped by the HTML parser itself — the table has to be whole.
    expect(styles('<table><tr><td style="width:600px">x</td></tr></table>')).toEqual([
      'width:600px',
    ])
    expect(styles('<img style="max-width:100%" alt="">')).toEqual(['max-width:100%'])
  })

  it('keeps the allowed declarations of a mixed style and drops only the rest', () => {
    expect(styles('<span style="color:#c00;position:fixed;font-weight:bold">x</span>')).toEqual([
      'color:#c00;font-weight:bold',
    ])
  })

  it('refuses an escaped property spelling rather than resolving it (fail closed)', () => {
    expect(styles('<div style="posi\\74 ion:fixed">x</div>')).toEqual([])
  })

  it('refuses a value whose sign or digits hide behind a CSS escape', () => {
    expect(styles('<div style="margin-left:\\2d 9999px">x</div>')).toEqual([])
    expect(styles('<div style="margin-top:-\\39 9px">x</div>')).toEqual([])
  })

  /**
   * The divergence from mail-html's splitter. A browser ends the unterminated string at the newline
   * and applies `position:fixed`; a splitter that does not would hand the whole run to the
   * allowlisted `font-family` and keep the overlay inside it.
   */
  it('does not let a newline-terminated string fuse a rejected declaration into an allowed one', () => {
    const html = '<div style="font-family:\'x\n;position:fixed;top:0">x</div>'
    const out = styles(html)
    expect(out.join('')).not.toContain('position')
    expect(out.join('')).not.toContain('top:0')
  })

  it('keeps a top-level url() decision alone — that is mail-html’s call, not this pass’s', () => {
    expect(styles('<div style="background-image:url(\'blob:x\')">x</div>')).toEqual([
      "background-image:url('blob:x')",
    ])
  })
})

/**
 * Every fixture here puts real content FIRST, and that is not cosmetic: the HTML parser hoists a
 * LEADING `<style>`/`<script>`/`<link>`/`<meta>`/`<template>` into `<head>`, where `body.innerHTML`
 * never sees it — a fixture that starts with one passes whether or not this module drops anything.
 * (Caught by mutation: removing `'style'` from `DROP_TAGS` left the leading-`<style>` version green.)
 */
describe('sanitizeQuotedHtml — elements', () => {
  it('deletes a stylesheet, however it is smuggled in', () => {
    expect(sanitizeQuotedHtml('<div>x</div><style>div{position:fixed;inset:0}</style>')).toBe(
      '<div>x</div>',
    )
    expect(sanitizeQuotedHtml('<p>x</p><svg><style>div{position:fixed}</style></svg>')).toBe(
      '<p>x</p>',
    )
    expect(sanitizeQuotedHtml('<p>x</p><math><mtext>m</mtext></math>')).toBe('<p>x</p>')
  })

  it('deletes input widgets but unwraps their containers, keeping the quoted text', () => {
    const out = sanitizeQuotedHtml(
      '<form action="https://evil.tld"><p>Session expired</p><input name="password"><textarea></textarea><select><option>a</option></select><button>Sign in</button></form>',
    )
    expect(out).toBe('<p>Session expired</p>Sign in')
  })

  it('deletes script and frame-like elements', () => {
    expect(sanitizeQuotedHtml('<p>x</p><script>alert(1)</script>')).toBe('<p>x</p>')
    expect(sanitizeQuotedHtml('<p>x</p><iframe src="https://evil.tld"></iframe>')).toBe('<p>x</p>')
  })

  it('drops contenteditable so a quote cannot plant an uneditable island in the reply', () => {
    expect(sanitizeQuotedHtml('<div contenteditable="false">x</div>')).toBe('<div>x</div>')
  })
})

/**
 * The counter-test, and it is not a formality: a quote sanitizer that eats ordinary formatting turns
 * every reply into a wall of unstyled text, which is how a measure like this gets reverted.
 */
describe('sanitizeQuotedHtml — replies still look like replies', () => {
  it('preserves ordinary quoted formatting untouched', () => {
    const quote =
      '<p style="color:#333;font-family:Georgia,serif">Hello <b>there</b>, <i>see</i> ' +
      '<a href="https://example.test/x" style="color:#06c;text-decoration:underline">the link</a></p>' +
      '<table style="border-collapse:collapse"><tr><td style="padding:4px;border:1px solid #ccc">' +
      'cell</td></tr></table><blockquote style="margin-left:8px">older</blockquote>' +
      '<img src="cid:x" alt="logo" style="width:120px">'
    const out = sanitizeQuotedHtml(quote)
    expect(out).toContain('style="color:#333;font-family:Georgia,serif"')
    expect(out).toContain('<b>there</b>')
    expect(out).toContain('href="https://example.test/x"')
    expect(out).toContain('style="color:#06c;text-decoration:underline"')
    expect(out).toContain('style="border-collapse:collapse"')
    expect(out).toContain('style="padding:4px;border:1px solid #ccc"')
    expect(out).toContain('style="margin-left:8px"')
    expect(out).toContain('style="width:120px"')
    expect(out).toContain('src="cid:x"')
  })

  it('leaves HTML with no styles and no widgets byte-identical', () => {
    const plain = '<p>Hi Bob,</p><p>thanks — see you Tuesday.</p><ul><li>one</li><li>two</li></ul>'
    expect(sanitizeQuotedHtml(plain)).toBe(plain)
  })
})
