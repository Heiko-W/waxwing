/**
 * The page half of the double-notify guard (R-42): answer the service worker's "would you raise the
 * live banner?" question.
 *
 * The worker asks before it draws a Web Push banner and waits {@link LIVE_PROBE_ACK_MS} for an
 * answer; a tab that says nothing — frozen, throttled, gone — gets banner-ed for, which is the
 * whole point of asking rather than assuming. See `live-probe.ts` for why this is a query.
 *
 * Answering costs nothing and is not gated on the notification preferences: the worker only asks
 * when it is about to banner, and `isLiveBannerReady()` is `false` unless a sync engine in THIS tab
 * has published otherwise.
 */

import { useEffect } from 'react'
import { isLiveBannerReady } from './live-banner'
import {
  isLiveBannerProbeMessage,
  LIVE_BANNER_PROBE,
  type LiveBannerProbeReply,
} from './live-probe'

export function useLiveBannerProbe(): void {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    const container = navigator.serviceWorker
    const onMessage = (event: MessageEvent): void => {
      const data: unknown = event.data
      if (!isLiveBannerProbeMessage(data)) return
      // The reply goes back down the port the question arrived on, never through the container: the
      // worker has to be able to tell this answer from a stale one belonging to an earlier push.
      const port = event.ports[0]
      if (port === undefined) return
      const reply: LiveBannerProbeReply = { type: LIVE_BANNER_PROBE, live: isLiveBannerReady() }
      port.postMessage(reply)
    }

    container.addEventListener('message', onMessage)
    // Mandatory: a `ServiceWorkerContainer` queues messages until `onmessage` is assigned or this is
    // called, and a queued probe is a probe that times out — i.e. a duplicate banner.
    container.startMessages()
    return () => container.removeEventListener('message', onMessage)
  }, [])
}
