/**
 * Fetch the message texts of the list you are looking at, before you open them (M5.16).
 *
 * ## Why
 * Until this existed the body was fetched on the CLICK and only then: `useMessageBody` asks the
 * engine, the engine asks the server, and the reading pane shows a placeholder until the answer
 * lands. Every message, every time, however fast the connection. That is the difference between a
 * mail app that feels native and one that feels like a website, and it was reported as exactly that.
 *
 * The replica already made the second open instant. This makes the first one instant too.
 *
 * ## What it does NOT do
 * It does not decide anything from the connection type. `navigator.connection` is absent in WebKit
 * and reports no `type` in Chromium (measured 2026-08-22), so "only on Wi-Fi" is not implementable
 * in a browser — see the note on `usePrefetchBodies` in `reading-prefs.ts`. The user's switch is the
 * whole policy.
 *
 * ## The three bounds, and why each one is here
 *  - **{@link PREFETCH_LIMIT} messages**, not the whole window. A folder can hold 100 000, and the
 *    reader is looking at a screenful.
 *  - **One at a time.** A click during a prefetch waits for at most ONE outstanding request instead
 *    of queueing behind fifty — the reader's own fetch must never be the slowest thing in flight.
 *  - **A pause between fetches**, so a long run leaves the connection and the main thread free for
 *    whatever the reader does next. Prefetching is speculative; nothing here may outrank a real
 *    action.
 *
 * Already-cached bodies cost one indexed lookup each (`fetchBody` returns early), and ids this hook
 * has already walked are remembered for the life of the mount, so an arriving message re-runs the
 * effect without re-walking the list.
 */

import type { Id } from '@waxwing/jmap'
import { useEffect, useRef } from 'react'
import { useOnline } from '../app/use-online'
import { useAccountEngine } from '../sync/engine'
import { usePrefetchBodies as usePrefetchBodiesEnabled } from './reading-prefs'

/** How many of the window's messages to warm. A screenful and some scrolling, not a mailbox. */
export const PREFETCH_LIMIT = 25

/** Breathing room between fetches (ms) — see the header on why speculative work yields. */
const PREFETCH_GAP_MS = 150

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Warm the bodies of `ids` in the background. Safe to call with an empty or changing list; the run
 * is abandoned the moment the list changes or the component unmounts.
 */
export function usePrefetchBodies(ids: readonly Id[]): void {
  const enabled = usePrefetchBodiesEnabled()
  const engine = useAccountEngine()
  const online = useOnline()
  // Ids this mount has already walked. Keyed by the ENGINE too: switching accounts gives a different
  // engine and the same short ids mean different messages there (`useMessageBody` says why).
  const walked = useRef<{ engine: unknown; ids: Set<Id> }>({ engine: null, ids: new Set() })

  // `ids` is a fresh array on every sync, so the effect keys off its CONTENT, not its identity —
  // otherwise every delta restarts the run.
  const fingerprint = ids.slice(0, PREFETCH_LIMIT).join('|')

  useEffect(() => {
    if (!enabled || !online || !engine || fingerprint === '') return
    if (walked.current.engine !== engine) walked.current = { engine, ids: new Set() }
    const seen = walked.current.ids
    const targets = fingerprint.split('|').filter((id) => !seen.has(id))
    if (targets.length === 0) return

    let cancelled = false
    void (async () => {
      for (const id of targets) {
        if (cancelled) return
        seen.add(id)
        // One failure says nothing about the next: offline, a message destroyed server-side, a
        // quota refusal. Speculative work reports nothing and gives up on nothing.
        //
        // Wrapped rather than `.catch()`-ed, because a bare `.catch()` only handles a REJECTED
        // promise — a call that throws synchronously (an engine handed over mid-teardown, a partial
        // fake) escapes it as an unhandled rejection. Nothing this hook does may surface as an error
        // anywhere: it is work the reader did not ask for and will never miss.
        await Promise.resolve()
          .then(() => engine.fetchBody(id))
          .catch(() => undefined)
        if (cancelled) return
        await wait(PREFETCH_GAP_MS)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, online, engine, fingerprint])
}
