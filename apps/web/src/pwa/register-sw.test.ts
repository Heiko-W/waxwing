import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getActiveSwRegistration,
  registerServiceWorker,
  resetSwRegistrationState,
  type SwContainerLike,
  setActiveSwRegistration,
  startUpdateChecks,
} from './register-sw'

// jsdom has no ServiceWorkerContainer at all, so the whole lifecycle is faked over real
// EventTargets — which keeps the listener/dispatch semantics honest.
class FakeWorker extends EventTarget {
  state: ServiceWorkerState = 'installing'
  readonly postMessage = vi.fn()

  install(): void {
    this.state = 'installed'
    this.dispatchEvent(new Event('statechange'))
  }
}

class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null
  installing: FakeWorker | null = null
  readonly update = vi.fn(async () => {})

  /** A new worker finishes installing while this page is open. */
  installNewWorker(): FakeWorker {
    const worker = new FakeWorker()
    this.installing = worker
    this.dispatchEvent(new Event('updatefound'))
    worker.install()
    this.waiting = worker
    return worker
  }
}

class FakeContainer extends EventTarget {
  controller: ServiceWorker | null = null
  registration = new FakeRegistration()
  readonly register = vi.fn(
    async (_url: string, _options?: { scope?: string }) =>
      this.registration as unknown as ServiceWorkerRegistration,
  )
}

const asContainer = (container: FakeContainer): SwContainerLike =>
  container as unknown as SwContainerLike

let container: FakeContainer
const onUpdateReady = vi.fn()
const onControllerChange = vi.fn()

const register = (baseUri = 'https://mail.example.com/') =>
  registerServiceWorker({
    container: asContainer(container),
    baseUri,
    onUpdateReady,
    onControllerChange,
  })

beforeEach(() => {
  container = new FakeContainer()
  vi.clearAllMocks() // the callbacks are module-level fakes; their call history must not bleed
  resetSwRegistrationState()
})

afterEach(() => {
  resetSwRegistrationState()
})

describe('registerServiceWorker', () => {
  it('is a no-op where there is no ServiceWorkerContainer (jsdom, plain-HTTP LAN demo)', async () => {
    expect('serviceWorker' in navigator).toBe(false)
    await expect(registerServiceWorker({ onUpdateReady, onControllerChange })).resolves.toBeNull()
  })

  it('derives the worker URL and the scope from the base URI — at the root', async () => {
    await register('https://mail.example.com/')
    expect(container.register).toHaveBeenCalledWith('https://mail.example.com/sw.js', {
      scope: '/',
    })
  })

  it('…and under a /mail/ mount prefix (a leading-slash literal would 404 there)', async () => {
    await register('https://mail.example.com/mail/')
    expect(container.register).toHaveBeenCalledWith('https://mail.example.com/mail/sw.js', {
      scope: '/mail/',
    })
  })

  it('registers a CLASSIC worker — the emitted bundle has no ESM syntax', async () => {
    await register()
    expect(container.register.mock.calls[0]?.[1]).toEqual({ scope: '/' })
  })

  it('survives a failing registration without taking the app down', async () => {
    container.register.mockRejectedValueOnce(new Error('SecurityError'))
    await expect(register()).resolves.toBeNull()
  })

  it('prompts when a new build was already WAITING at page load', async () => {
    container.controller = {} as ServiceWorker
    container.registration.waiting = new FakeWorker()
    await register()
    expect(onUpdateReady).toHaveBeenCalledTimes(1)
  })

  it('prompts when a new build installs while the page is open (a controller exists)', async () => {
    container.controller = {} as ServiceWorker
    await register()
    container.registration.installNewWorker()
    expect(onUpdateReady).toHaveBeenCalledTimes(1)
  })

  it('does NOT prompt on the FIRST install — no controller means nothing is stale', async () => {
    container.controller = null
    await register()
    container.registration.installNewWorker()
    expect(onUpdateReady).not.toHaveBeenCalled()
  })

  it('does NOT prompt an UNCONTROLLED page that finds a worker waiting — the offer would be a dead end', async () => {
    // A shift-reload (or the first session, since the worker deliberately never calls clientsClaim)
    // leaves the page uncontrolled: it was served by the NETWORK, so its code is already the newest.
    // Worse, `skipWaiting()` only re-parents the clients the OUTGOING worker controlled — this page
    // has none — so `controllerchange` would never fire here and the reload would never happen. The
    // user would click "Reload" and watch nothing at all occur.
    container.controller = null
    container.registration.waiting = new FakeWorker()
    await register()
    expect(onUpdateReady).not.toHaveBeenCalled()
  })

  it('activates by asking the WAITING worker to skip waiting — never at install time', async () => {
    container.controller = {} as ServiceWorker
    const waiting = new FakeWorker()
    container.registration.waiting = waiting
    await register()

    const activate = onUpdateReady.mock.calls[0]?.[0] as () => void
    expect(waiting.postMessage).not.toHaveBeenCalled()
    activate()
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('reacts to `controllerchange` exactly once, even if it fires twice (a double reload loses work)', async () => {
    await register()
    container.dispatchEvent(new Event('controllerchange'))
    container.dispatchEvent(new Event('controllerchange'))
    expect(onControllerChange).toHaveBeenCalledTimes(1)
  })

  it('dispose() drops its listeners — the browser hands back the SAME registration object next time', async () => {
    // Sign out → sign in remounts the shell and registers again. Without a teardown the second call
    // stacks a second `updatefound` listener on the same registration, and the next deploy raises one
    // update toast per sign-in.
    container.controller = {} as ServiceWorker
    const first = await register()
    first?.dispose()

    await register() // the "second sign-in"
    container.registration.installNewWorker()

    expect(onUpdateReady).toHaveBeenCalledTimes(1)
  })
})

describe('startUpdateChecks', () => {
  it('polls on an interval and whenever the tab comes back — a mail tab never navigates', async () => {
    vi.useFakeTimers()
    const registration = { update: vi.fn(async () => {}) }
    const stop = startUpdateChecks(registration, 1000)

    vi.advanceTimersByTime(2500)
    expect(registration.update).toHaveBeenCalledTimes(2)

    document.dispatchEvent(new Event('visibilitychange')) // jsdom reports 'visible'
    expect(registration.update).toHaveBeenCalledTimes(3)

    stop()
    vi.advanceTimersByTime(5000)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(registration.update).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('swallows the rejection an offline `update()` produces', async () => {
    const registration = { update: vi.fn(async () => Promise.reject(new Error('offline'))) }
    const stop = startUpdateChecks(registration, 1000)
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(registration.update).toHaveBeenCalled()
    stop()
  })
})

/**
 * The published registration (M3.6). The notifier shows every banner through
 * `registration.showNotification()`, and it does not own the registration flow — `useUpdatePrompt`
 * does. This is the hand-off between them.
 */
describe('the active registration store', () => {
  it('starts empty, publishes, and can be cleared', () => {
    expect(getActiveSwRegistration()).toBeNull()

    const registration = {} as ServiceWorkerRegistration
    setActiveSwRegistration(registration)
    expect(getActiveSwRegistration()).toBe(registration)

    setActiveSwRegistration(null)
    expect(getActiveSwRegistration()).toBeNull()
  })

  it('is cleared by resetSwRegistrationState, so it cannot leak between tests', () => {
    setActiveSwRegistration({} as ServiceWorkerRegistration)
    resetSwRegistrationState()
    expect(getActiveSwRegistration()).toBeNull()
  })
})
