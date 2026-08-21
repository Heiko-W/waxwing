/**
 * Address-book actions (JMAP gap analysis, B-5) — the seam from the rail to the outbox, and the
 * contacts analogue of {@link ../mail/use-folder-actions}.
 *
 * `enqueueCreateAddressBook` had been written, tested and exported since M4.2 stage 5a and had **no
 * UI caller at all**; update and destroy did not exist. So a second address book could not be made,
 * and one that arrived from the server could be neither renamed nor removed.
 *
 * Like {@link ./use-contact-actions}, this hook only DISPATCHES — the optimistic apply, the undo and
 * the conflict handling live in the engine, and rights are enforced by the UI before an action is
 * offered. The engine is read lazily through {@link getEngineFor} so a handler always sees the
 * current one (and is a safe no-op before it has started, or where it cannot run at all).
 */

import type { Id } from '@waxwing/jmap'
import { useMemo } from 'react'
import {
  enqueueCreateAddressBook,
  enqueueDeleteAddressBook,
  enqueueUpdateAddressBook,
  getEngineFor,
} from '../sync/engine'
import { useReplicaOptional } from '../sync/react'

export interface AddressBookActions {
  /**
   * Create a book. Resolves to the id the optimistic row uses — the creation id — so the caller can
   * select it straight away; the ack re-files the row under the server's id
   * (`reconcileAddressBookCreate`) and the rail follows by name. `null` when no engine is running.
   */
  create(name: string): Promise<Id | null>
  rename(bookId: Id, name: string): void
  /** Destroy the book AND the cards that are in no other book. The caller confirms first. */
  remove(bookId: Id): void
}

export function useAddressBookActions(): AddressBookActions {
  // The engine for THIS hook's account, for the same reason `useContactActions` gives: contacts are
  // primary-only, and routing a dispatch through the ACTIVE account would create books in whichever
  // shared MAIL account the reader last opened.
  const accountId = useReplicaOptional()?.accountId ?? null
  return useMemo(
    () => ({
      create: async (name) => {
        const engine = getEngineFor(accountId)
        if (engine === null) return null
        const { creationId } = await enqueueCreateAddressBook(engine, { name })
        return creationId
      },
      rename: (bookId, name) => {
        const engine = getEngineFor(accountId)
        if (engine !== null) void enqueueUpdateAddressBook(engine, bookId, { name })
      },
      remove: (bookId) => {
        const engine = getEngineFor(accountId)
        if (engine !== null) void enqueueDeleteAddressBook(engine, bookId)
      },
    }),
    [accountId],
  )
}
