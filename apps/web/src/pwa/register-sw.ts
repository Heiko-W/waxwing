/**
 * Service-worker registration and update detection (M3.5). Fully injectable — jsdom has no
 * `ServiceWorkerContainer` at all, so the container, the base URI and the callbacks are parameters,
 * and every branch below is a unit test.
 *
 * The registration is returned so M3.6 can reach `registration.pushManager`.
 */

import { SKIP_WAITING, SW_FILENAME } from './sw-routes'

/** The slice of `navigator.serviceWorker` we use — a fake in tests, the real container in the app. */
export interface SwContainerLike {
  register(url: string, options?: { scope?: string }): Promise<ServiceWorkerRegistration>
  addEventListener(
    type: 'controllerchange',
    listener: () => void,
    options?: { signal?: AbortSignal },
  ): void
  readonly controller: ServiceWorker | null
}

export interface RegisterSwDeps {
  /** Defaults to `navigator.serviceWorker` when the browser has one. */
  readonly container?: SwContainerLike | undefined
  /** Defaults to `document.baseURI` (the `<base href>` Stalwart rewrites to the mount prefix). */
  readonly baseUri?: string | undefined
  /** A new build is installed and WAITING. Call `activate()` to hand over — only on the user's word. */
  readonly onUpdateReady: (activate: () => void) => void
  /** A new worker took control of this page: the code that is running is now stale. Fires at most once. */
  readonly onControllerChange: () => void
}

/** What {@link registerServiceWorker} hands back: the registration M3.6 needs, plus a teardown. */
export interface SwRegistration {
  readonly registration: ServiceWorkerRegistration
  /**
   * Drop every listener this call attached. It MUST be called when the caller goes away: the browser
   * returns the SAME `ServiceWorkerRegistration` object for a given scope, so a second
   * `registerServiceWorker` (the shell remounts on sign-out → sign-in) would otherwise stack a second
   * `updatefound` listener on it — and a later deploy would raise one update toast per sign-in.
   */
  dispose(): void
}

/**
 * `controllerchange` fires once per worker hand-over — but the consumer reacts by RELOADING, and a
 * double reload would lose whatever the first one was in the middle of. The guard is module-level
 * (not per-registration) so it holds even if something registers twice.
 */
let controllerChangeHandled = false

/**
 * The live registration, published for anything that needs to talk to the worker without owning the
 * registration flow — today M3.6's notifier, which shows every notification through
 * `registration.showNotification()`.
 *
 * A plain getter, deliberately: it is published the moment `register()` resolves, which is BEFORE the
 * worker activates, and `showNotification()` rejects on a registration whose `.active` is null. So a
 * reader cannot simply take what is here — `notify/registration.ts` checks `.active` and otherwise
 * waits for `serviceWorker.ready`, which resolves only with an active worker. An observable would
 * merely have told consumers *sooner* about a registration they still could not use.
 */
let activeRegistration: ServiceWorkerRegistration | null = null

export function setActiveSwRegistration(registration: ServiceWorkerRegistration | null): void {
  activeRegistration = registration
}

export function getActiveSwRegistration(): ServiceWorkerRegistration | null {
  return activeRegistration
}

/** Test seam: forget the one-shot `controllerchange` guard and the published registration. */
export function resetSwRegistrationState(): void {
  controllerChangeHandled = false
  activeRegistration = null
}

/** `navigator.serviceWorker`, or null — it is ABSENT in an insecure context (`pnpm demo --lan`) and in jsdom. */
function defaultContainer(): SwContainerLike | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  return navigator.serviceWorker
}

export async function registerServiceWorker(deps: RegisterSwDeps): Promise<SwRegistration | null> {
  const container = deps.container ?? defaultContainer()
  if (container === null) return null

  const baseUri = deps.baseUri ?? document.baseURI
  // Both derived from the base URI, never from a leading-slash literal: under Stalwart's `/mail/`
  // mount the worker is at /mail/sw.js with scope /mail/, and a hardcoded '/sw.js' would 404.
  const url = new URL(SW_FILENAME, baseUri)
  const scope = new URL('./', baseUri).pathname

  let registration: ServiceWorkerRegistration
  try {
    // A CLASSIC worker: the bundle vite-plugin-pwa emits has no ESM syntax, and `{type:'module'}`
    // is still unsupported in Firefox.
    registration = await container.register(url.href, { scope })
  } catch {
    // A failed registration must never take the app down with it — it only costs offline support.
    return null
  }

  // One controller for every listener below, so `dispose()` is a single `abort()` and nothing can be
  // left attached to a registration object that outlives this caller.
  const listeners = new AbortController()
  const { signal } = listeners

  const notifyUpdateReady = (): void => {
    deps.onUpdateReady(() => {
      registration.waiting?.postMessage({ type: SKIP_WAITING })
    })
  }

  /**
   * An UNCONTROLLED page (the very first visit, or a shift-reload) was served by the network, not by
   * a worker — its code is by definition the newest. There is nothing to update *from*, and offering
   * anyway would be a trap: `skipWaiting()` only re-parents the clients the OUTGOING worker
   * controlled, so this page would never get its `controllerchange` and never reload. The toast would
   * simply do nothing.
   */
  const isStale = (): boolean => container.controller !== null

  // Already waiting when this tab loaded (the update installed during an earlier visit).
  if (registration.waiting !== null && isStale()) notifyUpdateReady()

  registration.addEventListener(
    'updatefound',
    () => {
      const installing = registration.installing
      if (installing === null) return
      installing.addEventListener(
        'statechange',
        () => {
          if (installing.state === 'installed' && isStale()) notifyUpdateReady()
        },
        { signal },
      )
    },
    { signal },
  )

  container.addEventListener(
    'controllerchange',
    () => {
      if (controllerChangeHandled) return
      controllerChangeHandled = true
      deps.onControllerChange()
    },
    { signal },
  )

  return {
    registration,
    dispose: () => {
      listeners.abort()
    },
  }
}

/** Hourly — a mail tab can stay open for days without ever navigating. */
const UPDATE_INTERVAL_MS = 60 * 60 * 1000

/** The one thing {@link startUpdateChecks} needs from a registration (a fake supplies it in tests). */
export interface SwUpdatable {
  update(): Promise<unknown>
}

/**
 * Poll for a new build: on an interval AND whenever the tab becomes visible again. Without this a
 * long-lived tab would only notice a deploy on a full reload — which is the one thing a webmail user
 * never does. Returns a disposer.
 *
 * (Split from {@link registerServiceWorker} so that function can keep returning the registration
 * itself, which M3.6 needs.)
 */
export function startUpdateChecks(
  registration: SwUpdatable,
  intervalMs: number = UPDATE_INTERVAL_MS,
): () => void {
  // Offline, `update()` rejects — that is not an error, it is Tuesday.
  const check = (): void => {
    void registration.update().catch(() => {})
  }
  const timer = setInterval(check, intervalMs)
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') check()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
