/**
 * Loads a message's full body on open (M1.8): asks the engine to `fetchBody` (into `emailBodies`,
 * cached until LRU) and subscribes to the row via liveQuery, deriving the HTML/text the renderer
 * needs. `body === undefined` means still loading.
 */

import { useEffect, useState } from 'react'
import { type EmailBodyRow, useEmailBody } from '../sync'
import { useAccountEngine } from '../sync/engine'
import { type BodyText, pickHtmlBody, pickTextBody } from './message-body'

export interface MessageBody {
  readonly body: EmailBodyRow | undefined
  readonly htmlParts: BodyText[] | null
  readonly textBody: string
  readonly loading: boolean
  /**
   * The fetch came back and there is nothing to show — offline, or the message is gone.
   *
   * `loading` alone cannot say this: it is `body === undefined`, which is also what "still on its
   * way" looks like. Without the distinction a failed fetch left four pulsing grey bars on screen
   * indefinitely, promising progress that had already stopped. `useEnsureEnvelopes` below has
   * carried the same flag under the name `settled` since M1.8, for the same reason.
   */
  readonly failed: boolean
}

export function useMessageBody(emailId: string): MessageBody {
  // The engine of THIS pane's account (M4.4 Etappe 4). `fetchBody` writes `emailBodies[[accountId,
  // id]]` under ITS OWN account, so on the wrong engine two things go wrong at once: the row never
  // lands under the account this pane reads, leaving it loading forever — and the `Email/get` runs
  // against the PRIMARY carrying the shared account's short id, caching a DIFFERENT message's body
  // into the primary's replica, where the reader will later show it as that message's content.
  const engine = useAccountEngine()

  // The body the engine fetched but could NOT cache (the disk is full, M3.4). This pane is
  // local-first — it renders from a liveQuery over `emailBodies` — so a body that never lands in the
  // replica would leave it loading FOREVER, for every message, with no retry. Caching is best-effort;
  // reading is not. `null` is the normal case: the row is in the replica, so read it from there.
  const [unstored, setUnstored] = useState<EmailBodyRow | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setUnstored(null)
    setFailed(false)
    if (emailId === '' || !engine) return
    let active = true
    void engine
      .fetchBody(emailId)
      .then((row) => {
        if (active) setUnstored(row)
      })
      // A failed fetch is REPORTED rather than swallowed. It used to leave the pane loading — the
      // comment here said so plainly ("leaves the pane loading") — which meant offline, or opening
      // a message that had since been deleted, produced a skeleton that never resolved.
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [engine, emailId])

  const stored = useEmailBody(emailId)
  const body = stored ?? unstored ?? undefined
  return {
    body,
    htmlParts: body ? pickHtmlBody(body) : null,
    textBody: body ? pickTextBody(body) : '',
    // A failed fetch is no longer loading. If the row turns up later anyway (a background sync
    // lands it), `body` wins and both flags fall away.
    loading: body === undefined && !failed,
    failed: body === undefined && failed,
  }
}

/**
 * Hydrate any envelope rows a conversation references but the replica does not yet hold (M1.8): a
 * collapsed-threads backfill stores only each thread's anchor envelope, so older/other-folder
 * members must be fetched on demand or they render as a permanent skeleton. `settled` flips true
 * once the fetch attempt completes, so the caller can tell "still loading" apart from "the message
 * genuinely does not exist" (a deep link to an unknown id) instead of spinning forever.
 *
 * @param idsKey the comma-joined member ids (a stable dependency; the array identity is not)
 */
export function useEnsureEnvelopes(idsKey: string): { settled: boolean } {
  const engine = useAccountEngine()
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',')
    if (engine === null || ids.length === 0) return
    let cancelled = false
    setSettled(false)
    void (async () => {
      try {
        await engine.fetchEnvelopes(ids)
      } catch {
        // A failed hydration leaves the member unsynced; the next sync pass retries it.
      } finally {
        if (!cancelled) setSettled(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [engine, idsKey])
  return { settled }
}
