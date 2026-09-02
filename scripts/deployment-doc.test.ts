/**
 * `docs/deployment.md` against the code it is a recipe for (R-45, R-111).
 *
 * Two drifts, both of which an operator pays for and neither of which anything could see:
 *
 *  - **The reverse-proxy blocks proxied three paths where Stalwart needs six.** The default
 *    `config.json` ranks OAuth first, so the prominent "Sign in" button starts an RFC 8414
 *    discovery request to `/.well-known/oauth-authorization-server` — which the recipe's
 *    `try_files` answered with `index.html`. Every operator who followed §2 to the letter shipped a
 *    dead primary sign-in button, and an account with a second factor could not sign in at all.
 *    The correct set is not a guess: it is the one the dev proxy and the E2E mount server use, and
 *    it is read from `e2e/mount-server.mjs` here rather than restated.
 *  - **The cache recipe protected two files where five are editable in place.** `theme.css`,
 *    `manifest.json` and `branding/` are deployment files by construction (`NEVER_PRECACHE`), and
 *    without a `Cache-Control` a browser may hold them for days on `Last-Modified` heuristics — so
 *    a rebrand that `theming.md` promises is a reload away silently is not.
 *
 * Both lists therefore come from the source, not from this file.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath: string) => readFileSync(join(ROOT, relativePath), 'utf8')

const DEPLOYMENT = read('docs/deployment.md')

/** The `## 2. Reverse proxy` section — both recipes and the notes under them. */
const SECTION_2 = DEPLOYMENT.slice(
  DEPLOYMENT.indexOf('## 2. Reverse proxy'),
  DEPLOYMENT.indexOf('### Serving from a subdirectory'),
)

/** `.` is a regex metacharacter and every path here has one; nothing else in them is. */
const escapeDots = (value: string) => value.replaceAll('.', '\\.')

/** One fenced block of the given language out of the section, by its opening fence. */
function block(language: string): string {
  const start = SECTION_2.indexOf(`\`\`\`${language}`)
  expect(start, `no \`\`\`${language} block in §2`).toBeGreaterThan(-1)
  return SECTION_2.slice(start, SECTION_2.indexOf('```', start + 3))
}

/** `const PROXY_PATHS = ['/jmap', …]` — the set verified against Stalwart v0.16.11. */
const PROXY_PATHS: string[] = (() => {
  const source = read('e2e/mount-server.mjs')
  const literal = /const PROXY_PATHS = \[([^\]]+)\]/.exec(source)?.[1]
  if (literal === undefined) throw new Error('PROXY_PATHS not found in e2e/mount-server.mjs')
  return [...literal.matchAll(/'([^']+)'/g)].map((match) => match[1] as string)
})()

/** `DEPLOYMENT_FILES` plus the branding tree — everything a hoster edits without a rebuild. */
const EDITABLE: string[] = (() => {
  const source = read('apps/web/src/pwa/sw-routes.ts')
  const literal = /export const DEPLOYMENT_FILES: readonly string\[\] = \[([^\]]+)\]/.exec(
    source,
  )?.[1]
  if (literal === undefined) throw new Error('DEPLOYMENT_FILES not found in sw-routes.ts')
  const files = [...literal.matchAll(/'([^']+)'/g)].map((match) => match[1] as string)
  // `MANIFEST_FILENAME` is a constant, not a literal, so it does not come out of the regex.
  const manifest = /const MANIFEST_FILENAME = '([^']+)'/.exec(source)?.[1]
  if (manifest === undefined) throw new Error('MANIFEST_FILENAME not found in sw-routes.ts')
  return [...files, manifest, 'branding/']
})()

describe('the reverse-proxy recipes in docs/deployment.md §2', () => {
  it('reads a non-empty path set from the mount server', () => {
    expect(PROXY_PATHS).toContain('/jmap')
    expect(PROXY_PATHS.length).toBeGreaterThanOrEqual(6)
  })

  it.each(PROXY_PATHS)('nginx forwards %s to Stalwart', (path) => {
    // `location /login` covers `/login`; `location /.well-known/` covers `/.well-known`. Accept
    // either the bare prefix or the prefix with a trailing slash, which is how nginx spells both.
    expect(block('nginx')).toMatch(new RegExp(`location ${escapeDots(path)}/?\\s`, 'm'))
  })

  it.each(PROXY_PATHS)('Caddy forwards %s to Stalwart', (path) => {
    expect(block('caddy')).toMatch(new RegExp(`handle ${escapeDots(path)}/?\\*?\\s`))
  })

  /**
   * The failure mode is specific enough to name: OAuth discovery answered with `index.html`. The
   * "Verifying a deployment" section is where an operator finds out before their users do.
   */
  it('tells the operator how to check OAuth discovery', () => {
    const verifying = DEPLOYMENT.slice(DEPLOYMENT.indexOf('## Verifying a deployment'))
    expect(verifying).toContain('/.well-known/oauth-authorization-server')
  })

  /** An operator who does not want to proxy the flow needs the supported alternative named. */
  it('names `auth: ["basic"]` as the alternative to proxying OAuth', () => {
    expect(SECTION_2).toContain('auth: ["basic"]')
  })
})

describe('the cache recipes in docs/deployment.md §2', () => {
  it('reads a non-empty editable set from the service worker routes', () => {
    expect(EDITABLE).toContain('config.json')
    expect(EDITABLE).toContain('theme.css')
    expect(EDITABLE.length).toBeGreaterThanOrEqual(4)
  })

  it.each(EDITABLE)('the nginx cache map keeps %s out of the browser cache', (file) => {
    // The map lives in the nginx block as a commented `map $uri $waxwing_cache_control { … }`,
    // whose keys are nginx regexes — so drop their backslashes before matching with one of ours.
    const map = block('nginx').replaceAll('\\', '')
    expect(map).toMatch(new RegExp(`\\^/${escapeDots(file)}.*"no-cache"`))
  })

  it.each(EDITABLE)('the Caddy recipe keeps %s out of the browser cache', (file) => {
    const caddy = block('caddy')
    expect(caddy).toContain(file.endsWith('/') ? `/${file}*` : `/${file}`)
    expect(caddy).toContain('Cache-Control "no-cache"')
  })

  /** `sw.js` is not a DEPLOYMENT_FILE — it is rebuilt — but it must never be cached either. */
  it('still covers the service worker', () => {
    expect(block('nginx')).toContain('~^/sw\\.js$')
    expect(block('caddy')).toContain('/sw.js')
  })
})
