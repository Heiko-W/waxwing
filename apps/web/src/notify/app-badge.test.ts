/**
 * The unread badge on the app icon (FR-NOTIF-04).
 *
 * The hook itself needs a replica and a shell to test meaningfully; what is pinned here is the part
 * that is pure and the part that is easy to get wrong — a count of zero must CLEAR the badge rather
 * than paint a zero on the icon, and a browser without the API must not throw.
 */

import { describe, expect, it, vi } from 'vitest'
import { applyAppBadge, badgingSupported } from './use-app-badge'

describe('badgingSupported', () => {
  it('is false where the API is absent (Firefox, iOS Safari outside an installed PWA)', () => {
    expect(badgingSupported({})).toBe(false)
  })

  it('is true where setAppBadge exists', () => {
    expect(badgingSupported({ setAppBadge: async () => {} })).toBe(true)
  })
})

describe('applyAppBadge', () => {
  it('sets the count when there is unread mail', async () => {
    const setAppBadge = vi.fn(async () => {})
    const clearAppBadge = vi.fn(async () => {})
    await applyAppBadge(7, { setAppBadge, clearAppBadge })

    expect(setAppBadge).toHaveBeenCalledWith(7)
    expect(clearAppBadge).not.toHaveBeenCalled()
  })

  it('CLEARS at zero rather than badging a "0"', async () => {
    const setAppBadge = vi.fn(async () => {})
    const clearAppBadge = vi.fn(async () => {})
    await applyAppBadge(0, { setAppBadge, clearAppBadge })

    expect(clearAppBadge).toHaveBeenCalled()
    expect(setAppBadge).not.toHaveBeenCalled()
  })

  it('does not throw where the platform refuses', async () => {
    // The spec lets a platform reject (not installed, no permission). A badge that cannot be set is
    // not a problem worth surfacing, and certainly not an unhandled rejection.
    const rejecting = {
      setAppBadge: async () => {
        throw new Error('not allowed')
      },
    }
    await expect(applyAppBadge(3, rejecting)).resolves.toBeUndefined()
  })

  it('does not throw where the API is missing entirely', async () => {
    await expect(applyAppBadge(3, {})).resolves.toBeUndefined()
  })
})
