/**
 * Loads a message's full body on open (M1.8): asks the engine to `fetchBody` (into `emailBodies`,
 * cached until LRU) and subscribes to the row via liveQuery, deriving the HTML/text the renderer
 * needs. `body === undefined` means still loading.
 */

import { useEffect, useState } from 'react'
import { type EmailBodyRow, useEmailBody } from '../sync'
import { useActiveEngine } from '../sync/engine'
import { type BodyText, pickHtmlBody, pickTextBody } from './message-body'

export interface MessageBody {
  readonly body: EmailBodyRow | undefined
  readonly htmlParts: BodyText[] | null
  readonly textBody: string
  readonly loading: boolean
}

export function useMessageBody(emailId: string): MessageBody {
  const engine = useActiveEngine()

  useEffect(() => {
    if (emailId !== '') void engine?.fetchBody(emailId)
  }, [engine, emailId])

  const body = useEmailBody(emailId)
  return {
    body,
    htmlParts: body ? pickHtmlBody(body) : null,
    textBody: body ? pickTextBody(body) : '',
    loading: body === undefined,
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
  const engine = useActiveEngine()
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
