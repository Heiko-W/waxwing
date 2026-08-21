/**
 * The JMAP seam for sharing an address book (S-2, RFC 9610 §2 + RFC 9670).
 *
 * Online-only and outside the sync engine's replica, for the reason `mailbox-client.ts` spells out
 * at length and this type shares: the engine's `AddressBook/get` (`sync/engine/port.ts`) sends **no
 * `properties`**, and for the two neighbouring types the measured answer to "does a bare get include
 * `shareWith`" is no (`Mailbox`) and no (`Calendar`, which sends it only when named). For
 * `AddressBook` it is untested — the gap analysis lists it as an open measurement, and the "Shared"
 * badge in `contacts/AddressBookList.tsx` may have been dead since the day it was written.
 *
 * **Untested is enough to decide this.** Seeding a dialog from a replica field that might always be
 * `undefined` would show "Only you" over a shared book, and the first edit made from that view would
 * write `{}` back and revoke everyone. So the map is fetched here with an explicit `properties`,
 * which is correct under both answers and costs one round trip on a dialog that opens rarely.
 *
 * The `using` set is core + contacts, derived from the method names alone. `Principal/query` adds
 * `principals` in the same way. Nothing here opts into an extra URN: one the server does not know
 * costs the WHOLE request (HTTP 400 `notRequest`, measured), and none is needed.
 */

import type { AddressBook, Id, JmapClient, Principal } from '@waxwing/jmap'
import { Methods } from '@waxwing/jmap'
import type { AddressBookShareWith } from './addressbook-roles'
import { searchPrincipals } from './principals'

/** Why a share write failed, in the terms the UI can explain. */
export type AddressBookShareFailure = 'forbidden' | 'invalidRights' | 'rejected'

export class AddressBookShareError extends Error {
  constructor(
    readonly failure: AddressBookShareFailure,
    description?: string | null,
  ) {
    super(description ?? failure)
    this.name = 'AddressBookShareError'
  }
}

export interface AddressBookSharingClient {
  /** The grant map the server currently holds for `bookId`. `{}` when nobody has access. */
  load(bookId: Id): Promise<AddressBookShareWith>
  searchPrincipals(query: string): Promise<Principal[]>
  /** Replaces the book's WHOLE grant map. */
  setShareWith(bookId: Id, shareWith: AddressBookShareWith): Promise<void>
}

export function makeAddressBookSharingClient(
  client: JmapClient,
  accountId: Id,
  /** Excluded from principal searches. */
  selfPrincipalId: Id | null = null,
): AddressBookSharingClient {
  return {
    async load(bookId) {
      const responses = await client.call([
        [
          Methods.addressBookGet.name,
          // EXPLICIT properties — see the module note. `id` rides along so a `notFound` is legible.
          { accountId, ids: [bookId], properties: ['id', 'shareWith'] },
          'a0',
        ],
      ])
      const { list } = responses.get<{ list: Partial<AddressBook>[] }>('a0')
      return (list[0]?.shareWith ?? {}) as AddressBookShareWith
    },

    async searchPrincipals(query) {
      return await searchPrincipals(client, accountId, query, selfPrincipalId)
    },

    async setShareWith(bookId, shareWith) {
      const responses = await client.call([
        [Methods.addressBookSet.name, { accountId, update: { [bookId]: { shareWith } } }, 'a0'],
      ])
      const response = responses.get<{
        notUpdated: Record<string, { type: string; description?: string | null }> | null
      }>('a0')
      /*
       * A refusal here is PER OBJECT, not per request — `notUpdated`, with the batch intact. The one
       * that will actually happen is `invalidProperties`: measured on this very type,
       * `shareWith.<id> = { mayReadItems: true, mayAdmin: true }` came back
       * `invalidProperties: 'Invalid permission "mayReadItems".'` — a MAILBOX key offered to an
       * address book. Which is why `addressbook-roles.ts` writes its own four keys out.
       */
      const first = Object.values(response.notUpdated ?? {})[0]
      if (first !== undefined) {
        throw new AddressBookShareError(classify(first.type), first.description)
      }
    },
  }
}

function classify(type: string): AddressBookShareFailure {
  if (type === 'forbidden') return 'forbidden'
  if (type === 'invalidProperties') return 'invalidRights'
  return 'rejected'
}
