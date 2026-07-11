import { describe, expect, it } from 'vitest'
import { sanitizeSnippet } from './snippet'

describe('sanitizeSnippet', () => {
  it('preserves bare <mark> highlight tags', () => {
    expect(sanitizeSnippet('the <mark>quarterly</mark> report')).toBe(
      'the <mark>quarterly</mark> report',
    )
  })

  it('neutralizes injected markup entirely', () => {
    expect(sanitizeSnippet('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    )
  })

  it('drops attributes on a mark tag (only the bare tag is re-allowed)', () => {
    const out = sanitizeSnippet('<mark onclick="steal()">x</mark>')
    expect(out).toBe('&lt;mark onclick=&quot;steal()&quot;&gt;x</mark>')
    expect(out).not.toContain('onclick="')
  })

  it('escapes ampersands and stray angle brackets in surrounding text', () => {
    expect(sanitizeSnippet('A & B < C')).toBe('A &amp; B &lt; C')
  })

  it('handles an empty string', () => {
    expect(sanitizeSnippet('')).toBe('')
  })
})
