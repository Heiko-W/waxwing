/**
 * R-42 — the worker asks before it banners.
 *
 * The bug: the live channel banners when no tab is in the FOREGROUND, Web Push when no tab is
 * VISIBLE. An open but covered tab is neither, so both fired for one delivery, under two tags that
 * cannot replace one another. The repair had to be a QUESTION rather than "stay silent whenever any
 * client exists", because a frozen mobile tab is still in `clients.matchAll` and cannot banner at
 * all — silencing the worker for it would lose the notification outright.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  anyClientRaisesLiveBanner,
  isLiveBannerProbeMessage,
  isLiveBannerProbeReply,
  LIVE_BANNER_PROBE,
  type LiveBannerProbeReply,
  type LiveProbeTarget,
} from './live-probe'

/** A tab that answers the probe after `delayMs`; `live: null` means it never answers at all. */
function tab(live: boolean | null, delayMs = 0): LiveProbeTarget & { asked: number } {
  const target = {
    asked: 0,
    postMessage(message: unknown, transfer: Transferable[]): void {
      target.asked += 1
      expect(isLiveBannerProbeMessage(message)).toBe(true)
      const port = transfer[0] as MessagePort
      if (live === null) return
      const reply: LiveBannerProbeReply = { type: LIVE_BANNER_PROBE, live }
      setTimeout(() => port.postMessage(reply), delayMs)
    },
  }
  return target
}

describe('anyClientRaisesLiveBanner', () => {
  it('says no immediately when the app is closed', async () => {
    // The ordinary background push: no client at all, and no reason to burn the deadline.
    const started = Date.now()
    expect(await anyClientRaisesLiveBanner([], 200)).toBe(false)
    expect(Date.now() - started).toBeLessThan(150)
  })

  it('says yes when a tab claims the delivery', async () => {
    expect(await anyClientRaisesLiveBanner([tab(true)], 200)).toBe(true)
  })

  it('says no when every tab declines, without waiting out the deadline', async () => {
    const started = Date.now()
    expect(await anyClientRaisesLiveBanner([tab(false), tab(false)], 2000)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  /**
   * THE case the cross-check insisted on. A frozen or throttled background tab is still returned by
   * `clients.matchAll`, but it cannot run its live channel — so it says nothing, and the worker must
   * banner. Treating its mere existence as an answer is the regression this design avoids.
   */
  it('banners for a tab that is present but silent', async () => {
    const frozen = tab(null)
    expect(await anyClientRaisesLiveBanner([frozen], 30)).toBe(false)
    expect(frozen.asked).toBe(1)
  })

  it('one live tab beside a silent one is enough to stay quiet', async () => {
    expect(await anyClientRaisesLiveBanner([tab(null), tab(true)], 60)).toBe(true)
  })

  it('an answer that arrives after the deadline cannot change the verdict', async () => {
    expect(await anyClientRaisesLiveBanner([tab(true, 80)], 20)).toBe(false)
  })

  it('survives a client that has gone away between matchAll and the question', async () => {
    const gone: LiveProbeTarget = {
      postMessage: vi.fn(() => {
        throw new Error('InvalidStateError')
      }),
    }
    expect(await anyClientRaisesLiveBanner([gone, tab(true)], 60)).toBe(true)
  })

  it('ignores a reply that is not one of ours', async () => {
    const noise: LiveProbeTarget = {
      postMessage(_message, transfer) {
        const port = transfer[0] as MessagePort
        port.postMessage({ type: 'SOMETHING_ELSE', live: true })
      },
    }
    expect(await anyClientRaisesLiveBanner([noise], 30)).toBe(false)
  })
})

describe('the probe shapes', () => {
  it('recognises its own message and reply, and nothing else', () => {
    expect(isLiveBannerProbeMessage({ type: LIVE_BANNER_PROBE })).toBe(true)
    expect(isLiveBannerProbeMessage({ type: 'NOTIFY_CLICK' })).toBe(false)
    expect(isLiveBannerProbeMessage(null)).toBe(false)
    expect(isLiveBannerProbeReply({ type: LIVE_BANNER_PROBE, live: false })).toBe(true)
    // A reply without the flag is not a reply — silence is the "no", not a malformed message.
    expect(isLiveBannerProbeReply({ type: LIVE_BANNER_PROBE })).toBe(false)
  })
})
