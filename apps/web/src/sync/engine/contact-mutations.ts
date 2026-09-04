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
  /**
   * One COMMIT for a block of intents, one outbox row each (N-04). Optional so a fake in a unit
   * test need only provide `dispatch`; {@link enqueueCreateContactCards} falls back to dispatching
   * one at a time when it is missing, which is exactly what it did before.
   */
  dispatchBatch?(entries: readonly { intent: OutboxIntent; options: { id: Id } }[]): Promise<void>
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
 * Rename / re-describe an address book (JMAP gap analysis, B-5). State-guarded, so a concurrent edit
 * from another client surfaces as a conflict rather than a silent last-writer-wins.
 */
export async function enqueueUpdateAddressBook(
  engine: ContactMutationDispatcher,
  bookId: Id,
  props: { name?: string; description?: string | null },
  newId: IdSource = defaultId,
): Promise<{ id: Id }> {
  const id = newId()
  await engine.dispatch({ kind: 'updateAddressBook', id: bookId, props }, { id })
  return { id }
}

/**
 * Destroy an address book together with the cards that are in NO other book (B-5; RFC 9610 §2.3
 * `onDestroyRemoveContents`, which the replay sets). State-guarded; `notFound` on replay is a success
 * ("already gone"), not an undo.
 */
export async function enqueueDeleteAddressBook(
  engine: ContactMutationDispatcher,
  bookId: Id,
  newId: IdSource = defaultId,
): Promise<{ id: Id }> {
  const id = newId()
  await engine.dispatch({ kind: 'deleteAddressBook', id: bookId }, { id })
  return { id }
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

/**
 * Create a BLOCK of cards in one commit — what the importer dispatches (N-04).
 *
 * The unit of work is unchanged: one intent, one outbox row, one undo and one `ContactCard/set`
 * create per card, so a card the server refuses dead-letters by itself. What is shared is the Dexie
 * transaction, and with it the live-query rerun that every separate commit used to cost. Measured:
 * 500 cards one at a time took 15.4 s and 500 reruns of the shared contact-card subscription; in
 * blocks of fifty, 450 ms and ten.
 *
 * Returns the creation ids in the order the cards were given, because the caller counts them.
 */
export async function enqueueCreateContactCards(
  engine: ContactMutationDispatcher,
  cards: readonly ContactCard[],
  newId: IdSource = defaultId,
): Promise<{ ids: Id[]; creationIds: Id[] }> {
  const entries = cards.map((card) => {
    const creationId = newId()
    return {
      intent: { kind: 'createContactCard', creationId, card: { ...card, id: creationId } } as const,
      options: { id: newId() },
    }
  })
  if (engine.dispatchBatch === undefined) {
    for (const entry of entries) await engine.dispatch(entry.intent, entry.options)
  } else {
    await engine.dispatchBatch(entries)
  }
  return {
    ids: entries.map((entry) => entry.options.id),
    creationIds: entries.map((entry) => entry.intent.creationId),
  }
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
