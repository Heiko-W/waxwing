import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrReport,
  getDispatchFailureAt,
  getDispatchFailureMessage,
  reportDispatchFailure,
  resetDispatchFailure,
  subscribeDispatchFailure,
} from './dispatch-failure'

afterEach(() => {
  resetDispatchFailure()
})

describe('dispatch-failure signal (W-10)', () => {
  it('records a failure and notifies subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeDispatchFailure(listener)

    reportDispatchFailure(new Error('boom'), 1234)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getDispatchFailureAt()).toBe(1234)
    expect(getDispatchFailureMessage()).toBe('boom')
    unsubscribe()
  })

  it('starts silent, so a shell that mounts before anything fails toasts nothing', () => {
    expect(getDispatchFailureAt()).toBe(0)
    expect(getDispatchFailureMessage()).toBeNull()
  })

  it('catches a rejecting dispatch rather than leaving an unhandled rejection', async () => {
    dispatchOrReport(Promise.reject(new Error('quota')))
    // The catch is attached synchronously; the report lands on the microtask turn after.
    await Promise.resolve()
    await Promise.resolve()

    expect(getDispatchFailureAt()).not.toBe(0)
    expect(getDispatchFailureMessage()).toBe('quota')
  })

  it('is a no-op without an engine — the optional-chained call shape', () => {
    // `getEngineFor(id)?.dispatch(...)` is `undefined` when no engine serves the account, and that
    // is not a failure: refusing to queue is what "no engine" already means everywhere else.
    expect(() => {
      dispatchOrReport(undefined)
    }).not.toThrow()
    expect(getDispatchFailureAt()).toBe(0)
  })

  it('keeps only the LAST failure — a burst is one toast, not fifty', async () => {
    reportDispatchFailure(new Error('first'), 10)
    reportDispatchFailure(new Error('second'), 20)

    expect(getDispatchFailureAt()).toBe(20)
    expect(getDispatchFailureMessage()).toBe('second')
  })
})
