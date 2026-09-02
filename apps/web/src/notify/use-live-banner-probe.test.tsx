/**
 * R-42, the page half: a running tab ANSWERS the worker's probe, so the worker can tell it apart
 * from a frozen one that merely still appears in `clients.matchAll`.
 */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLiveBannerReady } from './live-banner'
import { isLiveBannerProbeReply, LIVE_BANNER_PROBE, type LiveBannerProbeReply } from './live-probe'
import { useLiveBannerProbe } from './use-live-banner-probe'

class FakeSwContainer extends EventTarget {
  startMessagesCalls = 0
  startMessages(): void {
    this.startMessagesCalls++
  }
}

let container: FakeSwContainer
let original: PropertyDescriptor | undefined

beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
  container = new FakeSwContainer()
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true })
  setLiveBannerReady(false)
})

afterEach(() => {
  setLiveBannerReady(false)
  if (original) Object.defineProperty(navigator, 'serviceWorker', original)
  else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'serviceWorker')
})

/** Ask the way the worker does, and resolve with the answer (or `null` if none arrives). */
async function ask(timeoutMs = 50): Promise<boolean | null> {
  const channel = new MessageChannel()
  const answer = new Promise<boolean | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    channel.port1.onmessage = (event: MessageEvent) => {
      const reply: unknown = event.data
      if (!isLiveBannerProbeReply(reply)) return
      clearTimeout(timer)
      resolve(reply.live)
    }
  })
  container.dispatchEvent(
    new MessageEvent('message', { data: { type: LIVE_BANNER_PROBE }, ports: [channel.port2] }),
  )
  return await answer
}

describe('useLiveBannerProbe', () => {
  it('drains the container queue, or the probe times out and the reader gets two banners', () => {
    renderHook(() => useLiveBannerProbe())
    expect(container.startMessagesCalls).toBe(1)
  })

  it('answers false while no engine in this tab claims deliveries', async () => {
    renderHook(() => useLiveBannerProbe())
    expect(await ask()).toBe(false)
  })

  it('answers true once the engine has published readiness', async () => {
    renderHook(() => useLiveBannerProbe())
    setLiveBannerReady(true)
    expect(await ask()).toBe(true)
  })

  it('reads the flag at ANSWER time, not at mount time', async () => {
    // The hook mounts long before any sync pass runs; capturing the value would answer "false"
    // forever and defeat the whole guard.
    renderHook(() => useLiveBannerProbe())
    expect(await ask()).toBe(false)
    setLiveBannerReady(true)
    expect(await ask()).toBe(true)
    setLiveBannerReady(false)
    expect(await ask()).toBe(false)
  })

  it('says nothing at all once the tab has torn the listener down', async () => {
    const view = renderHook(() => useLiveBannerProbe())
    setLiveBannerReady(true)
    view.unmount()
    // Silence, not `false` — and silence is what makes the worker banner.
    expect(await ask()).toBeNull()
  })

  it('ignores a message that is not the probe', async () => {
    renderHook(() => useLiveBannerProbe())
    const channel = new MessageChannel()
    let replied: LiveBannerProbeReply | null = null
    channel.port1.onmessage = (event: MessageEvent) => {
      replied = event.data as LiveBannerProbeReply
    }
    container.dispatchEvent(
      new MessageEvent('message', { data: { type: 'NOTIFY_CLICK' }, ports: [channel.port2] }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(replied).toBeNull()
  })
})
