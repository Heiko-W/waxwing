/**
 * Whether the browser believes it has a connection.
 *
 * Extracted from `StatusRegion`, which had it privately, because two whole screens needed it and
 * did not have it. Calendar and Files write to JMAP directly — no outbox — so every button on them
 * that CHANGES something is an online-only button, and neither checked: offline, the controls
 * stayed enabled, the write failed, and the reader was told "The calendar could not be loaded" or
 * "The server declined that". Settings has read `status.online` and disabled its controls since
 * M3.5; these two are the screens that never learned.
 *
 * What they do NOT need it for any more is READING: both screens have had a replica since K-8 and
 * D-4 and draw what they already hold. This block said "no replica" until 2026-09-01, and that
 * sentence is why the file browser's move dialog went on asking the server for every level of a
 * tree the device was holding (R-24).
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
