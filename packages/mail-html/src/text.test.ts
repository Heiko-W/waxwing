import { describe, expect, it } from 'vitest'
import { renderPlainText } from './text'

describe('renderPlainText', () => {
  it('escapes HTML so markup in the text cannot execute', () => {
    const html = renderPlainText('<script>alert(1)</script> & "quotes"')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;')
  })

  it('linkifies http(s) URLs with a safe rel and trims trailing punctuation', () => {
    const html = renderPlainText('See https://example.com/path?a=1, thanks.')
    expect(html).toContain('href="https://example.com/path?a=1"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).toContain('target="_blank"')
    // The trailing comma is not part of the link.
    expect(html).toContain('</a>,')
  })

  it('does not linkify javascript: or data: URLs (only http/https)', () => {
    const html = renderPlainText('javascript:alert(1) data:text/html,x')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('javascript:alert(1)"')
  })

  it('escapes ampersands inside a linkified URL query string', () => {
    const html = renderPlainText('https://example.com/?a=1&b=2')
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"')
    expect(html).not.toContain('a=1&b=2"')
  })

  it('folds quoted text into a native details/blockquote disclosure', () => {
    const html = renderPlainText('reply\n> quoted line\n> more', { quotedLabel: 'Quoted' })
    expect(html).toContain('<p>reply</p>')
    expect(html).toContain('<details class="waxwing-quote"><summary>Quoted</summary><blockquote>')
    expect(html).toContain('<p>quoted line<br>more</p>')
    expect(html).not.toContain('<script>')
  })

  it('nests deeper quote levels', () => {
    const html = renderPlainText('a\n> b\n>> c', { quotedLabel: 'Q' })
    // One outer disclosure containing an inner one for the second level.
    expect(html.match(/<details/g)?.length).toBe(2)
    expect(html).toContain('<p>c</p>')
  })

  it('joins consecutive plain lines with <br> inside a paragraph', () => {
    expect(renderPlainText('one\ntwo')).toContain('<p>one<br>two</p>')
  })

  it('caps quote nesting so thousands of > cannot overflow the recursion (security)', () => {
    // Would throw a RangeError (stack overflow) before the depth cap.
    const html = renderPlainText(`${'>'.repeat(5000)} deep`, { quotedLabel: 'Q' })
    expect((html.match(/<details/g) ?? []).length).toBeLessThanOrEqual(20)
  })
})
