/**
 * The URL contract shared by the service worker (`src/sw/sw.ts`), the plugin config
 * ({@link ./pwa-options}) and their tests (M3.5, FR-OFF-01, FR-DEP-06, tech-stack §6).
 *
 * It lives in its own module — free of `process`, free of the DOM — because it is compiled into
 * THREE programs with three different globals: the app bundle, the service-worker bundle
 * (`lib: WebWorker`, no `process`), and the Node-side Vite config. Anything the SW needs to decide
 * about a URL is a pure function here, so the security invariant below is testable without a browser.
 *
 * ## The invariant: the service worker caches ZERO bytes from JMAP
 * A service worker sees the fetches of every page it controls — **for any URL, in scope or not** —
 * and in the recommended deployment the JMAP server is same-origin as well. Nothing here may ever
 * match one of its requests:
 *  - `/jmap/download/**` returns AUTHENTICATED MAIL. Caching it would write plaintext mail into
 *    Cache Storage — outside the AES-GCM SecretStore (NFR-SEC-02), outside M3.4's eviction budget,
 *    and surviving a plain sign-out (only "sign out & remove data" clears Cache Storage).
 *  - `/jmap/eventsource` is a long-lived streaming `fetch` (packages/jmap/src/push/sse.ts). A
 *    strategy that awaits the response body would hang push forever.
 * Unmatched requests fall through with no `respondWith`, i.e. straight to the network.
 *
 * **The invariant is structural, not a denylist of guessed paths.** Every cache predicate is anchored
 * to the app's OWN deployment directory — the service worker's scope, which it reads from its own
 * location — so a URL can only be cached if it *is* one of our deployment files. The path of a JMAP
 * download is chosen by the SERVER and its last segment is the attachment filename, chosen by whoever
 * sent the mail; a basename test ("does it end in config.json?") would hand a mail attachment named
 * `config.json` straight into the cache on any server that does not happen to serve downloads under
 * `/jmap/`. FR-SRV-01 promises "any JMAP server", so that is not a guarantee we get to assume.
 *
 * This also bounds `CACHE_URLS`: workbox-routing's default router installs its own `message` listener
 * (`Router.addCacheListener`), so ANY same-origin script can hand the worker a list of URLs to fetch
 * and cache *through whichever route matches*. There is no public API to switch it off — the mitigation
 * is that the routes below cannot be steered anywhere outside our own directory.
 */

/** The service-worker script, relative to the app root. Registered as a CLASSIC worker (the bundle has no ESM syntax). */
export const SW_FILENAME = 'sw.js'

/**
 * The web app manifest. Deliberately `.json`, NOT `.webmanifest`: Stalwart serves an unknown
 * extension as `application/octet-stream` (SP.5), which browsers refuse to parse as a manifest.
 */
export const MANIFEST_FILENAME = 'manifest.json'

/** The page → SW message that lets a WAITING worker take over. The only one WE define. */
export const SKIP_WAITING = 'SKIP_WAITING'

/**
 * Deployment files a hoster may edit without a rebuild (FR-DEP-04, tech-stack §6): they are NEVER
 * precached, or a rebrand would be pinned to the release that built it. They are served
 * network-first at runtime instead, so an edit lands on the next load and a cached copy still boots
 * the app offline. `manifest.json` is in this list for the same reason: name, colors and icons are
 * white-label surface.
 */
export const DEPLOYMENT_FILES: readonly string[] = ['config.json', 'theme.css', 'manifest.json']

/** The same set, as globs for `globIgnores` (the whole `branding/` tree is excluded wholesale). */
export const NEVER_PRECACHE: readonly string[] = [...DEPLOYMENT_FILES, 'branding/**']

/**
 * The branding files shipped in the box. The worker WARMS these (and {@link DEPLOYMENT_FILES}) at
 * install, because a runtime cache is otherwise filled only by the pages the worker CONTROLS — and
 * the page that registers it is not one of them. Without the warm-up the first controlled load is
 * typically the first OFFLINE launch of the freshly installed app, which would then find both caches
 * empty and boot on the built-in defaults: no hoster branding, no theme override, no icons.
 *
 * A hoster who points `branding.logo` somewhere else in config.json is not covered by the warm-up —
 * their file is cached on first use like any other, which is one online load away.
 */
export const BRANDING_FILES: readonly string[] = [
  'branding/favicon.svg',
  'branding/logo.svg',
  'branding/icon-192.png',
  'branding/icon-512.png',
  'branding/icon-maskable-512.png',
  'branding/apple-touch-icon-180.png',
]

/** The app's own directory, from the worker's own URL: `/` at the root, `/mail/` under a Stalwart mount. */
export function appRoot(workerHref: string): string {
  return new URL('./', workerHref).pathname
}

/**
 * `config.json` / `theme.css` / `manifest.json` — **in our deployment directory and nowhere else**.
 * An exact path, not a basename: see the module header on why `/…/download/<blob>/config.json` must
 * not be cacheable.
 */
export function isDeploymentConfig(url: URL, sameOrigin: boolean, root: string): boolean {
  if (!sameOrigin) return false
  return DEPLOYMENT_FILES.some((file) => url.pathname === root + file)
}

/** Logo, favicon and app icons from the hoster-editable `branding/` directory — StaleWhileRevalidate. */
export function isBrandingAsset(url: URL, sameOrigin: boolean, root: string): boolean {
  return sameOrigin && url.pathname.startsWith(`${root}branding/`)
}

/** Server paths that are NOT the app: JMAP, RFC 8414/OIDC discovery, the OAuth endpoints, Stalwart's login SPA. */
const RESERVED_SEGMENTS = ['jmap', '\\.well-known', 'auth', 'login', 'api']

/** Anything that already names a file (`/branding/logo.svg`, `/assets/index-abc.js`) is not a navigation. */
const HAS_EXTENSION = /^[^?]*\.[a-z0-9]{1,8}(?:$|\?)/i

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Paths a navigation must NOT be answered for with the precached `index.html`. Workbox tests these
 * against `url.pathname + url.search`, so `HAS_EXTENSION` is anchored and stops at the query string —
 * a search URL like `/mail/inbox?q=from:a.b@c.de` must still resolve to the app shell offline.
 *
 * The reserved segments are anchored to the app ROOT rather than matched anywhere in the path. Left
 * unanchored, a mailbox whose server-assigned JMAP Id happens to be `api` or `auth` (both legal — RFC
 * 8620 Ids are `[A-Za-z0-9_-]`) would produce `/mail/api`, and the app's own deep link would be denied
 * the shell: offline, reloading that message would show the browser's offline page.
 */
export function navigateDenylist(root: string): RegExp[] {
  const prefix = escapeForRegExp(root)
  return [new RegExp(`^${prefix}(?:${RESERVED_SEGMENTS.join('|')})(?:/|$)`), HAS_EXTENSION]
}

/**
 * A request to the JMAP API (session, calls, upload, download, push). Nothing in the service worker
 * may cache one; this predicate exists so the guard test can prove it (see the module header).
 */
export function isJmapRequest(url: URL): boolean {
  return /(^|\/)jmap(\/|$)/.test(url.pathname)
}
