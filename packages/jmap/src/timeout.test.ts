import { describe, expect, it, vi } from 'vitest'
import { bearer } from './auth'
import { JmapClient } from './client'
import { makeSession } from './test-support'
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
  it('aborts a request that never answers', async () => {
    vi.useFakeTimers()
    try {
      const fetch: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
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
      const settled = expect(pending).rejects.toThrowError(/abort/i)
      await vi.advanceTimersByTimeAsync(60)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes a signal to fetch even when the caller gives none', async () => {
    const seen: Array<AbortSignal | undefined> = []
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      seen.push(init?.signal ?? undefined)
      return new Response(JSON.stringify({ methodResponses: [], sessionState: 's' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = new JmapClient({ session: makeSession(), auth: bearer('tok'), fetch })

    const builder = client.request()
    builder.call('Email/query', { accountId: 'a' })
    await builder.send()

    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(seen[0]?.aborted).toBe(false)
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
