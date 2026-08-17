import { describe, expect, it, vi } from 'vitest'
import { defaultScheduler, MAX_TIMEOUT_MS } from './types'

describe('defaultScheduler', () => {
  it('clamps a delay past the 32-bit timer range (F5)', () => {
    // `setTimeout` stores the delay in a signed 32-bit int, so 4e9 ms does not wait 46 days — it
    // wraps and fires in ~1 ms. Asserted on the value handed to the host, because no fake-timer
    // implementation reproduces the overflow: the bug only exists in the real runtime.
    const spy = vi.spyOn(globalThis, 'setTimeout')
    try {
      defaultScheduler.setTimeout(() => {}, 4_000_000_000)()
      expect(spy.mock.calls[0]?.[1]).toBe(MAX_TIMEOUT_MS)
    } finally {
      spy.mockRestore()
    }
  })

  it('passes an ordinary delay through untouched and cancels the timer', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    let fired = false
    try {
      const cancel = defaultScheduler.setTimeout(() => {
        fired = true
      }, 5)
      expect(spy.mock.calls[0]?.[1]).toBe(5)
      cancel()
    } finally {
      spy.mockRestore()
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fired).toBe(false)
  })
})
