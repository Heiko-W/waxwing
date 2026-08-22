import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREFETCH_LIMIT, usePrefetchBodies } from './use-prefetch-bodies'

/**
 * The prefetch's contract (M5.16). Three collaborators decide whether it may run at all, so all
 * three are faked: the reader's switch, connectivity, and the account's engine.
 *
 * Measured on the fixture at 150 ms latency / 1 Mbit, this is worth 2395 ms → 102 ms on the first
 * message opened. What the tests below protect is not the speed but the three bounds that keep the
 * speed from costing something else: the switch, the cap, and not re-walking ids.
 */
const fetchBody = vi.fn(async () => null)
let enabled = true
let online = true
let engine: unknown = { fetchBody }

vi.mock('./reading-prefs', () => ({ usePrefetchBodies: () => enabled }))
vi.mock('../app/use-online', () => ({ useOnline: () => online }))
vi.mock('../sync/engine', () => ({ useAccountEngine: () => engine }))

const ids = (n: number, prefix = 'e'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

beforeEach(() => {
  fetchBody.mockClear()
  enabled = true
  online = true
  engine = { fetchBody }
})
afterEach(() => {
  vi.useRealTimers()
})

describe('usePrefetchBodies', () => {
  it('warms the window it is given', async () => {
    renderHook(() => usePrefetchBodies(ids(3)))
    await waitFor(() => expect(fetchBody).toHaveBeenCalledTimes(3))
    expect(fetchBody.mock.calls.flat()).toEqual(['e1', 'e2', 'e3'])
  })

  /*
   * The switch is the WHOLE policy, because no browser API distinguishes Wi-Fi from cellular —
   * `navigator.connection` is absent in WebKit and reports no `type` in Chromium (measured
   * 2026-08-22). If this test ever goes green with the switch off, a reader on a metered connection
   * is paying for mail they did not ask for and turned off.
   */
  it('does nothing at all when the reader turned it off', async () => {
    enabled = false
    renderHook(() => usePrefetchBodies(ids(3)))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fetchBody).not.toHaveBeenCalled()
  })

  it('does nothing while offline', async () => {
    online = false
    renderHook(() => usePrefetchBodies(ids(3)))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fetchBody).not.toHaveBeenCalled()
  })

  it('stops at the cap — a folder may hold a hundred thousand', async () => {
    renderHook(() => usePrefetchBodies(ids(PREFETCH_LIMIT + 40)))
    await waitFor(() => expect(fetchBody).toHaveBeenCalledTimes(PREFETCH_LIMIT), {
      timeout: 15_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fetchBody).toHaveBeenCalledTimes(PREFETCH_LIMIT)
  })

  /*
   * A delta rewrites the window array on every sync. Keying the effect off the array's identity
   * would restart the walk each time — on a busy mailbox that is a fetch storm made of messages
   * already in the replica.
   */
  it('does not re-walk ids it has already seen', async () => {
    const { rerender } = renderHook(({ list }) => usePrefetchBodies(list), {
      initialProps: { list: ids(2) },
    })
    await waitFor(() => expect(fetchBody).toHaveBeenCalledTimes(2))
    rerender({ list: [...ids(2)] }) // same content, new array
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fetchBody).toHaveBeenCalledTimes(2)
    rerender({ list: [...ids(2), 'e3'] }) // one arrival
    await waitFor(() => expect(fetchBody).toHaveBeenCalledTimes(3))
    expect(fetchBody.mock.calls.at(-1)).toEqual(['e3'])
  })

  /*
   * Short JMAP ids are per-account: `e1` in a shared account is a different message from `e1` in the
   * primary one. Remembering walked ids across an engine change would skip the new account's mail.
   */
  it('starts over when the account changes', async () => {
    const { rerender } = renderHook(() => usePrefetchBodies(ids(2)))
    await waitFor(() => expect(fetchBody).toHaveBeenCalledTimes(2))
    engine = { fetchBody }
    rerender()
    await waitFor(() => expect(fetchBody).toHaveBeenCalledTimes(4))
  })

  it('keeps going when one message fails', async () => {
    fetchBody.mockRejectedValueOnce(new Error('destroyed server-side'))
    renderHook(() => usePrefetchBodies(ids(3)))
    await waitFor(() => expect(fetchBody).toHaveBeenCalledTimes(3))
  })
})
