/**
 * Fetch the card a route names when nothing else has (F3) — the contacts analogue of
 * {@link ../mail/useMessageBody.useEnsureEnvelopes}.
 *
 * Contact rows reach the replica through ONE path: the watched `ContactCard/query` the list pane
 * registers ({@link ./use-contact-search}). That made the list the sole supplier and the detail pane
 * a reader of whatever the list had already fetched — an arrangement that holds only where the two
 * are on screen together. They are not on a phone: `computePaneLayout` shows list XOR detail below
 * 40em, so opening `/contacts/~all/<id>` in a fresh session mounts the detail with no list behind
 * it, no query is ever registered, and the card never arrives. The pane settled on "This contact is
 * not available." and stayed there — permanently, for a contact that exists — while the same URL
 * worked on a tablet, where the list is mounted beside it. Deep links are the normal case since the
 * `~all` scope gave every row a URL, so this is what a shared or bookmarked contact link does.
 *
 * `fetching` is TRUE only while a fetch can still change the answer, which is what the caller needs
 * to keep "not available" apart from "on its way". It is derived rather than stored so it is already
 * true on the first render: a `useState(false)` flipped in an effect would leave one frame in which
 * the replica has answered "no row" and nothing is known to be in flight — the error state, drawn
 * and then withdrawn.
 *
 * With no engine (a component test, or the window between sign-in and the engine fleet starting)
 * there is nothing that could fetch, so `fetching` is false and the caller reports what the replica
 * says. That is the pre-existing behaviour of every contacts pane, and the reason this hook cannot
 * simply start out "loading".
 */

import type { Id } from '@waxwing/jmap'
import { useEffect, useState } from 'react'
import { useAccountEngine } from '../sync/engine'

export function useEnsureContactCard(cardId: Id | undefined): { fetching: boolean } {
  const engine = useAccountEngine()
  // The id whose fetch has run to completion — not a boolean, so a route change to another card
  // cannot be answered with the previous card's "done".
  const [settledId, setSettledId] = useState<Id | null>(null)

  useEffect(() => {
    if (engine === null || cardId === undefined || cardId === '') return
    let cancelled = false
    void (async () => {
      try {
        await engine.fetchContactCards([cardId])
      } catch {
        // Offline, or a card the server will not hand out. Either way the replica has nothing to
        // show and the pane must say so rather than wait: the next sync pass retries.
      } finally {
        if (!cancelled) setSettledId(cardId)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [engine, cardId])

  const wanted = cardId !== undefined && cardId !== ''
  return { fetching: wanted && engine !== null && settledId !== cardId }
}
