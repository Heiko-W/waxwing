import { describe, expect, it } from 'vitest'
import { bearer } from './auth'
import { JmapClient } from './client'
import { at, autoRespond, jmapPostMock, makeSession } from './test-support'
import type { FetchLike } from './transport'
import { DEFAULT_REQUEST_TIMEOUT_MS, postApi } from './transport'

/**
 * `fetch` has no timeout of its own, and neither did this transport: a socket the server accepts
 * and then never answers on left the promise pending for as long as the browser's own patience —
 * minutes. Everything downstream inherited that wait, and `endSession` awaits the engines FIRST,
 * so a hung request meant the login screen was up while the replica, the OS notification banners
 * and the credentials were all still on the machine.
 */
describe('transport request deadline (W-16)', () => {
  /**
   * R-93. No fake timers, deliberately, and the version that had them was passing for the wrong
   * reason: `AbortSignal.timeout` is scheduled by the platform, not by `setTimeout`, so
   * `vi.advanceTimersByTimeAsync(60)` did nothing to it — what fired the deadline was the ~50 ms of
   * REAL time that elapsed while the test awaited. A reader would have concluded that the deadline
   * is under the test's control, and anyone raising it here to the 30 s default would have got a
   * hanging test instead of the fast one they expected.
   *
   * So the deadline is a real 50 ms, and it is passed explicitly. The behaviour under test is the
   * one the app depends on: a socket the server accepts and never answers on must not leave the
   * promise pending.
   */
  it('aborts a request that never answers', async () => {
    let deadline: AbortSignal | undefined
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        deadline = init?.signal
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'TimeoutError'))
        })
      })
    const pending = postApi(
      'https://mail.waxwing.test/jmap/api',
      { using: [], methodCalls: [] },
      { fetch, auth: bearer('tok') },
      undefined,
      50,
    )
    await expect(pending).rejects.toThrowError(/abort/i)
    // The abort came from the DEADLINE and not from a caller signal — there was none.
    expect(deadline?.aborted).toBe(true)
  })

  /**
   * Through the SHARED mock, which now records `init.signal` (R-93). It did not, which is why this
   * file grew a fetch mock of its own for every assertion about cancellation — and a mock that
   * silently drops the one thing under test is how a transport could lose its signal without any
   * of these tests noticing.
   */
  it('passes a signal to fetch even when the caller gives none', async () => {
    const { fetch, calls } = jmapPostMock((body) => autoRespond(body))
    const client = new JmapClient({ session: makeSession(), auth: bearer('tok'), fetch })

    const builder = client.request()
    builder.call('Email/query', { accountId: 'a' })
    await builder.send()

    const recorded = at(calls, 0)
    expect(recorded.signal).toBeInstanceOf(AbortSignal)
    expect(recorded.signal?.aborted).toBe(false)
  })

  it("records the caller's own signal through the shared mock too", async () => {
    const { fetch, calls } = jmapPostMock((body) => autoRespond(body))
    const client = new JmapClient({ session: makeSession(), auth: bearer('tok'), fetch })
    const controller = new AbortController()

    const builder = client.request()
    builder.call('Email/query', { accountId: 'a' })
    await builder.send({ signal: controller.signal })

    // Combined with the deadline via `AbortSignal.any`, so identity is not the test — reachability
    // is: aborting the caller's controller aborts what fetch was handed.
    const recorded = at(calls, 0)
    expect(recorded.signal?.aborted).toBe(false)
    controller.abort()
    expect(recorded.signal?.aborted).toBe(true)
  })

  it("still honours the caller's own signal — the deadline is an addition, not a replacement", async () => {
    const controller = new AbortController()
    let sawFetch: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      sawFetch = resolve
    })
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const fail = () => {
          reject(new DOMException('aborted by caller', 'AbortError'))
        }
        if (init?.signal?.aborted === true) fail()
        else init?.signal?.addEventListener('abort', fail)
        sawFetch?.()
      })
    const pending = postApi(
      'https://mail.waxwing.test/jmap/api',
      { using: [], methodCalls: [] },
      { fetch, auth: bearer('tok') },
      controller.signal,
    )
    // `postApi` awaits `applyAuth` before it calls fetch, so aborting synchronously here would
    // race the listener rather than test it.
    await entered
    controller.abort()

    await expect(pending).rejects.toThrowError(/aborted by caller/)
  })

  it('is a real bound, not a placeholder', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThan(5_000)
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })
})
