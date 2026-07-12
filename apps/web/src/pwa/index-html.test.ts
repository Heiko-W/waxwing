import { describe, expect, it } from 'vitest'
// The shipped shell, verbatim: none of this survives a jsdom render, and all of it is load-bearing
// for the service worker (scope, start_url and navigateFallback all resolve through document.baseURI).
import indexHtml from '../../index.html?raw'

describe('index.html — the deployment contract', () => {
  it('carries the LITERAL <base href="/"> token Stalwart rewrites to the mount prefix (SP.5)', () => {
    // Double quotes, root path, exactly this shape — Stalwart pattern-matches the token.
    expect(indexHtml).toContain('<base href="/" />')
    // …and it is the ONLY one in the file. A lookalike in a comment (they sort earlier) could be
    // rewritten instead, leaving the real tag at the root and every asset 404ing under a prefix.
    expect(indexHtml.match(/<base/g) ?? []).toHaveLength(1)
  })

  it('declares the apple-touch-icon: iOS ignores the manifest icons for Add to Home Screen', () => {
    expect(indexHtml).toMatch(
      /<link rel="apple-touch-icon" href="branding\/apple-touch-icon-180\.png"/,
    )
  })

  it('follows the OS theme in the browser chrome (the manifest theme_color cannot)', () => {
    expect(indexHtml).toMatch(/name="theme-color"[^>]*media="\(prefers-color-scheme: light\)"/)
    expect(indexHtml).toMatch(/name="theme-color"[^>]*media="\(prefers-color-scheme: dark\)"/)
  })

  it('links the manifest RELATIVELY, so a mount prefix resolves it through <base href>', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="manifest.json" />')
    // An absolute href would break every prefixed deployment.
    expect(indexHtml).not.toMatch(/rel="manifest" href="\//)
  })
})

describe('index.html — the CSP still permits the worker and the manifest', () => {
  const csp = /content="([^"]*default-src[^"]*)"/.exec(indexHtml)?.[1] ?? ''

  it('has a same-origin default-src, and declares NO worker-src/manifest-src to narrow it', () => {
    expect(csp).toContain("default-src 'self'")
    // Absent, they fall back to default-src 'self' — which is exactly what a same-origin service
    // worker and a same-origin manifest need. A declared-but-wrong directive would silently break both.
    expect(csp).not.toContain('worker-src')
    expect(csp).not.toContain('manifest-src')
  })

  it("keeps base-uri 'self', which is what permits the <base href> above", () => {
    expect(csp).toContain("base-uri 'self'")
  })
})
