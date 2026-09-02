import { describe, expect, it } from 'vitest'
import { htmlToPlainText, plainTextToHtml } from './html-to-text'

describe('htmlToPlainText', () => {
  it('returns empty for empty/blank input', () => {
    expect(htmlToPlainText('')).toBe('')
    expect(htmlToPlainText('   \n  ')).toBe('')
  })

  it('renders a single paragraph as its text', () => {
    expect(htmlToPlainText('<p>Hello world</p>')).toBe('Hello world')
  })

  it('separates blocks with a single blank line', () => {
    expect(htmlToPlainText('<p>First</p><p>Second</p>')).toBe('First\n\nSecond')
  })

  it('turns <br> into a line break', () => {
    expect(htmlToPlainText('<div>Line one<br>Line two</div>')).toBe('Line one\nLine two')
  })

  it('collapses runs of inline whitespace', () => {
    expect(htmlToPlainText('<p>a\n   b\t c</p>')).toBe('a b c')
  })

  it('marks unordered list items with "- "', () => {
    expect(htmlToPlainText('<ul><li>Apples</li><li>Pears</li></ul>')).toBe('- Apples\n- Pears')
  })

  it('numbers ordered list items', () => {
    expect(htmlToPlainText('<ol><li>One</li><li>Two</li><li>Three</li></ol>')).toBe(
      '1. One\n2. Two\n3. Three',
    )
  })

  it('indents nested lists two spaces per level', () => {
    const html = '<ul><li>Top<ul><li>Sub</li></ul></li></ul>'
    expect(htmlToPlainText(html)).toBe('- Top\n  - Sub')
  })

  it('prefixes blockquote lines with "> " and nests them', () => {
    expect(htmlToPlainText('<blockquote>Quoted</blockquote>')).toBe('> Quoted')
    expect(htmlToPlainText('<blockquote><blockquote>Deep</blockquote></blockquote>')).toBe(
      '> > Deep',
    )
  })

  it('renders a link as "text (href)" when the href adds information', () => {
    expect(htmlToPlainText('<p>See <a href="https://a.test/x">the docs</a></p>')).toBe(
      'See the docs (https://a.test/x)',
    )
  })

  it('renders a link once when the text already is the href', () => {
    expect(htmlToPlainText('<a href="https://a.test">https://a.test</a>')).toBe('https://a.test')
  })

  it('decodes HTML entities', () => {
    expect(htmlToPlainText('<p>Tom &amp; Jerry &lt;3</p>')).toBe('Tom & Jerry <3')
  })

  /*
   * R-58: this generates the `text/plain` alternative of every message the app sends, forwards and
   * quoted replies included. Collapsing whitespace under `<pre>` turned a forwarded code block into
   * one line, and cells with no separator turned an invoice table into a run-on word.
   */
  it('keeps the line breaks and the indentation of a <pre> block', () => {
    expect(htmlToPlainText('<pre>line1\nline2</pre>')).toBe('line1\nline2')
    expect(htmlToPlainText('<pre><code>const a = 1\n  const b = 2</code></pre>')).toBe(
      'const a = 1\n  const b = 2',
    )
  })

  it('keeps a <pre> a paragraph among its neighbours', () => {
    expect(htmlToPlainText('<p>Before</p><pre>a\n  b</pre><p>After</p>')).toBe(
      'Before\n\na\n  b\n\nAfter',
    )
  })

  it('collapses whitespace again after the <pre> ends', () => {
    // The flag is scoped to the block: a paragraph following one must not inherit it.
    expect(htmlToPlainText('<pre>a\nb</pre><p>c\n   d</p>')).toBe('a\nb\n\nc d')
  })

  it('separates table cells with a tab and rows with a line break', () => {
    expect(htmlToPlainText('<table><tr><td>Betrag</td><td>100 €</td></tr></table>')).toBe(
      'Betrag\t100 €',
    )
    expect(
      htmlToPlainText(
        '<table><thead><tr><th>Pos</th><th>Preis</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></tbody></table>',
      ),
    ).toBe('Pos\tPreis\nA\t1\nB\t2')
  })

  it('caps blank runs and trims edges', () => {
    expect(htmlToPlainText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb')
  })
})

describe('plainTextToHtml', () => {
  it('returns empty for empty input', () => {
    expect(plainTextToHtml('')).toBe('')
  })

  it('wraps each line in a block and escapes markup', () => {
    expect(plainTextToHtml('a & b\n<script>')).toBe('<div>a &amp; b</div><div>&lt;script&gt;</div>')
  })

  it('renders blank lines as <br> blocks', () => {
    expect(plainTextToHtml('a\n\nb')).toBe('<div>a</div><div><br></div><div>b</div>')
  })

  it('round-trips simple text through htmlToPlainText', () => {
    const text = 'Line one\nLine two'
    expect(htmlToPlainText(plainTextToHtml(text))).toBe(text)
  })
})
