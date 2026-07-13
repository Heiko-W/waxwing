import { describe, expect, it, vi } from 'vitest'
import {
  type NotificationApiLike,
  notificationsSupported,
  readPermission,
  requestPermission,
} from './permission'

/** jsdom has no Notification API, so the constructor is the seam — not a global shim. */
function api(permission: string, request?: () => Promise<string> | undefined): NotificationApiLike {
  return { permission, requestPermission: request ?? (async () => permission) }
}

describe('readPermission', () => {
  it('maps the three DOM states', () => {
    expect(readPermission(api('granted'))).toBe('granted')
    expect(readPermission(api('denied'))).toBe('denied')
    expect(readPermission(api('default'))).toBe('default')
  })

  it('a browser with no Notification API at all is `unsupported`, not `denied`', () => {
    // The difference is the entire UI: `denied` tells the user to fix their browser settings;
    // `unsupported` (iOS outside a home-screen install) tells them to install the app.
    expect(readPermission(null)).toBe('unsupported')
    expect(notificationsSupported()).toBe(false) // jsdom
  })

  it('an unrecognised value degrades to `default` rather than to a grant', () => {
    expect(readPermission(api('something-new'))).toBe('default')
  })
})

describe('requestPermission', () => {
  it('reads the result back from the API rather than trusting the return value', async () => {
    // Legacy Safari's callback form resolves to `undefined`. A client that believed the return value
    // would read every grant as a dismissal and never enable itself.
    const legacy: NotificationApiLike = {
      permission: 'default',
      requestPermission: () => undefined,
    }
    const granted = { ...legacy, permission: 'granted' }
    Object.defineProperty(legacy, 'permission', {
      get: () => granted.permission,
    })
    await expect(requestPermission(legacy)).resolves.toBe('granted')
  })

  it('resolves to the state the browser actually settled on', async () => {
    const denied = api('denied')
    await expect(requestPermission(denied)).resolves.toBe('denied')
  })

  it('a request that THROWS has not granted anything', async () => {
    const hostile: NotificationApiLike = {
      permission: 'default',
      requestPermission: () => {
        throw new TypeError('insecure context')
      },
    }
    await expect(requestPermission(hostile)).resolves.toBe('default')
  })

  it('is a no-op where there is no API', async () => {
    const ask = vi.fn()
    await expect(requestPermission(null)).resolves.toBe('unsupported')
    expect(ask).not.toHaveBeenCalled()
  })
})
