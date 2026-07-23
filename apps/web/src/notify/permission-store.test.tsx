/**
 * The shared Notification permission (M4.0 fix). Every test here is the defect the B29 hand-check
 * found on its first run, in a form that goes red without the fix.
 *
 * The bug was not exotic: `useState` inside a hook that two components call. The settings screen
 * asked the browser and updated ITS copy; `PushSubscriptionHost` kept its own, still `default`, and
 * therefore never subscribed. Permission granted, switch on, nothing happening — and nothing on
 * screen able to explain it, because from the app's point of view nothing had gone wrong.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { NotificationPermissionState } from './permission'
import {
  getPermissionSnapshot,
  publishPermission,
  refreshPermission,
  resetPermissionStore,
  subscribeToPermission,
} from './permission-store'
import { useNotificationPermission } from './use-notification-permission'

beforeEach(() => {
  resetPermissionStore()
  browserPermission = 'default'
})

describe('the store', () => {
  it('caches the snapshot — useSyncExternalStore loops forever on a fresh value each call', () => {
    let reads = 0
    refreshPermission(() => {
      reads++
      return 'default'
    })
    const first = getPermissionSnapshot()
    expect(getPermissionSnapshot()).toBe(first)
    expect(reads).toBe(1)
  })

  it('notifies subscribers only when the value actually changed', () => {
    let notified = 0
    subscribeToPermission(() => {
      notified++
    })
    publishPermission('granted')
    publishPermission('granted')
    expect(notified).toBe(1)
    publishPermission('denied')
    expect(notified).toBe(2)
  })

  it('stops notifying after unsubscribe', () => {
    let notified = 0
    const off = subscribeToPermission(() => {
      notified++
    })
    off()
    publishPermission('granted')
    expect(notified).toBe(0)
  })
})

/**
 * Two components, one hook, one browser permission — the exact shape of the shipped bug. The
 * "settings" component asks; the "host" component must see the answer without any further event.
 */
/**
 * A stand-in for `Notification.permission`: one value the whole "browser" agrees on, exactly as in
 * a real page. `readBrowser` is a MODULE function and therefore stable — the same property
 * `readPermission` has in production, and a load-bearing one: an inline `read` would be a new
 * function every render, re-running the sync effect and papering over the very defect under test by
 * re-reading the value on every commit.
 */
let browserPermission: NotificationPermissionState = 'default'
const readBrowser = (): NotificationPermissionState => browserPermission

function grantOnAsk(answer: NotificationPermissionState) {
  return (): Promise<NotificationPermissionState> => {
    browserPermission = answer
    return Promise.resolve(answer)
  }
}

function Asker({ ask }: { ask: () => Promise<NotificationPermissionState> }) {
  const permission = useNotificationPermission({ read: readBrowser, ask })
  return (
    <button type="button" onClick={() => void permission.request()}>
      ask
    </button>
  )
}

function Host() {
  const permission = useNotificationPermission({ read: readBrowser })
  return <output>{permission.state}</output>
}

describe('two components sharing the permission', () => {
  /**
   * **This is the regression test for the shipped defect.** Without a shared store the host still
   * reads `default` here, and in the app that meant `wanted === false`, so nothing ever subscribed.
   * Neither escape hatch would have saved it: `visibilitychange` never fires (the tab is visible
   * throughout) and Safari does not deliver the Permissions API `change` event for `notifications`.
   */
  it('the host sees a grant the settings screen obtained, with no other event', async () => {
    render(
      <>
        <Asker ask={grantOnAsk('granted')} />
        <Host />
      </>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('default')

    await userEvent.click(screen.getByRole('button', { name: 'ask' }))

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('granted')
    })
  })

  it('propagates a denial the same way', async () => {
    render(
      <>
        <Asker ask={grantOnAsk('denied')} />
        <Host />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('denied')
    })
  })

  /**
   * A dismissed prompt leaves the state at `default`. It must not read as a grant anywhere — the
   * settings screen says "not allowed, turn it on again to be asked once more", and the host must
   * agree rather than subscribing against a permission nobody gave.
   */
  it('a dismissed prompt leaves every reader at default', async () => {
    render(
      <>
        <Asker ask={grantOnAsk('default')} />
        <Host />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    expect(screen.getByRole('status')).toHaveTextContent('default')
  })
})
