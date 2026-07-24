/**
 * Thin, typed enqueue wrappers for the contact CRUD outbox intents (M4.2, stage 5a) — the seam the
 * contact FORM (stage 5b) dispatches through, without importing the intent shapes or minting ids
 * itself. Each wrapper builds one {@link OutboxIntent}, hands it to the engine's durable {@link
 * SyncEngine.dispatch} (optimistic apply → persisted intent + undo → replay), and returns the ids it
 * generated so the caller can track the row / the optimistic creation id.
 *
 * A `ContactMutationDispatcher` — the one method these need — is accepted rather than the whole engine
 * so the module carries no import cycle and stays trivially fakeable in a unit test. `newId` is
 * injectable for the same reason (deterministic ids in tests); it defaults to `crypto.randomUUID`.
 */

import type { ContactCard, Id, PatchObject } from '@waxwing/jmap'
import type { OutboxIntent } from './outbox'

/** The slice of {@link SyncEngine} the contact wrappers use. */
export interface ContactMutationDispatcher {
  dispatch(intent: OutboxIntent, options: { id: Id }): Promise<void>
}

/** A client-generated, stable-across-retries id source. */
export type IdSource = () => Id

const defaultId: IdSource = () => crypto.randomUUID()

/**
 * Create an address book (M4.2). The optimistic book row and the `AddressBook/set create` both key
 * off `creationId`; the outbox `id` is a separate row id. Returns both so the UI can follow the
 * creation id until {@link reconcileAddressBookCreate} swaps in the server id on ack.
 */
export async function enqueueCreateAddressBook(
  engine: ContactMutationDispatcher,
  props: { name: string; description?: string | null },
  newId: IdSource = defaultId,
): Promise<{ id: Id; creationId: Id }> {
  const creationId = newId()
  const id = newId()
  await engine.dispatch({ kind: 'createAddressBook', creationId, props }, { id })
  return { id, creationId }
}

/**
 * Create a contact card (M4.2). The card's `id` is forced to the `creationId` so the optimistic row
 * and its later server-id reconciliation line up; `card.addressBookIds` MUST already name at least one
 * book (a real id, or the `creationId` of a book created in the same session — reconciliation rewrites
 * it on ack).
 */
export async function enqueueCreateContactCard(
  engine: ContactMutationDispatcher,
  card: ContactCard,
  newId: IdSource = defaultId,
): Promise<{ id: Id; creationId: Id }> {
  const creationId = newId()
  const id = newId()
  await engine.dispatch(
    { kind: 'createContactCard', creationId, card: { ...card, id: creationId } },
    { id },
  )
  return { id, creationId }
}

/** Apply a JMAP {@link PatchObject} to a card (M4.2); state-guarded, so a concurrent edit conflicts. */
export async function enqueueUpdateContactCard(
  engine: ContactMutationDispatcher,
  cardId: Id,
  patch: PatchObject,
  newId: IdSource = defaultId,
): Promise<{ id: Id }> {
  const id = newId()
  await engine.dispatch({ kind: 'updateContactCard', id: cardId, patch }, { id })
  return { id }
}

/** Delete a card (M4.2); state-guarded. `notFound` on replay is a success ("already gone"), not undo. */
export async function enqueueDeleteContactCard(
  engine: ContactMutationDispatcher,
  cardId: Id,
  newId: IdSource = defaultId,
): Promise<{ id: Id }> {
  const id = newId()
  await engine.dispatch({ kind: 'deleteContactCard', id: cardId }, { id })
  return { id }
}
