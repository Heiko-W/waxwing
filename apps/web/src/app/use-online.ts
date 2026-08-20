/**
 * Whether the browser believes it has a connection.
 *
 * Extracted from `StatusRegion`, which had it privately, because two whole screens needed it and
 * did not have it. Calendar and Files talk to JMAP directly — no replica, no outbox — so every
 * button on them is an online-only button, and neither checked: offline, the controls stayed
 * enabled, the write failed, and the reader was told "The calendar could not be loaded" or "The
 * server declined that". Settings has read `status.online` and disabled its controls since M3.5;
 * these two are the screens that never learned.
 *
 * `navigator.onLine` is a floor rather than a guarantee — it says "there is an interface", not
 * "the server answers" — which is exactly why this only gates the OFFER of an action and never
 * replaces the failure path behind it.
 */

import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    // Server-side and in jsdom without the API: assume connected, so a test does not have to stub
    // navigator to see the normal path.
    () => true,
  )
}
