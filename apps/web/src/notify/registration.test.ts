/**
 * The page↔service-worker seam (M3.6). Two of the three behaviours here are invisible in every happy
 * path and silent when they break, which is exactly why they get a test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSwRegistrationState, setActiveSwRegistration } from '../pwa/register-sw'
import { closeAllNotifications, getNotificationRegistration } from './registration'

/** A registration with no ACTIVE worker — what `register()` resolves with before activation. */
const installing = { active: null } as unknown as ServiceWorkerRegistration

const activated = (): ServiceWorkerRegistration =>
  ({
    active: {} as ServiceWorker,
    showNotification: async () => {},
    getNotifications: async () => [],
  }) as unknown as ServiceWorkerRegistration

/** Install a fake `navigator.serviceWorker`; jsdom has none at all. */
function stubContainer(ready: Promise<unknown>): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { ready },
    configurable: true,
  })
}

beforeEach(() => {
  resetSwRegistrationState()
})

afterEach(() => {
  resetSwRegistrationState()
  Reflect.deleteProperty(navigator, 'serviceWorker')
  vi.useRealTimers()
})

describe('getNotificationRegistration', () => {
  it('is null where there is no ServiceWorkerContainer (jsdom, the plain-HTTP LAN demo)', async () => {
    expect('serviceWorker' in navigator).toBe(false)
    await expect(getNotificationRegistration()).resolves.toBeNull()
  })

  it('uses the published registration once it has an ACTIVE worker', async () => {
    const registration = activated()
    setActiveSwRegistration(registration)
    await expect(getNotificationRegistration()).resolves.toBe(registration)
  })

  it('IGNORES a published registration that has no active worker yet, and waits for `ready`', async () => {
    // M3.5 publishes the registration the moment `register()` resolves — which is BEFORE the worker
    // activates. `showNotification()` rejects with a TypeError on a registration whose `.active` is
    // null, and the notifier shows its banners under `Promise.allSettled`, so that rejection would be
    // swallowed whole: the first mail of a fresh session simply never announced, with no trace.
    // `serviceWorker.ready` is the one that resolves only with an ACTIVE worker.
    const ready = activated()
    setActiveSwRegistration(installing)
    stubContainer(Promise.resolve(ready))

    await expect(getNotificationRegistration()).resolves.toBe(ready)
  })

  it('never awaits `ready` unbounded — nothing registered means it never settles', async () => {
    // A 404 on sw.js after a bad deploy, or a worker unregistered in devtools. `serviceWorker.ready`
    // then hangs forever, and this call is awaited inside a sync pass that `stop()` in turn awaits.
    stubContainer(new Promise(() => {}))
    vi.useFakeTimers()

    const pending = getNotificationRegistration(3000)
    await vi.advanceTimersByTimeAsync(3000)

    await expect(pending).resolves.toBeNull()
  })
})

describe('closeAllNotifications', () => {
  it('closes every banner this app has on screen (FR-AUTH-05)', async () => {
    // A notification is local data the app put on the OS's screen, and the OS keeps it there across
    // sign-out, reload and browser restart. Wiping IndexedDB while three banners reading
    // "Alice Weber — Kündigung Arbeitsvertrag" sit in the notification centre makes a liar of the
    // "delete local data" promise — and clicking one still deep-links into the mailbox we just left.
    const close = vi.fn()
    setActiveSwRegistration({
      active: {} as ServiceWorker,
      getNotifications: async () => [{ close }, { close }, { close }],
    } as unknown as ServiceWorkerRegistration)

    await closeAllNotifications()

    expect(close).toHaveBeenCalledTimes(3)
  })

  it('never throws — a sign-out is not held hostage by the notification centre', async () => {
    setActiveSwRegistration({
      active: {} as ServiceWorker,
      getNotifications: async () => {
        throw new TypeError('the notification centre is on fire')
      },
    } as unknown as ServiceWorkerRegistration)

    await expect(closeAllNotifications()).resolves.toBeUndefined()
  })

  it('is a no-op when there is no registration at all', async () => {
    await expect(closeAllNotifications()).resolves.toBeUndefined()
  })
})
