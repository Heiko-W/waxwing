/**
 * Direct security tests for the inline-`style` sanitizer (M1.7 review hardening). These exercise
 * `sanitizeStyle` on RAW attacker CSS — NOT through `sanitize()`+jsdom, because jsdom normalizes the
 * `style` attribute value and would mask the very escape/ReDoS/`image-set` attacks under test.
 */

import { describe, expect, it } from 'vitest'
import { type Collector, sanitizeStyle } from './sanitize'

function run(
  css: string,
  allowRemote = false,
): { value: string; drop: boolean; collector: Collector } {
  const collector: Collector = { blocked: [], hasRemote: false }
  const result = sanitizeStyle(css, 'div', { allowRemote }, collector)
  return { ...result, collector }
}

describe('sanitizeStyle — inline CSS firewall (security regression)', () => {
  it('does not catastrophically backtrack on a long unterminated url( (ReDoS)', () => {
    const payload = `background:url(${' '.repeat(6000)}`
    const start = performance.now()
    run(payload)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(500) // was cubic / multi-second before the fix
  })

  it('blocks a remote url() and records it', () => {
    const { value, collector } = run('background:url(https://evil.example/x)')
    expect(value).not.toContain('evil.example')
    expect(collector.hasRemote).toBe(true)
    expect(collector.blocked.length).toBeGreaterThan(0)
  })

  it('sees through CSS hex-escaped schemes ( \\68 ttps: ) and blocks them', () => {
    const { value, drop, collector } = run('background:url(\\68 ttps://evil.example/x)')
    // Either the url() is neutralized to url('') or the whole style is dropped — never a live URL.
    expect(value).not.toContain('evil.example')
    expect(drop || value === "background:url('')").toBe(true)
    expect(collector.hasRemote).toBe(true)
  })

  it('drops styles using image-set()/cross-fade() (bare-string remote images)', () => {
    expect(run("background-image:image-set('https://evil.example/x' 1x)").drop).toBe(true)
    expect(
      run('background:-webkit-cross-fade(url(https://evil.example/a), url(b), 50%)').drop,
    ).toBe(true)
  })

  it('fails closed on a malformed/unbalanced url( that leaves a remote scheme', () => {
    const { value, drop } = run('background:url(https://evil.example/a')
    expect(value).not.toContain('evil.example')
    expect(drop).toBe(true)
  })

  it('drops code-bearing CSS (expression / -moz-binding / @import / behavior)', () => {
    expect(run('width:expression(alert(1))').drop).toBe(true)
    expect(run('-moz-binding:url(https://evil/x)').drop).toBe(true)
    expect(run('@import "https://evil/x"').drop).toBe(true)
    expect(run('behavior:url(#default#time2)').drop).toBe(true)
  })

  it('keeps a benign style untouched', () => {
    const { value, drop, collector } = run('color:#333;font-weight:bold')
    expect(drop).toBe(false)
    expect(value).toBe('color:#333;font-weight:bold')
    expect(collector.hasRemote).toBe(false)
  })

  it('resolves a cid url() through the resolver to a blob: URL', () => {
    const collector: Collector = { blocked: [], hasRemote: false }
    const result = sanitizeStyle(
      'background:url(cid:logo)',
      'div',
      { resolveCid: (id) => (id === 'logo' ? 'blob:https://app/xyz' : null) },
      collector,
    )
    expect(result.drop).toBe(false)
    expect(result.value).toContain("url('blob:https://app/xyz')")
  })
})
