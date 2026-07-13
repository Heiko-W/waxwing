/**
 * The Waxwing service worker (M3.5/M3.6, FR-OFF-01, tech-stack §6). Bundled by `vite-plugin-pwa`'s
 * `injectManifest` strategy, so it is ordinary TypeScript with real imports.
 *
 * It compiles in its own program (`tsconfig.sw.json`, `lib: ["ES2023","WebWorker"]`, `types: []`)
 * because the worker globals and the DOM globals cannot coexist in one `lib`. Two consequences, both
 * load-bearing: NO test file may live in this directory, and every module reachable from here — even
 * through a type-only import — must itself be DOM-free. Everything worth testing is a pure function in
 * `src/pwa/sw-routes.ts` and `src/notify/click-route.ts`, imported here and asserted there; this file
 * is glue.
 *
 * What it does NOT do, deliberately:
 *  - **No `skipWaiting()` at install** and **no `clientsClaim()`**. A new worker that activates
 *    under a live tab drops the old precache, so the tab's next lazy route chunk 404s → white
 *    screen. The only path to `skipWaiting()` is the SKIP_WAITING message the page sends after the
 *    user clicked "Reload" (src/pwa/use-update-prompt.ts).
 *  - **No route that can match a JMAP path.** Unmatched requests get no `respondWith` at all and go
 *    straight to the network. Every route below is anchored to the app's own directory — see the
 *    invariant in sw-routes.ts, which also explains why an anchor rather than a denylist.
 *  - **No `push` listener, and no Web Push at all.** M3.5 expected M3.6 to add one; M3.6 established
 *    that it could not work. No JMAP server signs a browser push (RFC 9749/VAPID), and Stalwart also
 *    base64-wraps the aes128gcm body, so the `push` event never fires in ANY browser — see ADR-010.
 *    Notifications are raised by the PAGE, from the live push channel, and the worker's only part in
 *    them is the `notificationclick` handler at the bottom of this file.
 */

/// <reference lib="webworker" />

import { ExpirationPlugin } from 'workbox-expiration'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  type PrecacheEntry,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { NetworkFirst, StaleWhileRevalidate, type Strategy } from 'workbox-strategies'
import {
  isAppClient,
  NOTIFY_CLICK,
  type NotifyClickMessage,
  notificationTargetHref,
  notificationTargetPath,
} from '../notify/click-route'
import {
  appRoot,
  BRANDING_FILES,
  DEPLOYMENT_FILES,
  isBrandingAsset,
  isDeploymentConfig,
  navigateDenylist,
  SKIP_WAITING,
} from '../pwa/sw-routes'

declare let self: ServiceWorkerGlobalScope & {
  /** The precache manifest, injected at build time by vite-plugin-pwa. */
  __WB_MANIFEST: (PrecacheEntry | string)[]
}

const DAYS_30 = 30 * 24 * 60 * 60

/** `/` at the root, `/mail/` under a Stalwart mount. Every route and the warm-up hang off this. */
const ROOT = appRoot(self.location.href)

/**
 * Workbox's own declarations trip `exactOptionalPropertyTypes`: `ExpirationPlugin` declares its
 * lifecycle hooks as `hook?: Callback | undefined` while `WorkboxPlugin` declares them as
 * `hook?: Callback`. The classes are compatible — only the declaration style differs — so the
 * assertion is narrow and deliberate rather than a reason to weaken the compiler for this program.
 */
type StrategyPlugin = NonNullable<
  NonNullable<ConstructorParameters<typeof NetworkFirst>[0]>['plugins']
>[number]

const expireAfter30Days = (maxEntries: number): StrategyPlugin =>
  new ExpirationPlugin({ maxEntries, maxAgeSeconds: DAYS_30 }) as StrategyPlugin

// config.json / theme.css / manifest.json: a hoster edits these in the deployed directory with no
// rebuild (FR-DEP-04), so the network always wins — but a cached copy still boots the app offline.
// The 3 s network timeout keeps a captive portal from stalling the boot.
const deploymentCache = new NetworkFirst({
  cacheName: 'waxwing-deploy',
  networkTimeoutSeconds: 3,
  plugins: [expireAfter30Days(8)],
})

// branding/**: logo, favicon and the app icons. Stale-while-revalidate — the installed app paints
// its icon instantly and picks up a rebrand on the next load.
const brandingCache = new StaleWhileRevalidate({
  cacheName: 'waxwing-branding',
  plugins: [expireAfter30Days(16)],
})

// The app shell: index.html + the hashed assets/** chunks (pwa-options.ts). Content-addressed, so a
// deploy invalidates them wholesale; the outdated-cache sweep removes precaches from older Workbox
// revisions of this same origin.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Every in-app navigation (deep links like /mail/inbox/42) is answered from the precached shell, so
// an installed app opens offline. `createHandlerBoundToURL` resolves 'index.html' against the
// worker's own location — never a leading-slash literal — which keeps a `/mail/` mount working.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: navigateDenylist(ROOT) }),
)

registerRoute(({ url, sameOrigin }) => isDeploymentConfig(url, sameOrigin, ROOT), deploymentCache)
registerRoute(({ url, sameOrigin }) => isBrandingAsset(url, sameOrigin, ROOT), brandingCache)

/**
 * Fill the runtime caches at INSTALL, not on first use.
 *
 * A runtime cache is written by the `fetch` handler, and the `fetch` handler only ever sees the
 * requests of pages this worker CONTROLS. The page that registers it is not one of them (there is no
 * `clientsClaim()`, and rightly so), so the entire first session goes straight to the network and
 * leaves both caches empty. The first *controlled* load is then, typically, the first launch of the
 * freshly installed app — which is exactly the moment the user is likely to be offline. It would
 * find no config.json, no theme.css and no icons, and boot as an unbranded "Waxwing" on the built-in
 * defaults: FR-DEP-04 and FR-THEME-01/02 quietly defeated inside the very promise of FR-OFF-01.
 *
 * Best-effort by construction: `allSettled` over the strategies, so a 404 on an optional file (a
 * deployment that ships no theme.css) can never abort the install and cost us the precache. Going
 * through the strategies rather than `cache.put` keeps the expiration bookkeeping honest.
 */
self.addEventListener('install', (event) => {
  const warm = (strategy: Strategy, files: readonly string[]): Promise<Response>[] =>
    files.map((file) =>
      strategy.handle({
        request: new Request(new URL(file, self.location.href), { cache: 'reload' }),
        event,
      }),
    )

  event.waitUntil(
    Promise.allSettled([
      ...warm(deploymentCache, DEPLOYMENT_FILES),
      ...warm(brandingCache, BRANDING_FILES),
    ]),
  )
})

/**
 * The only message WE define: the page asks the WAITING worker to take over after the user accepted
 * the update toast.
 *
 * It is not the only message this worker answers, and the difference matters. `registerRoute()`
 * lazily builds workbox-routing's default `Router`, which installs its own `message` listener for
 * `CACHE_URLS` — so any same-origin script can also hand this worker a URL list to fetch and cache
 * through whichever route matches. There is no API to turn that off. What bounds it is that the
 * routes above are anchored to our own directory (sw-routes.ts): the worst `CACHE_URLS` can do is
 * make us re-fetch our own deployment files.
 */
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data: unknown = event.data
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === SKIP_WAITING
  ) {
    void self.skipWaiting()
  }
})

/**
 * A notification raised through THIS registration was clicked (M3.6): focus a window of ours and tell
 * it where to go; open one if we have none.
 *
 * `includeUncontrolled: true` is mandatory. There is no `clientsClaim()` (see the header), so the very
 * page that showed the notification is typically NOT controlled by this worker — a default `matchAll`
 * would not see it, and we would silently open a SECOND tab next to the one the user is looking at.
 * For the same reason the route travels by `postMessage` rather than `WindowClient.navigate()`: that
 * method rejects for an uncontrolled client.
 *
 * Every rule it applies (which route, which client is ours, how the mount prefix folds in) is a tested
 * pure function in `../notify/click-route` — this stays glue, because nothing in this directory can
 * have a test.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data: unknown = event.notification.data
  event.waitUntil(focusOrOpen(data))
})

async function focusOrOpen(data: unknown): Promise<void> {
  const path = notificationTargetPath(data)
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

  for (const client of windows) {
    if (!isAppClient(client.url, self.location.href)) continue
    try {
      // focus() first — it consumes the click's user activation, and a postMessage cannot get it back.
      const focused = await client.focus()
      focused.postMessage({ type: NOTIFY_CLICK, path } satisfies NotifyClickMessage)
      return
    } catch {
      // focus() is specified to reject without transient activation, and Android rejects it for a
      // client in another browser task. Uncaught, that rejection escapes waitUntil and takes the
      // openWindow fallback with it: the user clicks the notification and NOTHING happens at all.
      // Try the next window instead, and open a fresh one if none of them will take focus.
    }
  }

  await self.clients.openWindow(notificationTargetHref(ROOT, data))
}
