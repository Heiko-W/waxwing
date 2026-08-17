import { describe, expect, it } from 'vitest'
import {
  appRoot,
  BRANDING_FILES,
  DEPLOYMENT_FILES,
  isBrandingAsset,
  isDeploymentConfig,
  isJmapRequest,
  NEVER_PRECACHE,
  navigateDenylist,
} from './sw-routes'

const ORIGIN = 'https://mail.example.com'
const at = (path: string, origin = ORIGIN): URL => new URL(path, origin)

/** The two deployments the app promises to work under (FR-DEP-01 / FR-DEP-02). */
const ROOTS = ['/', '/mail/']

/** Workbox matches a NavigationRoute denylist against `pathname + search`. */
const denied = (path: string, root = '/'): boolean => {
  const url = at(path)
  return navigateDenylist(root).some((pattern) => pattern.test(url.pathname + url.search))
}

// The paths the service worker MUST NOT touch — same-origin in the recommended deployment, and a
// worker sees the fetches of every page it controls whether or not they are in scope.
// `/jmap/download/**` is authenticated mail; `/jmap/eventsource` is a long-lived stream.
const JMAP_PATHS = [
  '/jmap',
  '/jmap/',
  '/jmap/download/acc/blob-1/report.pdf',
  '/jmap/upload/acc',
  '/jmap/eventsource',
  '/jmap/ws',
  '/.well-known/jmap',
  '/auth/token',
]

describe('sw-routes — the JMAP invariant', () => {
  it('caches ZERO bytes from JMAP: no runtime-cache predicate matches any JMAP or auth path', () => {
    for (const root of ROOTS) {
      for (const path of JMAP_PATHS) {
        expect(isDeploymentConfig(at(path), true, root), `${root} ${path}`).toBe(false)
        expect(isBrandingAsset(at(path), true, root), `${root} ${path}`).toBe(false)
      }
    }
  })

  it('does not cache an ATTACHMENT that merely happens to be named like a deployment file', () => {
    // The filename in a download URL is chosen by whoever SENT the mail. A basename match would hand
    // an authenticated attachment straight into Cache Storage — plaintext, outside the SecretStore,
    // outside M3.4's eviction budget, and surviving a plain sign-out.
    for (const root of ROOTS) {
      expect(isDeploymentConfig(at('/jmap/download/acc/b1/config.json'), true, root)).toBe(false)
      expect(isDeploymentConfig(at('/jmap/download/acc/b1/manifest.json'), true, root)).toBe(false)
      expect(isBrandingAsset(at('/jmap/download/acc/b1/branding/logo.svg'), true, root)).toBe(false)
    }
  })

  it('…and not even on a server that serves downloads OUTSIDE /jmap (FR-SRV-01: any JMAP server)', () => {
    // This is why the predicates are anchored to the app's own directory instead of denying a list
    // of guessed path segments: the download path comes from the SERVER's session object. A JMAP
    // server that serves blobs from /download/** would defeat any such denylist.
    for (const root of ROOTS) {
      expect(isDeploymentConfig(at('/download/acc/b1/config.json'), true, root)).toBe(false)
      expect(isDeploymentConfig(at('/files/theme.css'), true, root)).toBe(false)
      expect(isBrandingAsset(at('/download/acc/b1/branding/logo.svg'), true, root)).toBe(false)
    }
  })

  it('recognises every JMAP shape (the guard the tests above rely on)', () => {
    for (const path of JMAP_PATHS.filter((p) => p.includes('jmap'))) {
      expect(isJmapRequest(at(path)), path).toBe(true)
    }
    expect(isJmapRequest(at('/mail/inbox/42'))).toBe(false)
  })
})

describe('appRoot', () => {
  it('is the worker’s own directory — the app root under any mount prefix', () => {
    expect(appRoot(`${ORIGIN}/sw.js`)).toBe('/')
    expect(appRoot(`${ORIGIN}/mail/sw.js`)).toBe('/mail/')
  })
})

describe('isDeploymentConfig', () => {
  it('matches the hoster-editable files in the app’s OWN directory, at the root and under /mail/', () => {
    for (const root of ROOTS) {
      for (const file of DEPLOYMENT_FILES) {
        expect(isDeploymentConfig(at(root + file), true, root), `${root}${file}`).toBe(true)
      }
    }
  })

  it('matches nowhere else — not a subdirectory, not the other mount, not cross-origin', () => {
    expect(isDeploymentConfig(at('/mail/config.json'), true, '/')).toBe(false)
    expect(isDeploymentConfig(at('/config.json'), true, '/mail/')).toBe(false)
    expect(isDeploymentConfig(at('/config.json', 'https://cdn.example.net'), false, '/')).toBe(
      false,
    )
    expect(isDeploymentConfig(at('/index.html'), true, '/')).toBe(false)
    expect(isDeploymentConfig(at('/assets/index-abc123.js'), true, '/')).toBe(false)
  })

  it('covers exactly the non-glob files that are kept out of the precache', () => {
    for (const file of NEVER_PRECACHE.filter((entry) => !entry.includes('*'))) {
      expect(isDeploymentConfig(at(`/${file}`), true, '/'), file).toBe(true)
    }
  })
})

describe('isBrandingAsset', () => {
  it('matches the branding directory under either mount', () => {
    expect(isBrandingAsset(at('/branding/logo.svg'), true, '/')).toBe(true)
    expect(isBrandingAsset(at('/mail/branding/icon-192.png'), true, '/mail/')).toBe(true)
  })

  it('covers every icon the worker warms at install', () => {
    for (const file of BRANDING_FILES) {
      expect(isBrandingAsset(at(`/${file}`), true, '/'), file).toBe(true)
    }
  })

  it('never matches cross-origin, another mount, or a lookalike path', () => {
    expect(isBrandingAsset(at('/branding/logo.svg', 'https://cdn.example.net'), false, '/')).toBe(
      false,
    )
    expect(isBrandingAsset(at('/branding/logo.svg'), true, '/mail/')).toBe(false)
    expect(isBrandingAsset(at('/brandingx/logo.svg'), true, '/')).toBe(false)
  })

  /**
   * The anchor is a `startsWith` over the RAW pathname, and `URL` neither decodes `%2f`/`%2e` nor
   * collapses the dot segments they hide — while a reverse proxy in front (the nginx recipe in
   * docs/deployment.md decodes and normalises before it matches a location) does. Left alone, the
   * escaped traversals below stay "inside branding/" for us and are `/jmap/download/**` for the
   * server: authenticated mail written into Cache Storage, keyed by the encoded URL. Both mounts,
   * because the prefix is the only thing that differs between them.
   */
  it('does not let a percent-encoded traversal out of the branding directory', () => {
    for (const root of ROOTS) {
      for (const tail of [
        '%2e%2e%2f%2e%2e%2fjmap/download/acc/b1/x.pdf',
        '..%2f..%2fjmap/download/acc/b1/x.pdf',
        '%2E%2E%2Fjmap/download/acc/b1/x.pdf', // upper case decodes identically
        '%2fjmap/download/acc/b1/x.pdf', // a separator we never wrote
        'sub%2f..%2f..%2fjmap/x.pdf',
        '%252e%252e%252fjmap/x.pdf', // double-encoded: one decode leaves a `%` behind
        '%zz.svg', // malformed — nobody can say what a proxy makes of it
      ]) {
        expect(isBrandingAsset(at(`${root}branding/${tail}`), true, root), `${root}${tail}`).toBe(
          false,
        )
      }
    }
  })

  it('still caches an ordinary asset, including one in a subdirectory a hoster added', () => {
    for (const root of ROOTS) {
      expect(isBrandingAsset(at(`${root}branding/logo.svg`), true, root)).toBe(true)
      expect(isBrandingAsset(at(`${root}branding/custom/logo-dark.svg`), true, root)).toBe(true)
      // The directory itself is not an asset, and neither is a doubled separator.
      expect(isBrandingAsset(at(`${root}branding/`), true, root)).toBe(false)
      expect(isBrandingAsset(at(`${root}branding//logo.svg`), true, root)).toBe(false)
    }
  })

  /**
   * The sibling predicate needs none of this, and saying so keeps someone from "hardening" it into a
   * prefix test: an exact-equality comparison against a fixed list cannot be lengthened into a match
   * by any escape sequence.
   */
  it('isDeploymentConfig is immune by construction — it compares the WHOLE pathname', () => {
    for (const root of ROOTS) {
      expect(isDeploymentConfig(at(`${root}config.json%2f%2e%2e%2fjmap`), true, root)).toBe(false)
      expect(isDeploymentConfig(at(`${root}%2e%2e%2fconfig.json`), true, root)).toBe(false)
      expect(isDeploymentConfig(at(`${root}config.json`), true, root)).toBe(true)
    }
  })
})

describe('navigateDenylist', () => {
  it('answers app routes from the precached shell (that is what "offline" means)', () => {
    for (const path of ['/', '/mail', '/mail/inbox/42', '/settings', '/contacts']) {
      expect(denied(path), path).toBe(false)
    }
  })

  it('keeps a search URL navigable offline — the query string is not a file extension', () => {
    expect(denied('/mail/inbox?q=from:alice.smith@example.de')).toBe(false)
  })

  it('never answers a server path or a file with index.html', () => {
    for (const path of [
      '/jmap',
      '/jmap/eventsource',
      '/.well-known/jmap',
      '/auth/token',
      '/login',
      '/api/auth',
      '/branding/logo.svg',
      '/assets/index-abc123.js',
      '/config.json',
    ]) {
      expect(denied(path), path).toBe(true)
    }
  })

  it('denies a reserved path that carries a QUERY STRING — an OAuth redirect always does', () => {
    // Workbox matches the denylist against `pathname + search`. With `(?:/|$)` alone, `/login?...`
    // was NOT denied, so the worker answered the sign-in redirect from the precache: the user clicked
    // "Sign in securely" and got the app shell back instead of the server's login form. OAuth was
    // broken for every returning visitor (i.e. everyone whose worker had activated). Latent since
    // M3.5; the M1.9 OAuth E2E caught it once M3.7's re-chunking made the race deterministic.
    for (const path of [
      '/login?client_id=waxwing&redirect_uri=http%3A%2F%2Fhost%2F&response_type=code',
      '/auth/token?grant_type=authorization_code',
      '/auth?x=1',
      '/jmap?a=b',
      '/api?y=2',
      '/.well-known/openid-configuration?v=1',
    ]) {
      expect(denied(path), path).toBe(true)
    }
    expect(denied('/mail/login?x=1', '/mail/'), '/mail/login?x=1 under /mail/').toBe(true)
  })

  it('does not mistake a MAILBOX for a server path — the reserved words are anchored to the root', () => {
    // A JMAP Id is `[A-Za-z0-9_-]`, so a mailbox or message can legitimately be called `api` or
    // `auth`. Matched anywhere in the path, `/mail/api` would be denied the shell and, offline, a
    // reload of that mailbox would show the browser's offline page instead of the app.
    for (const path of ['/mail/api', '/mail/auth/login', '/mail/inbox/jmap']) {
      expect(denied(path), path).toBe(false)
    }
  })

  it('anchors to the mount prefix: the reserved paths are the SERVER’s, not the app’s', () => {
    expect(denied('/jmap', '/mail/')).toBe(false) // out of scope — a different worker's problem
    expect(denied('/mail/jmap', '/mail/')).toBe(true)
    expect(denied('/mail/inbox/42', '/mail/')).toBe(false)
  })
})
