/**
 * Contact CRUD actions (M4.2, stage 5b) — the seam from the contact form/detail UI to the stage-5a
 * outbox enqueue helpers. Reads the running engine lazily via {@link getActiveEngine} so an event
 * handler always sees the current one (and is a safe no-op before the engine has started or where it
 * cannot run — jsdom, older browsers). This hook only DISPATCHES; the optimistic apply, undo and
 * conflict handling all live in the engine. Rights are enforced by the UI before an action is offered.
 */

import type { ContactCard, Id, PatchObject } from '@waxwing/jmap'
import { useMemo } from 'react'
import {
  enqueueCreateContactCard,
  enqueueDeleteContactCard,
  enqueueUpdateContactCard,
  getActiveEngine,
} from '../sync/engine'

export interface ContactActions {
  /**
   * Create a new card (its `addressBookIds` must already name at least one writable book). Resolves to
   * the id the optimistic row uses — the server `creationId` — so the caller can select the new card
   * (falls back to the card's own id when no engine is running, e.g. in a jsdom test).
   */
  create(card: ContactCard): Promise<Id>
  /** Apply a minimal {@link PatchObject} to a card (state-guarded; a concurrent edit conflicts). */
  update(cardId: Id, patch: PatchObject): void
  /** Delete a card (state-guarded). */
  remove(cardId: Id): void
}

export function useContactActions(): ContactActions {
  return useMemo(
    () => ({
      create: async (card) => {
        const engine = getActiveEngine()
        if (engine === null) return card.id
        const { creationId } = await enqueueCreateContactCard(engine, card)
        return creationId
      },
      update: (cardId, patch) => {
        const engine = getActiveEngine()
        if (engine !== null) void enqueueUpdateContactCard(engine, cardId, patch)
      },
      remove: (cardId) => {
        const engine = getActiveEngine()
        if (engine !== null) void enqueueDeleteContactCard(engine, cardId)
      },
    }),
    [],
  )
}
