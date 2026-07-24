/**
 * RFC 9610 (JMAP for Contacts) wire types: AddressBook and ContactCard, plus the argument /
 * response shapes of their methods.
 *
 * Modelled 1:1 on `mail.ts`: absent-but-nullable fields are `T | null` (not optional), while
 * genuinely optional request fields use `?`. A property the client did not request in a `/get` is
 * simply absent, so `/get` results are effectively `Partial<>` — callers that fetch a subset should
 * type the record accordingly.
 *
 * A ContactCard IS a JSContact `Card` (RFC 9553) with a JMAP identity layered on top. The `Card`
 * shape is imported from `@waxwing/jscontact` as the single source of truth — an `import type`, so
 * it is erased at build time and adds NO runtime edge to the zero-dependency client — and extended
 * with the JMAP object fields. Inheriting `Card` wholesale (rather than re-listing its properties)
 * is what keeps a card lossless across a round-trip: every JSContact property this client does not
 * model, and the `vCardProps` bag of unmapped vCard properties, ride through untouched.
 *
 * Capability URI: `urn:ietf:params:jmap:contacts`.
 */

import type { Card, Media } from '@waxwing/jscontact'
import type {
  ChangesRequest,
  ChangesResponse,
  Comparator,
  CreationId,
  FilterOperator,
  GetRequest,
  GetResponse,
  Id,
  PatchObject,
  QueryChangesRequest,
  QueryChangesResponse,
  QueryRequest,
  QueryResponse,
  SetResponse,
  UnsignedInt,
} from './core'

// ── Capability ───────────────────────────────────────────────────────────────────────

/**
 * The value stored under `account.accountCapabilities["urn:ietf:params:jmap:contacts"]`
 * (RFC 9610 §1.5). `maxAddressBooksPerCard` may be `null` (unlimited) — guard for `null` before any
 * numeric comparison.
 */
export interface ContactsCapability {
  /** Max address books a single ContactCard may belong to at once; `null` = unlimited. */
  maxAddressBooksPerCard: UnsignedInt | null
  /** Whether the user may create a new AddressBook in this account. */
  mayCreateAddressBook: boolean
}

// ── AddressBook (RFC 9610 §2) ──────────────────────────────────────────────────────────

/**
 * Per-address-book permissions (RFC 9610 §2). Server-set; a ContactCard is fetchable only if it is
 * in at least one AddressBook with `mayRead`.
 */
export interface AddressBookRights {
  /** May fetch the ContactCards in this address book. */
  mayRead: boolean
  /** May create, modify or move ContactCards in this address book. */
  mayWrite: boolean
  /** May change who this address book is shared with. */
  mayShare: boolean
  /** May delete the address book itself. */
  mayDelete: boolean
}

/**
 * An AddressBook (RFC 9610 §2). Only `name`, `description`, `sortOrder` and `isSubscribed` are
 * mutable; `id`, `isDefault` and `myRights` are server-set.
 */
export interface AddressBook {
  /** Immutable, server-set. */
  id: Id
  /** Net-Unicode display name. */
  name: string
  /** Longer human-readable description, or `null`. */
  description: string | null
  /** Sort hint; lower shown first, ties broken alphabetically by `name`. */
  sortOrder: UnsignedInt
  /** Server-set; `true` for the account's default address book (at most one per account). */
  isDefault: boolean
  /** Whether the user is subscribed to this address book. */
  isSubscribed: boolean
  /**
   * Principal id → the rights granted to that principal. `null` when the book is not shared; absent
   * unless the server implements JMAP Sharing (`urn:ietf:params:jmap:principals`).
   */
  shareWith?: Record<Id, AddressBookRights> | null
  /** Server-set effective permissions for the authenticated user. */
  myRights: AddressBookRights
}

/**
 * Filter conditions for an AddressBook query. RFC 9610 defines NO `AddressBook/query` method — an
 * account has few address books, so they are always fetched in full via `AddressBook/get` — and
 * this module registers none. The type is provided for symmetry with
 * {@link ContactCardFilterCondition} and for servers that expose a query as an extension. Multiple
 * present fields are ANDed.
 */
export interface AddressBookFilterCondition {
  /** Substring match on the name. */
  name?: string
  /** Match on subscription state. */
  isSubscribed?: boolean
}

/** An AddressBook query filter: a boolean group or a single condition. */
export type AddressBookFilter = FilterOperator | AddressBookFilterCondition

/** Arguments for `AddressBook/get` (standard `/get`, RFC 9610 §2.1). */
export type AddressBookGetRequest = GetRequest
/** Response for `AddressBook/get`. */
export type AddressBookGetResponse = GetResponse<AddressBook>

/** Arguments for `AddressBook/changes` (standard `/changes`, RFC 9610 §2.2). */
export type AddressBookChangesRequest = ChangesRequest
/** Response for `AddressBook/changes`. */
export type AddressBookChangesResponse = ChangesResponse

/** Arguments for `AddressBook/set` (standard `/set` + RFC 9610 §2.3 extras). */
export interface AddressBookSetRequest {
  accountId: Id
  ifInState?: string | null
  create?: Record<CreationId, Partial<AddressBook>> | null
  update?: Record<Id, PatchObject> | null
  destroy?: Id[] | null
  /**
   * If `true`, destroying an address book also destroys the ContactCards that are ONLY in it
   * (default `false`); otherwise a book that still contains cards cannot be destroyed.
   */
  onDestroyRemoveContents?: boolean
  /**
   * After the set succeeds, make this address book the account's default. Accepts a real id or a
   * `#<creationId>` back-reference to a book created in the same call; `null` is a no-op.
   */
  onSuccessSetIsDefault?: Id | null
}
/** Response for `AddressBook/set`. */
export type AddressBookSetResponse = SetResponse<AddressBook>

// ── ContactCard (RFC 9610 §3) ──────────────────────────────────────────────────────────

/**
 * A JSContact `Media` object (RFC 9553 §2.7.x) as it appears INSIDE a ContactCard. RFC 9610 §1.6.3
 * lets a server replace a `data:` URI with a JMAP `blobId` (uploaded / downloaded via the Blob
 * endpoints), so here `uri` is optional and a `blobId` MAY be present in its place. Extending the
 * jscontact `Media` rather than redefining it keeps that type intact and preserves every property
 * it already carries through a round-trip.
 */
export interface ContactCardMedia extends Omit<Media, 'uri'> {
  /** The media URI. Absent when the server has externalised the data as a `blobId`. */
  readonly uri?: string
  /** Blob id of externalised media data (RFC 9610 §1.6.3); stands in for a `data:` `uri`. */
  readonly blobId?: Id
}

/**
 * A ContactCard (RFC 9610 §3): a JSContact `Card` (RFC 9553) with the JMAP object layer added. The
 * `Card` body — including `vCardProps`, the vehicle by which unmapped properties survive — is
 * inherited wholesale; only `media` is overridden to admit a `blobId` (see {@link ContactCardMedia}).
 * A `/get` returns only the requested properties, so a fetched record is in practice a
 * `Partial<ContactCard>`; type the response accordingly when fetching a subset.
 */
export interface ContactCard extends Omit<Card, 'media'> {
  /** The JMAP id — server-assigned and immutable. DISTINCT from the JSContact `uid`. */
  id: Id
  /** The address books this card belongs to; MUST contain at least one entry. Mutable. */
  addressBookIds: Record<Id, true>
  /** Media (photos / logos / sounds); each entry MAY carry a `blobId` instead of a `uri`. */
  readonly media?: Readonly<Record<Id, ContactCardMedia>>
}

/** Filter conditions for `ContactCard/query` (RFC 9610 §3.3.1). Multiple present fields are ANDed. */
export interface ContactCardFilterCondition {
  /** Card is in this address book. */
  inAddressBook?: Id
  /** Exact JSContact `uid` match. */
  uid?: string
  /** Card is a group (`kind: "group"`) whose members include this uid. */
  hasMember?: string
  /** Exact `kind` match (`individual`, `group`, `org`, …). */
  kind?: string
  /** Server-defined free-text match across the whole card. */
  text?: string
  /** Match against the full / structured name. */
  name?: string
  /** Match against the given name. */
  'name/given'?: string
  /** Match against the surname. */
  'name/surname'?: string
  /** Match against any nickname. */
  nickName?: string
  /** Match against any organization name. */
  organization?: string
  /** Match against any email address. */
  email?: string
  /** Match against any phone number. */
  phone?: string
  /** Match against any online-service handle. */
  onlineService?: string
  /** Match against any postal address. */
  address?: string
  /** Match against any note. */
  note?: string
}

/** A `ContactCard/query` filter: a boolean group or a single condition. */
export type ContactCardFilter = FilterOperator | ContactCardFilterCondition

/**
 * A sort comparator for `ContactCard/query` (RFC 9610 §3.3.2). Servers MUST support sorting on
 * `created` and `updated`, and SHOULD support `name/given` and `name/surname`. There are no
 * comparator-specific properties beyond the standard {@link Comparator}.
 */
export type ContactCardComparator = Comparator

/** Arguments for `ContactCard/get` (standard `/get`, RFC 9610 §3.1). */
export type ContactCardGetRequest = GetRequest
/**
 * Response for `ContactCard/get`. Generic over the record type so callers fetching a subset can
 * pass a narrowed `Partial<ContactCard>`; defaults to the full {@link ContactCard}.
 */
export type ContactCardGetResponse<T = ContactCard> = GetResponse<T>

/** Arguments for `ContactCard/changes` (standard `/changes`, RFC 9610 §3.2). */
export type ContactCardChangesRequest = ChangesRequest
/** Response for `ContactCard/changes`. */
export type ContactCardChangesResponse = ChangesResponse

/** Arguments for `ContactCard/query` (standard `/query`, RFC 9610 §3.3). */
export type ContactCardQueryRequest = Omit<QueryRequest, 'filter' | 'sort'> & {
  filter?: ContactCardFilter | null
  sort?: ContactCardComparator[] | null
}
/** Response for `ContactCard/query`. */
export type ContactCardQueryResponse = QueryResponse

/** Arguments for `ContactCard/queryChanges` (RFC 9610 §3.4). `filter`/`sort` MUST match the original query. */
export type ContactCardQueryChangesRequest = Omit<QueryChangesRequest, 'filter' | 'sort'> & {
  filter?: ContactCardFilter | null
  sort?: ContactCardComparator[] | null
}
/** Response for `ContactCard/queryChanges`. */
export type ContactCardQueryChangesResponse = QueryChangesResponse

/** Arguments for `ContactCard/set` (standard `/set`, RFC 9610 §3.5). */
export interface ContactCardSetRequest {
  accountId: Id
  ifInState?: string | null
  create?: Record<CreationId, Partial<ContactCard>> | null
  update?: Record<Id, PatchObject> | null
  destroy?: Id[] | null
}
/** Response for `ContactCard/set`. */
export type ContactCardSetResponse = SetResponse<ContactCard>
