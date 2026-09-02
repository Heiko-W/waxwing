/**
 * {@link SyncEngineHost}'s start/teardown chain (W-15, R-75).
 *
 * The chain is the W-15 fix: a React cleanup cannot be async, so the next fleet's setup awaits the
 * previous fleet's teardown through a ref. That makes the ref a single point of failure — anything
 * that leaves it REJECTED takes every later cycle with it, and there is nothing on screen to say so.
 */
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectedSession } from '../../app/session/types'

const startEngineFleet = vi.fn(() => () => Promise.resolve())

vi.mock('./fleet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fleet')>()),
  startEngineFleet: (...args: unknown[]) => startEngineFleet(...(args as [])),
  createPushMux: () => ({}),
}))

let connected: ConnectedSession | null = null
vi.mock('../../app/session/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/session/context')>()),
  useSession: () => ({
    connected,
    getAuthProvider: () => ({ scheme: 'bearer', authorization: () => 'x' }),
    reportAuthExpired: () => {},
  }),
}))

vi.mock('../../app/config-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/config-context')>()),
  useConfig: () => ({
    offline: { cacheDays: 30, maxStorageMB: 512 },
    branding: { productName: 'Waxwing' },
  }),
}))

// Renders nothing of its own here: it reconciles a Web Push subscription, which needs a service
// worker, the i18n bundle and a live `localPrefs` query — none of which this test is about.
vi.mock('../../notify/use-push-subscription', () => ({
  PushSubscriptionHost: ({ children }: { children?: ReactNode }) => children,
}))

const { SyncEngineHost } = await import('./react')

function session(accountId: string): ConnectedSession {
  return {
    accountId,
    username: 'me@example.test',
    accounts: [{ id: accountId, name: 'Me', isPrimary: true }],
  } as unknown as ConnectedSession
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush()
}

let locksDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  vi.clearAllMocks()
  connected = session('acc-1')
  // `canRunEngine()` gates the whole effect on the single-writer primitives; jsdom has no Web Locks.
  locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(navigator, 'locks', {
    value: { request: () => Promise.resolve() },
    configurable: true,
  })
})

afterEach(() => {
  if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor)
  else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'locks')
})

describe('SyncEngineHost — the teardown chain (R-75)', () => {
  it('a fleet that fails to start does not stop every later one from starting', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    startEngineFleet.mockImplementationOnce(() => {
      throw new Error('locks vanished mid-teardown')
    })

    const view = render(<SyncEngineHost>ok</SyncEngineHost>)
    await settle()
    expect(startEngineFleet).toHaveBeenCalledTimes(1)
    expect(logged, 'the failure went nowhere at all').toHaveBeenCalled()

    // A new `connected` — re-auth, a shared account added or removed — rebuilds the fleet. With the
    // rejection left on the ref, `await teardownRef.current` threw here and `startFleet()` was never
    // reached again: no sync until the component remounted, and no error anywhere to explain it.
    connected = session('acc-2')
    view.rerender(<SyncEngineHost>ok</SyncEngineHost>)
    await settle()

    expect(startEngineFleet, 'the poisoned chain swallowed the next cycle').toHaveBeenCalledTimes(2)
    logged.mockRestore()
  })
})
