/**
 * The SHIPPED app CSP — index.html's <meta> policy and the dev server's mirror of it.
 *
 * Both are plain text nothing type-checks, and both govern documents no unit test renders: a
 * srcdoc mail frame and a blob: attachment preview inherit the EMBEDDER's policy container, so
 * the outer policy silently vetoes decisions made further in. Two regressions found that way:
 *
 *  - `img-src 'self' data: blob:` (no https:) made "load remote content" dead in every build.
 *    mail-html's `framePolicy` widens the INNER img-src to https: for one message; under CSP3
 *    multiple policies are enforced independently, so the outer one still blocked the load —
 *    banner gone, `naturalWidth` 0, no image, no way for an operator to repair it (a response
 *    header can only tighten). Inline `cid:` parts become blob: and kept working, which is why
 *    it went unnoticed.
 *  - `frame-src 'self'` does not cover blob:, so the PDF attachment preview
 *    (`<iframe src={URL.createObjectURL(blob)} sandbox="">`) was blocked outright: an empty
 *    panel under aria-expanded="true".
 *
 * Runs in the Node "unit" project (the *.shipped.test.ts family): it reads both files from disk,
 * which the jsdom project cannot do — and reading them from disk is the point, since what ships
 * is the text, not an import.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const indexHtml = readFileSync(join(APP_ROOT, 'index.html'), 'utf8')
const viteConfig = readFileSync(join(APP_ROOT, 'vite.config.ts'), 'utf8')

/** directive name → its source list, from a `a 'b'; c 'd'` policy string. */
function directives(policy: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name !== undefined && name !== '') out.set(name, sources.join(' '))
  }
  return out
}

const prod = directives(/content="([^"]*default-src[^"]*)"/.exec(indexHtml)?.[1] ?? '')

// The DEV_CSP array literal in vite.config.ts, read as text: importing the config would pull in
// the React and PWA plugins for two string assertions.
const devSource = /const DEV_CSP = \[([\s\S]*?)\]\.join/.exec(viteConfig)?.[1] ?? ''
const dev = directives(
  // Whole quoted elements only: a directive's own `'self'` sits inside the double quotes, so a
  // lazy any-quote match would tear each entry in half and quietly yield an empty policy.
  [...devSource.matchAll(/"([^"]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2]).join('; '),
)

describe('the shipped app CSP', () => {
  it('parses both policies (the assertions below can go vacuous)', () => {
    // A renamed file, a reformatted <meta> or a DEV_CSP rewritten as a template string would
    // otherwise leave two empty maps and make every `toContain` below trivially true.
    expect(prod.size).toBeGreaterThan(8)
    expect(dev.size).toBeGreaterThan(8)
  })

  it('allows https: images, so the frame CSP owns the remote-content decision', () => {
    // NOT a weakening of the default: the sanitizer strips remote src/srcset/CSS urls before the
    // HTML reaches the frame, and the frame's own policy re-blocks them per message. This
    // directive can only ever have said "no" to BOTH cases at once.
    expect(prod.get('img-src')).toContain('https:')
    expect(dev.get('img-src')).toContain('https:')
  })

  it('allows blob: frames, so the PDF attachment preview can render', () => {
    // `'self'` does not cover blob: — the object URL has an opaque origin.
    expect(prod.get('frame-src')).toContain('blob:')
    expect(dev.get('frame-src')).toContain('blob:')
  })

  it('keeps frame-src otherwise narrow: no http(s):, no wildcard', () => {
    // `about:srcdoc` is covered by 'self'. Anything beyond that would let injected markup frame
    // an attacker page inside the app's own origin chrome.
    expect(prod.get('frame-src')).toBe("'self' blob:")
    expect(dev.get('frame-src')).toBe("'self' blob:")
  })

  it('keeps script-src fully strict — none of the above touches it', () => {
    expect(prod.get('script-src')).toBe("'self'")
    expect(prod.get('object-src')).toBe("'none'")
  })

  it('keeps the dev mirror in step with production for the frame-facing directives', () => {
    // Dev is deliberately looser for script-src/connect-src (HMR), but a divergence in these two
    // means a feature works under `pnpm dev` and is dead in the bundle, or the reverse.
    expect(dev.get('img-src')).toBe(prod.get('img-src'))
    expect(dev.get('frame-src')).toBe(prod.get('frame-src'))
  })
})
