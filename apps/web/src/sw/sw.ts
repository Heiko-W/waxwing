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
 *  - **No JMAP call, no access token, and no `SecretStore` access — including in the `push` handler.**
 *    This is the security property M4.0 was scoped around (ADR-017, owner decision D6a), not an
 *    accident of what has been built so far. The closed-app banner says only that mail arrived,
 *    which is exactly what a push can establish without asking anyone: the subscription is created
 *    with `types: ["EmailDelivery"]`, so the SERVER filters and a delivered push already means new
 *    mail. Everything the banner needs — the translated strings, the icon, quiet hours — is put in
 *    the `waxwing-push` database by the page (`notify/push-store.ts`), because this worker can run
 *    neither i18next nor Dexie. A future "sender and subject" banner (B28) would need a token in
 *    here; that is a separate owner decision with its own security review, and until it is taken,
 *    an import that reaches auth or JMAP from this file is a design error.
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
  PUSH_VERIFICATION,
  type PushVerificationMessage,
  parsePushFrame,
  shouldRaisePushBanner,
} from '../notify/push-frame'
import { putPendingVerification, readPushState } from '../notify/push-store'
import { localMinutesOfDay } from '../notify/quiet-hours'
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
 * Web Push arrived (M4.0, FR-NOTIF-02) — the app may be fully closed.
 *
 * Three frames, three answers, and the classification is a tested pure function
 * (`notify/push-frame.ts`) because nothing in this directory can have a test:
 *
 *  - **`delivery`** — mail arrived. Raise ONE contentless banner, unless a window of ours is already
 *    visible: in that case the live push channel is running and has already raised the richer banner
 *    with sender and subject, and a second one beside it is worse than none.
 *  - **`verification`** — RFC 8620 §7.2.2. Hand it to the page, which alone can write it back;
 *    park it in the database when no page is running, so the next start completes the handshake
 *    rather than leaving a subscription that is silent forever with nothing to say why.
 *  - **`stateChange` / `unknown`** — nothing. A `StateChange` without `EmailDelivery` means someone
 *    read a message on another device, which is not news.
 *
 * Whether a delivery becomes a banner is `shouldRaisePushBanner`, not an `if` chain down here: this
 * file cannot be tested, and "when do we stay silent" is four rules deep, including the one that
 * suppresses a banner while a window is visible because the live channel has already raised a better
 * one. Everything below is the doing.
 */
self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event.data === null ? null : event.data.text()))
})

/**
 * `renotify` is in the Notifications spec and shipped in Chromium and Firefox, but TypeScript's
 * `NotificationOptions` still omits it. `notify-model.ts` widens it the same way for the live
 * channel; that type cannot be imported here (it reaches `window`), so the widening is repeated
 * rather than the property dropped — without it a burst of arrivals replaces the banner silently.
 */
interface PushNotificationOptions extends NotificationOptions {
  renotify?: boolean
}

async function handlePush(text: string | null): Promise<void> {
  const frame = parsePushFrame(text)

  if (frame.kind === 'verification') {
    const message: PushVerificationMessage = {
      type: PUSH_VERIFICATION,
      pushSubscriptionId: frame.pushSubscriptionId,
      verificationCode: frame.verificationCode,
    }

    // **PARK IT FIRST, AND ALWAYS — before telling anyone.**
    //
    // This used to park only when no window was open, treating `postMessage` as the primary route
    // and the store as a fallback. That is backwards, and the B29 hand-check proved it on the first
    // run: a window WAS open, the message went out, nothing was listening yet, and the code was
    // gone for good. The subscription then sits unverified forever — the server pushes nothing but
    // the verification it is still waiting for — and there is no error anywhere to say so.
    //
    // A `postMessage` is best-effort by nature: the page may be mid-navigation, may not have
    // attached its listener, may be a client we cannot even see. The store is the durable half, so
    // it happens unconditionally and the message below is only an optimisation that saves a reload.
    await putPendingVerification(message)

    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (isAppClient(client.url, self.location.href)) client.postMessage(message)
    }
    return
  }

  // Read the state before asking about clients: `shouldRaisePushBanner` needs both, and neither
  // lookup is worth short-circuiting — this is a worker that just woke up for one decision.
  const state = frame.kind === 'delivery' ? await readPushState() : null
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

  const decision = shouldRaisePushBanner({
    frame,
    hasState: state !== null,
    hasVisibleClient: windows.some(
      (client) =>
        isAppClient(client.url, self.location.href) && client.visibilityState === 'visible',
    ),
    quietHours: state?.quietHours ?? null,
    minutesOfDay: localMinutesOfDay(Date.now()),
  })
  if (!decision.show || state === null) return

  // Via a typed local, not inline: an object LITERAL is excess-property-checked against
  // `showNotification`'s narrower `NotificationOptions`, which would reject `renotify` outright.
  const options: PushNotificationOptions = {
    body: state.body,
    icon: state.iconUrl,
    badge: state.badgeUrl,
    silent: !state.sound,
    // One tag for every push banner: a burst of five deliveries while the app is closed replaces one
    // banner five times instead of stacking five identical "New mail" lines. `renotify` keeps each
    // arrival audible. The live channel's per-message tags are unaffected — they carry an email id.
    tag: 'waxwing:push:delivery',
    renotify: true,
    // No `data`: the click has nothing to route to. `notificationTargetPath` answers an unrecognised
    // shape with the mail home, which is exactly right — we know mail arrived and nothing more.
  }
  await self.registration.showNotification(state.title, options)
}

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
