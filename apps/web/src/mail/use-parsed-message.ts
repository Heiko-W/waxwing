/**
 * Parse an attached `message/rfc822` into a full JMAP Email via `Email/parse` (M3.9, FR-RD-07).
 *
 * The returned Email carries its body inline in `bodyValues` (no blob fetch), and is NOT in any
 * mailbox, has no stored id, and never enters Dexie. That is deliberate on two counts:
 *  - it sidesteps the id-keyed {@link useMessageBody} — a parsed message has no id to key on; and
 *  - it never writes a blob to the replica cache, so it cannot become the kind of orphan the .eml
 *    download had to avoid (ADR-011): the eviction pass reaps any cached blob with no owner link.
 *
 * `bodyValues` MUST be named in `properties` (SP.4 caveat, plan §M3.9): omit it and Stalwart returns
 * a successful parse with an EMPTY body and no error at all.
 */

import { type Email, type Id, Methods } from '@waxwing/jmap'
import { useEffect, useState } from 'react'
import { useSession } from '../app/session/context'

export type ParsedMessageError = 'offline' | 'notParsable' | 'failed'

export interface ParsedMessage {
  readonly message: Email | null
  readonly loading: boolean
  readonly error: ParsedMessageError | null
}

/** Cap the inline body JSON, mirroring the .eml source cap (`use-message-source.ts`). */
const MAX_PARSED_BODY_BYTES = 1_000_000

// Starts LOADING, not idle: the fetch runs in a passive effect that fires AFTER the first paint, so
// an initial `loading: false, message: null` would render one frame of the "couldn't be opened"
// error before the effect swaps in the spinner. `useMessageBody` starts loading for the same reason.
const LOADING: ParsedMessage = { message: null, loading: true, error: null }

export function useParsedMessage(accountId: Id, blobId: Id): ParsedMessage {
  const { getClient } = useSession()
  const [state, setState] = useState<ParsedMessage>(LOADING)

  useEffect(() => {
    const client = getClient()
    if (client === null) {
      setState({ message: null, loading: false, error: 'offline' })
      return
    }
    // A boolean guard, not an AbortController: `RequestBuilder.send()` takes no signal, so there is
    // nothing to abort — we only ignore a late result after the row is closed (use-message-body's
    // pattern). The parse is a single small round-trip, not a streaming download.
    let cancelled = false
    setState({ message: null, loading: true, error: null })

    const run = async (): Promise<void> => {
      try {
        const builder = client.request()
        const parse = builder.invoke(Methods.emailParse, {
          accountId,
          blobIds: [blobId],
          // `bodyValues` is load-bearing (SP.4): without it the body comes back empty and silent.
          properties: [
            'messageId',
            'from',
            'to',
            'subject',
            'sentAt',
            'preview',
            'textBody',
            'htmlBody',
            'bodyValues',
          ],
          bodyProperties: [
            'partId',
            'blobId',
            'type',
            'size',
            'name',
            'disposition',
            'cid',
            'charset',
          ],
          fetchAllBodyValues: true,
          maxBodyValueBytes: MAX_PARSED_BODY_BYTES,
        })
        const response = await builder.send()
        const result = response.get(parse)
        const inner = result.parsed[blobId]
        if (cancelled) return
        if (inner === undefined) {
          // The server saw the blob but could not parse it as a message (or it is gone).
          setState({ message: null, loading: false, error: 'notParsable' })
          return
        }
        setState({ message: inner, loading: false, error: null })
      } catch (error) {
        if (cancelled) return
        // A transport failure (fetch throws TypeError) reads as offline; a method-level JMAP error
        // thrown by `response.get` is a genuine failure.
        setState({
          message: null,
          loading: false,
          error: error instanceof TypeError ? 'offline' : 'failed',
        })
      }
    }
    void run()

    return () => {
      cancelled = true
    }
  }, [accountId, blobId, getClient])

  return state
}
