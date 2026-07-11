import { describe, expect, it } from 'vitest'
import { cleanOutgoingHtml } from './clean-html'

describe('cleanOutgoingHtml', () => {
  it('strips Squire editor-only classes but keeps the inline style', () => {
    expect(cleanOutgoingHtml('<span class="size" style="font-size:14px">x</span>')).toBe(
      '<span style="font-size:14px">x</span>',
    )
    expect(cleanOutgoingHtml('<span class="color" style="color:red">x</span>')).toBe(
      '<span style="color:red">x</span>',
    )
  })

  it('keeps non-editor classes, dropping only the editor tokens', () => {
    expect(cleanOutgoingHtml('<span class="foo size bar">x</span>')).toBe(
      '<span class="foo bar">x</span>',
    )
  })

  it('preserves genuine formatting markup', () => {
    expect(cleanOutgoingHtml('<b>bold</b> and <i>italic</i>')).toBe('<b>bold</b> and <i>italic</i>')
  })

  it('removes contenteditable attributes', () => {
    expect(cleanOutgoingHtml('<div contenteditable="true">x</div>')).toBe('<div>x</div>')
  })

  it('drops Squire selection bookmarks', () => {
    expect(
      cleanOutgoingHtml(
        '<span id="squire-selection-start"></span>hello<span id="squire-selection-end"></span>',
      ),
    ).toBe('hello')
  })

  it('strips zero-width spaces', () => {
    expect(cleanOutgoingHtml('<p>a\u200Bb</p>')).toBe('<p>ab</p>')
  })
})
