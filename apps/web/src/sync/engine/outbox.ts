/**
 * Action queue / outbox (M1.3 skeleton, M3.3 hardening — FR-OFF-03, FR-ORG-01, FR-LST-04). Every
 * write — even "mark read" — is an idempotent JMAP `set` intent with a client id: it is applied to
 * the replica optimistically (instant UI), enqueued durably, then replayed against the server.
 *
 * ## The M3.3 contract (never silent data loss)
 *  - **Durable undo.** {@link applyOptimistic} returns an {@link OutboxUndo} *value* (not a closure)
 *    that is persisted on the row. `status === 'error' && undo != null` ⇒ *a rollback is still
 *    OWED*; {@link drainOwedUndos} retries it at the start of every pass, and it is nulled only once
 *    applied. So a rollback survives a reload, a tab hand-over and an outage.
 *  - **Transient ≠ failed.** A network/5xx/429/`serverFail` failure backs the row off and leaves it
 *    `pending` — FOREVER if need be. It is never rolled back and never dead-lettered.
 *  - **Per-object rejections.** A rejection is classified and undone PER FAILED ID: a 500-id destroy
 *    with one `notFound` no longer restores 500 messages, and `notFound` on a destroy is a SUCCESS
 *    ("already gone"), not a resurrection.
 *  - **Dead letters are surfaced.** A row that fails permanently is rolled back, marked `error` with
 *    an {@link OutboxConflict}, and shown to the user (retry / discard) — never silently retried,
 *    never silently dropped.
 *  - **"Instant UI" includes the LIST** (M3.8/M3.10). The list renders the cached `queryCache` window,
 *    not a local re-sort of `emails`, so an optimistic move/destroy/**keyword change** prunes the
 *    message out of the windows it left — in the SAME transaction as the envelope patch (see
 *    {@link updateWindows}). Without that an archived row only vanished when the server's push echoed
 *    the change back: never offline, and not at all if the archive beat the push channel's connect.
 *    A keyword change reaches the same windows through {@link filterPinsKeyword}: marking a message
 *    read prunes it out of `is:unread`, stripping a label prunes it out of that `?label=` view, and a
 *    keyword the window SORTS on ({@link sortUsesKeyword}, the "Unread first" toggle) voids its
 *    baseline so the server re-places the row — whether or not that window currently LISTS the message,
 *    because a keyword sort is also how a message arrives in one. The ARRIVAL half is symmetric where
 *    it can be: a move
 *    into a window whose filter and sort are locally reproducible SPLICES the row in
 *    ({@link placeArrival}) instead of only voiding — offline nothing else ever would, which made
 *    Undo look broken.
 *
 * Classification lives in `conflict.ts`, the retry curve in `backoff.ts`; this module owns the
 * replica mutations and the queue state machine.
 */

import type {
  AddressBook,
  ContactCard,
  EmailComparator,
  EmailCreate,
  EmailFilter,
  Envelope,
  Id,
  Mailbox,
  PatchObject,
} from '@waxwing/jmap'
import {
  type ConflictCode,
  type ContactCardRow,
  type EmailEnvelopeInput,
  type EmailRow,
  type OutboxConflict,
  type OutboxRow,
  type OutboxUndo,
  type QueryCacheRow,
  type ReplicaDb,
  scopeKey,
  toMailboxRow,
} from '../db'
import {
  deleteAddressBooks,
  deleteContactCards,
  deleteDraft,
  deleteEmails,
  deleteMailbox,
  emailsByIds,
  enqueue,
  failedOutbox,
  pendingOutbox,
  putAddressBooks,
  putContactCards,
  putEmails,
  unsentOutbox,
} from '../repo'
import {
  backoffDelayMs,
  DEFAULT_OUTBOX_BACKOFF,
  MAX_REFRESHES,
  type OutboxBackoff,
  STUCK_AFTER_ATTEMPTS,
} from './backoff'
import { classifySetError, classifyThrown, isAuthExpiry, thrownErrorType } from './conflict'
import type { MailboxCountWrites } from './delta'
import type { JmapPort, PortSetError, PortSetResult } from './types'

// ---------------------------------------------------------------------------------------------
// Intent model.
// ---------------------------------------------------------------------------------------------

export type OutboxIntent =
  | {
      readonly kind: 'setKeywords'
      readonly emailIds: Id[]
      readonly keyword: string
      readonly value: boolean
    }
  | { readonly kind: 'move'; readonly emailIds: Id[]; readonly from: Id | null; readonly to: Id }
  | { readonly kind: 'destroyEmails'; readonly emailIds: Id[] }
  | {
      readonly kind: 'createMailbox'
      readonly creationId: string
      /**
       * Deliberately WITHOUT `role`. The field was here from the start and no caller ever set one
       * (JMAP gap analysis, I-3): the New-folder affordance asks for a name and a parent, which is
       * all Apple Mail asks for either. Setting a role at create time is not the same operation as
       * naming a folder, and it already has its own intent — `updateMailbox { props: { role } }`
       * (M-6). An optional property nobody writes is a claim that the create dialog offers
       * something it does not, and it made `createMailbox` and `updateMailbox` look like two ways
       * to do one thing.
       */
      readonly props: {
        readonly name: string
        readonly parentId: Id | null
        /**
         * Where the folder lands among its siblings. Omitted for a group nobody has ordered by
         * hand, which leaves the server's 0 and RFC 8621's alphabetical tie-break in place.
         */
        readonly sortOrder?: number
      }
    }
  | { readonly kind: 'renameMailbox'; readonly id: Id; readonly name: string }
  | { readonly kind: 'moveMailbox'; readonly id: Id; readonly parentId: Id | null }
  | { readonly kind: 'deleteMailbox'; readonly id: Id }
  | {
      /**
       * The two mutable Mailbox properties that are neither a name nor a parent (JMAP gap analysis
       * M-5/M-6): `role` — what other clients read to recognise a folder as the Archive — and
       * `isSubscribed`, JMAP's own "do not show me this folder". Only the properties present are
       * written, so this is one intent rather than two nearly identical ones.
       */
      readonly kind: 'updateMailbox'
      readonly id: Id
      readonly props: { readonly role?: string | null; readonly isSubscribed?: boolean }
    }
  | {
      /**
       * A whole sibling group's `sortOrder` in ONE `Mailbox/set` (JMAP gap analysis M-5). A drag
       * across four folders is one request, not four — the same "one save per drop" rule ADR-026
       * set for the filter list.
       */
      readonly kind: 'reorderMailboxes'
      readonly order: ReadonlyArray<{ readonly id: Id; readonly sortOrder: number }>
    }
  | {
      // Save a draft (M2.6): a content change is create-new + destroy-old in ONE Email/set, because
      // an Email is immutable except keywords/mailboxIds (RFC 8621 §4.6).
      readonly kind: 'saveDraft'
      readonly localId: string
      readonly creationId: string
      readonly priorServerId: Id | null
      readonly email: EmailCreate
    }
  | { readonly kind: 'discardDraft'; readonly localId: string; readonly serverEmailId: Id }
  | {
      // Send a draft (M2.8): create the Email + submit it in ONE request (port.submitEmail), with
      // `onSuccessUpdateEmail` refiling Drafts→Sent + clearing `$draft`. Dispatched with a `notBefore`
      // grace timestamp so an Undo can delete the row before it replays.
      readonly kind: 'sendEmail'
      readonly localId: string
      readonly emailCreationId: string
      readonly submissionCreationId: string
      readonly priorServerId: Id | null
      readonly email: EmailCreate
      readonly identityId: Id
      readonly envelope: Envelope
      readonly onSuccessUpdateEmail: PatchObject
      readonly source: { readonly emailId: Id; readonly keyword: '$answered' | '$forwarded' } | null
    }
  // ── Contacts (M4.2, RFC 9610) ──────────────────────────────────────────────────────────────
  // A ContactCard is a standalone object with create/update/destroy over `ContactCard/set`, exactly
  // like a Mailbox over `Mailbox/set` — so these MIRROR `createMailbox`/`renameMailbox`/`deleteMailbox`
  // (creation-id flow for the create, prior-state undo for update/delete). The AddressBook trio is
  // the same shape one level up (JMAP gap analysis B-5: create existed and had no caller; update and
  // destroy did not exist at all, so a second address book could be neither renamed nor removed).
  | {
      /** Create a card in one or more address books; the full JSContact card rides along with its `id`
       *  set to `creationId` until the server acks (then {@link reconcileContactCardCreate} swaps it). */
      readonly kind: 'createContactCard'
      readonly creationId: string
      readonly card: ContactCard
    }
  | { readonly kind: 'updateContactCard'; readonly id: Id; readonly patch: PatchObject }
  | { readonly kind: 'deleteContactCard'; readonly id: Id }
  | {
      readonly kind: 'createAddressBook'
      readonly creationId: string
      readonly props: { readonly name: string; readonly description?: string | null }
    }
  | {
      /** Rename / re-describe a book. Only the properties present are written. */
      readonly kind: 'updateAddressBook'
      readonly id: Id
      readonly props: { readonly name?: string; readonly description?: string | null }
    }
  | {
      /**
       * Destroy a book WITH its contents (RFC 9610 §2.3 `onDestroyRemoveContents`) — the cards that
       * are in no other book go with it. The flag is not optional here: without it a book that still
       * holds a card cannot be destroyed at all, and "delete this list" would fail for the only
       * reason anyone ever has a list. The UI says so before it dispatches.
       */
      readonly kind: 'deleteAddressBook'
      readonly id: Id
    }

/**
 * The JMAP type whose `state` string guards an intent's `/set` with `ifInState` (M3.3, Q3), or `null`
 * for an unguarded intent. `Email/set` stays unguarded (its state is account-global and advances on
 * every inbound message); a `create` is unguarded too (appending a new object depends on no prior
 * state). Update/delete of a rarely-churning object ARE guarded, so a concurrent edit by another
 * client surfaces as a gentle notice rather than a silent last-writer-wins — the FR-OFF-03 case.
 */
export type GuardedType = 'Mailbox' | 'ContactCard' | 'AddressBook'

export function stateGuardType(kind: OutboxIntent['kind']): GuardedType | null {
  switch (kind) {
    case 'renameMailbox':
    case 'moveMailbox':
    case 'deleteMailbox':
    case 'updateMailbox':
    case 'reorderMailboxes':
      return 'Mailbox'
    case 'updateContactCard':
    case 'deleteContactCard':
      return 'ContactCard'
    case 'updateAddressBook':
    case 'deleteAddressBook':
      return 'AddressBook'
    default:
      return null
  }
}

/** Full permissive rights for an optimistically-created folder (the server corrects them on sync). */
const OPTIMISTIC_RIGHTS = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
  mayShare: false,
}

/** Full permissive rights for an optimistically-created address book (M4.2; server corrects on sync). */
const OPTIMISTIC_BOOK_RIGHTS = {
  mayRead: true,
  mayWrite: true,
  mayShare: true,
  mayDelete: true,
}

/** The card fields for a `ContactCard/set create` — the stored row minus its (server-assigned) `id`
 *  and the derived replica columns (`accountId`, `abk`, recomputed by {@link toContactCardRow}). */
function cardCreateProps(card: ContactCard): Partial<ContactCard> {
  const props: Record<string, unknown> = { ...card }
  delete props.id
  return props as Partial<ContactCard>
}

/** Strip a stored {@link ContactCardRow} back to its JMAP {@link ContactCard} (drops `accountId`/`abk`). */
function rowToCard(row: ContactCardRow): ContactCard {
  const card: Record<string, unknown> = { ...row }
  delete card.accountId
  delete card.abk
  return card as unknown as ContactCard
}

/**
 * Apply a JMAP {@link PatchObject} (RFC 8620 §5.3) to a copy of `target`, for the OPTIMISTIC preview
 * of a `ContactCard/set update`. Keys are `/`-separated RFC 6901 JSON Pointers into the object;
 * a `null` value REMOVES the pointed-at property (§5.3). This is a best-effort local render — the
 * next `ContactCard/changes` delta reconciles the canonical server form, and the exact rollback is
 * the persisted prior row, not a re-derivation — so it need only be faithful for the common patch
 * shapes an edit form produces (top-level replace, map-entry set, map-entry remove).
 */
function applyPatchObject<T extends object>(target: T, patch: PatchObject): T {
  const root = structuredClone(target) as unknown as Record<string, unknown>
  for (const [pointer, value] of Object.entries(patch)) {
    const tokens = pointer.split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
    let node: Record<string, unknown> = root
    let ok = true
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const token = tokens[i] as string
      const next = node[token]
      if (next === null || typeof next !== 'object' || Array.isArray(next)) {
        // The parent is missing or not an object map: `null` removal is already a no-op, otherwise
        // create the intermediate map so a set can land (JSContact sub-objects are id-keyed maps).
        if (value === null) {
          ok = false
          break
        }
        const created: Record<string, unknown> = {}
        node[token] = created
        node = created
      } else {
        node = next as Record<string, unknown>
      }
    }
    if (!ok) continue
    const leaf = tokens[tokens.length - 1] as string
    if (value === null) delete node[leaf]
    else node[leaf] = value
  }
  return root as unknown as T
}

// ---------------------------------------------------------------------------------------------
// Optimistic apply + its persisted undo.
// ---------------------------------------------------------------------------------------------

/** Copy an {@link EmailRow} back to its envelope input (drops accountId + the derived amb/akw). */
function toEnvelope(row: EmailRow): EmailEnvelopeInput {
  return {
    id: row.id,
    blobId: row.blobId,
    threadId: row.threadId,
    mailboxIds: row.mailboxIds,
    keywords: row.keywords,
    size: row.size,
    receivedAt: row.receivedAt,
    sentAt: row.sentAt,
    from: row.from,
    to: row.to,
    cc: row.cc,
    replyTo: row.replyTo,
    subject: row.subject,
    messageId: row.messageId,
    inReplyTo: row.inReplyTo,
    references: row.references,
    preview: row.preview,
    hasAttachment: row.hasAttachment,
  }
}

function present(rows: (EmailRow | undefined)[]): EmailRow[] {
  return rows.filter((row): row is EmailRow => row !== undefined)
}

// ---------------------------------------------------------------------------------------------
// The cached list windows (M3.8) — the OTHER half of an optimistic move/destroy.
//
// The message list renders `queryCache[key].ids` VERBATIM (the server-ordered window; `emails` is a
// row cache, never a local re-sort). So patching `emails.mailboxIds` was only half the apply: until
// the WINDOW drops the id, an archived message keeps rendering in the folder it just left — and
// nothing local ever fixed that. `dispatch` triggers a REPLAY-ONLY pass (no `reconcileWatched`), so
// the row disappeared only when the SERVER's push echoed the change back: never while offline, and
// not at all when the archive happened before the push channel finished connecting.
//
// THE INVARIANT THAT MAKES THAT SAFE (and the one whose absence broke Undo — see below):
//
//   A window whose cached `ids` we edited locally, or whose membership we know is about to change
//   but cannot place, is no longer the baseline `Email/queryChanges` computes its delta against.
//   Its `queryState` MUST be voided (`null` ⇒ `reconcileQuery` takes the `fullRequery` branch).
//
// Why it is not optional: archive `e1` (the Inbox window drops the id), then Undo — which dispatches
// the INVERSE move, archive → inbox. Server-side the message leaves the Inbox and comes straight back:
// a NET-ZERO change. `queryChanges` since the state we still held truthfully reports "nothing changed",
// that empty delta is applied to our already-pruned `ids`, and the Inbox window stays PERMANENTLY short
// of a message that is sitting in the Inbox — the Undo button is decorative. Voiding the state costs a
// full re-query of one window; keeping it costs a wrong list.
//
// THE ARRIVAL HALF, and why it needed its own answer (M3.10, gap B2).
//
// Until M3.10 a departure was pruned locally but an ARRIVAL only voided the baseline and waited for a
// re-query — and OFFLINE there is nothing to re-query (`runReplay` puts the whole replay +
// `reconcileWatched` block behind `isOnline()`; engine.ts). So archiving a message offline made the row
// vanish instantly, and UNDOING it put the message back in the replica but NOT back in the list until
// reconnect. The Undo button worked and looked broken, which is worse than not working.
//
// So a locally computable arrival IS now spliced in — under a gate that refuses everything it cannot
// evaluate ({@link placeArrival}):
//   - the window's whole filter must be evaluable against the envelope ({@link windowAcceptsLocally}),
//   - every comparator must be one we can reproduce ({@link localSortKey}: `receivedAt`, `size`,
//     `hasKeyword` — never `from`/`subject`, whose collation is the server's),
//   - every neighbour in the window must have its envelope in the replica (a window is written BEFORE
//     its envelopes — backfill.ts — so this is a real, transient state, not a theoretical one),
//   - under `collapseThreads` the arriving message's thread must not already be represented.
// Any failure ⇒ exactly the old behaviour, void-only. The window is ALSO voided on success: our index
// is a good guess, not the server's answer, and `queryChanges` against a baseline whose ids we edited
// is the lie the invariant above forbids. `fullRequery` replaces `ids` wholesale (delta.ts), so
// insert-then-requery converges and can never duplicate.
//
// TWO THINGS THIS IS HONEST ABOUT rather than claiming to have solved:
//  - Under `collapseThreads` — which is the DEFAULT for every folder list (backfill.ts, and
//    `use-message-list.ts` passes `collapseThreads: !flat` with `flat` false) — the POSITION is a
//    guess too, not only the preview line. The server orders collapsed results by a key it picks for
//    the THREAD, which need not be the representative envelope it handed us. This is a heuristic that
//    the next reconcile corrects, and it beats showing nothing at all. Do not call it provable.
//  - Online the correction is DOUBLE-gated: `runReplay` only calls `reconcileWatched` once the outbox
//    queue has DRAINED (engine.ts). During a triage burst a locally placed row keeps our index across
//    several passes. That is the point — it is coherent and it is there — but it is not "one pass".
//
// The window's LENGTH is deliberately preserved on an incomplete window: the splice is followed by
// dropping the last id. A cached window is the head page `position: 0` of the server's result, and
// `loadMore` pages by `position: ids.length` (backfill.ts) — so pushing the oldest loaded row out of
// the slice is exactly what the server did, and it is re-fetched at that same position. Letting
// `ids.length` grow instead would ratchet `reconcileQuery`'s `windowLimit`
// (`Math.max(row.ids.length, DEFAULT_WINDOW_LIMIT)`, delta.ts) up by one PERMANENTLY per arrival, and
// would re-arm `MessageList`'s load-more guard (which keys off `ids.length`). A COMPLETE window
// (`ids.length >= total`) keeps every id — there is no page behind it to push a row into.
// ---------------------------------------------------------------------------------------------

/**
 * Does EVERY message matching `filter` necessarily live in `mailboxId`? That implication is what lets
 * us say a message LEFT the window when it leaves the mailbox — and, read the other way, that it
 * ENTERED the window when it arrives there.
 *
 * `AND` is the only operator that carries it: an `OR` could still match on its other branch, and under
 * a `NOT` the condition is inverted. Everything without such a condition — a search (`text:`), a label
 * window (`hasKeyword`) — is left alone BY THIS PREDICATE: those are snapshots that legitimately keep
 * a message which merely changed FOLDER. (A keyword change reaches them instead through
 * {@link filterPinsKeyword} — the two predicates are siblings, deliberately not one generalised
 * function: this one's proof is about `inMailbox`, and three comments name it by that.) (Being pinned
 * to the mailbox is necessary, not sufficient, for an ARRIVAL: an `AND(inMailbox, after)` window may
 * still reject the message on its other conditions. That only costs a re-query that changes nothing —
 * never a wrong row.)
 */
function filterPinsMailbox(filter: EmailFilter | null, mailboxId: Id): boolean {
  if (filter === null) return false
  if ('operator' in filter) {
    if (filter.operator !== 'AND') return false
    return filter.conditions.some((condition) =>
      filterPinsMailbox(condition as EmailFilter, mailboxId),
    )
  }
  return filter.inMailbox === mailboxId
}

/**
 * The keyword sibling of {@link filterPinsMailbox} (M3.10): does EVERY message matching `filter`
 * necessarily carry `keyword` (`present`) / necessarily NOT carry it (`!present`)?
 *
 * Read at the polarity a `setKeywords` is WRITING, that single question answers both halves:
 *  - mark read (`$seen := true`) ⇒ a window pinned to `notKeyword:$seen` (`?q=is:unread`) provably no
 *    longer matches the message — **prune** it, same frame, online or off;
 *  - mark read ⇒ a window pinned to `hasKeyword:$seen` (`?q=is:read`) MAY newly match — **void** it,
 *    because only the server can say where the row lands in its collation;
 *  - strip a label (`work := false`) ⇒ `hasKeyword:work` (the `?label=work` view) — prune;
 *  - add a label ⇒ `notKeyword:work` — void.
 *
 * `AND`-only for the same reason as its sibling, and an ALLOW-LIST by construction: only `hasKeyword`
 * and `notKeyword` are understood, and anything else answers `false`. In particular the THREE
 * thread-level conditions — `allInThreadHaveKeyword`, `someInThreadHaveKeyword`,
 * `noneInThreadHaveKeyword` (RFC 8621 §4.4.1) — are ignored ON PURPOSE and must stay that way: they
 * are properties of a THREAD, and one message's keyword can neither prove nor disprove them (marking
 * one message read says nothing about `allInThreadHaveKeyword:$seen`). They are one autocomplete away
 * from being "helpfully" added here; adding them would prune rows that still belong in the window.
 *
 * Note that `EmailFilterCondition` allows several keys on ONE object (implicitly ANDed, RFC 8621
 * §4.4.1), so this tests the individual field rather than asserting the condition has a single key.
 */
function filterPinsKeyword(filter: EmailFilter | null, keyword: string, present: boolean): boolean {
  if (filter === null) return false
  if ('operator' in filter) {
    if (filter.operator !== 'AND') return false
    return filter.conditions.some((condition) =>
      filterPinsKeyword(condition as EmailFilter, keyword, present),
    )
  }
  return present ? filter.hasKeyword === keyword : filter.notKeyword === keyword
}

/**
 * The comparator properties that take a `keyword` (RFC 8621 §4.4.2). Checked so a nonsense comparator
 * — `{property:'receivedAt', keyword:'$seen'}` is structurally legal, {@link EmailComparator} carries
 * `keyword` as an optional extra on ANY property — does not buy a pointless full re-query.
 */
const KEYWORD_SORT_PROPERTIES: ReadonlySet<string> = new Set([
  'hasKeyword',
  'allInThreadHaveKeyword',
  'someInThreadHaveKeyword',
])

/**
 * Does the window's ORDER depend on this keyword? A keyword change can leave a window's MEMBERSHIP
 * untouched and still make its cached order wrong: with the shipped "Unread first" toggle the stored
 * sort is `[{property:'hasKeyword', keyword:'$seen', isAscending:true}, …]`, so marking a message read
 * has to move it down — and nothing local re-sorts (the list renders `ids` verbatim), so without this
 * the just-read row stayed pinned to the top until the server echoed. The same sort is also how a
 * message ARRIVES in a window it was not listed in, which is why {@link updateWindows} asks this of
 * every window and not only of the ones that hold the id.
 *
 * The answer is always a VOID, never a re-order: the position is the server's to compute. Because it
 * is void-only, the thread-level comparators are INCLUDED here even though the identical field names
 * are refused in {@link filterPinsKeyword} — a superfluous re-query is safe, a wrong prune is not.
 */
function sortUsesKeyword(sort: EmailComparator[] | null, keyword: string): boolean {
  return (
    sort?.some((c) => c.keyword === keyword && KEYWORD_SORT_PROPERTIES.has(c.property)) === true
  )
}

/**
 * Does `row` provably satisfy EVERY condition of `filter` (M3.10, gap B2)? The question
 * {@link filterPinsMailbox} deliberately does NOT answer: it proves only that the window is pinned to
 * the destination mailbox, which is *necessary, not sufficient* — a folder window's real filter is
 * `AND(inMailbox, after: <cacheDays boundary>)` (backfill.ts), so a message moved into the Inbox that
 * is older than the horizon does NOT belong in that window and must not be spliced into it.
 *
 * A strict ALLOW-LIST over the condition KEYS, and it must stay one. `false` here means "not proven",
 * which conflates "does not match" with "cannot tell" — sound only under `AND` (an unprovable branch
 * makes the whole conjunction unprovable, so we fall back to the void). That is why `OR` and `NOT` are
 * refused outright rather than given `some`/negation semantics, and why the free-text and header
 * conditions (`text`, `body`, `from`, `subject`, `header`, `hasAttachment`, the three thread-level
 * keyword conditions, `inMailboxOtherThan`, `minSize`/`maxSize`) all fall through to `false`: the
 * server owns their semantics, and a wrong `true` renders a row that does not belong in the list.
 *
 * `EmailFilterCondition` may carry SEVERAL keys on one object, implicitly ANDed (RFC 8621 §4.4.1), so
 * every present key is checked — an unknown one anywhere refuses the whole condition. Values are
 * type-narrowed rather than trusted: this filter was persisted by an older build and read back.
 */
function windowAcceptsLocally(filter: EmailFilter | null, row: EmailEnvelopeInput): boolean {
  // A window with no filter matches every message. Unreachable in practice (`entered` requires a
  // proven `inMailbox` pin, which a null filter cannot give) but stated rather than left to luck.
  if (filter === null) return true
  if ('operator' in filter) {
    if (filter.operator !== 'AND') return false
    return filter.conditions.every((condition) =>
      windowAcceptsLocally(condition as EmailFilter, row),
    )
  }
  const receivedAt = Date.parse(row.receivedAt)
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (value === undefined) continue
    switch (key) {
      case 'inMailbox':
        if (typeof value !== 'string' || row.mailboxIds[value] !== true) return false
        break
      case 'after': {
        // RFC 8621 §4.4.1: `after` is `receivedAt >= value`, `before` is `receivedAt < value`.
        if (typeof value !== 'string') return false
        const bound = Date.parse(value)
        if (!Number.isFinite(receivedAt) || !Number.isFinite(bound) || receivedAt < bound) {
          return false
        }
        break
      }
      case 'before': {
        if (typeof value !== 'string') return false
        const bound = Date.parse(value)
        if (!Number.isFinite(receivedAt) || !Number.isFinite(bound) || receivedAt >= bound) {
          return false
        }
        break
      }
      case 'hasKeyword':
        if (typeof value !== 'string' || row.keywords[value] !== true) return false
        break
      case 'notKeyword':
        if (typeof value !== 'string' || row.keywords[value] === true) return false
        break
      default:
        // Not understood ⇒ not proven. The caller falls back to voiding the window.
        return false
    }
  }
  return true
}

/**
 * The window's sort reduced to a numeric key for `row`, or `null` when this sort is not locally
 * reproducible (M3.10, gap B2). Keys are compared element-wise; descending comparators are negated at
 * build time so the comparison is uniformly ascending.
 *
 * An ALLOW-LIST on `property`, and — unlike {@link sortUsesKeyword} — it has no choice: `Comparator`
 * types `property` as a bare `string` (RFC 8620 §5.5), so a deny-list would silently give a future or
 * unknown comparator `receivedAt` semantics. Three traps live here:
 *  - `from` and `subject` are refused ON PURPOSE, not by oversight. They sort by STRING COLLATION —
 *    the server's locale, case and `collation` rules — which is not reproducible client-side.
 *  - `allInThreadHaveKeyword` / `someInThreadHaveKeyword` carry a `keyword` exactly like `hasKeyword`
 *    does (mail.ts), so a "has a keyword field" test would accept them and get them WRONG: they are
 *    properties of the whole thread, whose other envelopes the replica does not guarantee to hold.
 *  - `isAscending` is OPTIONAL and defaults to TRUE (core.ts), so the test is `=== false`, never
 *    `!c.isAscending` — which would read an omitted flag as descending.
 * `collation` is ignored because none of the three accepted properties is a string.
 */
function localSortKey(sort: EmailComparator[] | null, row: EmailEnvelopeInput): number[] | null {
  if (sort === null || sort.length === 0) return null
  const key: number[] = []
  for (const comparator of sort) {
    let value: number
    switch (comparator.property) {
      case 'receivedAt': {
        const at = Date.parse(row.receivedAt)
        if (!Number.isFinite(at)) return null
        value = at
        break
      }
      case 'size':
        if (!Number.isFinite(row.size)) return null
        value = row.size
        break
      case 'hasKeyword':
        // Ascending puts messages WITHOUT the keyword first — which is what makes the shipped
        // "Unread first" toggle (`hasKeyword $seen` ascending) put unread mail on top.
        if (typeof comparator.keyword !== 'string') return null
        value = row.keywords[comparator.keyword] === true ? 1 : 0
        break
      default:
        return null
    }
    key.push(comparator.isAscending === false ? -value : value)
  }
  return key
}

/** Element-wise comparison of two {@link localSortKey} results (already normalised to ascending). */
function compareSortKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/**
 * Splice ONE arriving message into a window's cached ids, or refuse (`null`) — the gate described in
 * the block comment above. `total` is the window's CURRENT working total (it moves as arrivals land).
 *
 * The tail rules are the load-bearing part:
 *  - An index past the last loaded row is only legal on a COMPLETE window (`ids.length >= total`).
 *    Otherwise the arrival belongs to a page the user has not scrolled to, and showing it after the
 *    last loaded row would put it before messages that sort ahead of it.
 *  - On an INCOMPLETE window the splice is paid for by dropping the last id, keeping `ids.length` — and
 *    therefore the head page this window is — exactly as long as it was. See the block comment for the
 *    two things that would otherwise drift (`windowLimit`, the load-more guard). WITHIN ONE CALL the
 *    dropped id is never the one being inserted: an incomplete window refuses a tail insert. Across a
 *    BATCH it may well be an arrival a previous call placed — see {@link placeArrivals}.
 */
function placeArrival(
  window: Pick<QueryCacheRow, 'filter' | 'sort' | 'collapseThreads'>,
  ids: readonly Id[],
  total: number | null,
  envelopes: ReadonlyMap<Id, EmailEnvelopeInput>,
  arrival: EmailEnvelopeInput,
): Id[] | null {
  if (ids.includes(arrival.id)) return null
  if (!windowAcceptsLocally(window.filter, arrival)) return null
  const key = localSortKey(window.sort, arrival)
  if (key === null) return null

  const neighbours: number[][] = []
  for (const id of ids) {
    const envelope = envelopes.get(id)
    // A window is persisted BEFORE the envelopes it lists (backfill.ts, "the reverse gap"), so a hole
    // is a real state. We cannot compare against a row we do not hold — refuse and void.
    if (envelope === undefined) return null
    // Under thread collapsing an entry stands for a whole thread. If the arrival's thread is already
    // represented, the server would NOT add a second row for it — inserting one would double the
    // conversation on screen and over-count `total`, which counts threads for a collapsed query.
    if (window.collapseThreads && envelope.threadId === arrival.threadId) return null
    const neighbourKey = localSortKey(window.sort, envelope)
    if (neighbourKey === null) return null
    neighbours.push(neighbourKey)
  }

  let index = neighbours.findIndex((neighbour) => compareSortKeys(key, neighbour) < 0)
  if (index === -1) index = ids.length
  const complete = total !== null && ids.length >= total
  if (index === ids.length && !complete) return null

  const next = [...ids]
  next.splice(index, 0, arrival.id)
  if (!complete) next.pop()
  return next
}

/**
 * Place every arriving message that can be placed into one window; `null` when none could be, which is
 * the caller's signal to fall back to voiding only.
 *
 * The cheap, pure gates run FIRST so that a window this can never place — a free-text search, a
 * `from`-sorted list — costs no envelope read at all. Only then are the neighbours loaded, once per
 * window rather than once per arrival, inside the caller's transaction.
 *
 * ORDER — decided, not accidental (gap B8, where a bulk move first reached this with a window that
 * already holds part of the batch):
 *  - The arrivals are placed in the INTENT's order and are deliberately NOT pre-sorted by
 *    {@link localSortKey}. Each placement recomputes its index against the RUNNING `ids`, so placing
 *    one arrival does shift the index computed for the next; there is no batch-computed index to go
 *    stale. On a COMPLETE window that makes the result an insertion sort, and therefore independent of
 *    the order the ids arrive in AS LONG AS THEIR SORT KEYS ARE DISTINCT (pinned by the tests).
 *    TIES ARE ORDER-DEPENDENT, and that is not a rounding error: {@link placeArrival} scans for the
 *    first neighbour the arrival sorts STRICTLY before (`compareSortKeys(...) < 0`), so an arrival
 *    lands AFTER every equal neighbour — including one placed a moment earlier in the same batch. Two
 *    ids delivered in the same second (the normal case for bulk mail, not a contrived one) therefore
 *    come out in intent order: `[e1,e2]` gives `…e1,e2`, `[e2,e1]` gives `…e2,e1`. Benign, and pinned
 *    by a test rather than wished away: the window is voided on every insert, so the server's
 *    `fullRequery` replaces `ids` wholesale and decides the tie itself.
 *  - Sorting first would be strictly WORSE on an incomplete window: place newest-first and each insert
 *    shortens the tail under the arrivals still to come, so one that now sorts past the last loaded row
 *    is refused ({@link placeArrival}) and its match never reaches `total`. The intent order had
 *    already made room for it.
 *  - The tail-drop rule is paid PER INSERT, not per transaction, so `ids.length` is preserved after N
 *    arrivals exactly as it is after one — a 50-id move into a 20-long incomplete window leaves it 20
 *    long, each insert evicting the current last id — which ACROSS THE BATCH may be an arrival placed
 *    a moment ago, even though within a single {@link placeArrival} call it never is.
 */
async function placeArrivals(
  db: ReplicaDb,
  accountId: Id,
  window: QueryCacheRow,
  arrivals: readonly EmailEnvelopeInput[],
): Promise<{ ids: Id[]; total: number | null } | null> {
  const candidates = arrivals.filter(
    (arrival) =>
      !window.ids.includes(arrival.id) &&
      windowAcceptsLocally(window.filter, arrival) &&
      localSortKey(window.sort, arrival) !== null,
  )
  if (candidates.length === 0) return null

  const loaded = await emailsByIds(db, accountId, [...window.ids])
  const envelopes = new Map<Id, EmailEnvelopeInput>()
  window.ids.forEach((id, position) => {
    const row = loaded[position]
    if (row !== undefined) envelopes.set(id, row)
  })

  let ids: Id[] = window.ids
  let total = window.total
  let placed = false
  for (const arrival of candidates) {
    const next = placeArrival(window, ids, total, envelopes, arrival)
    if (next === null) continue
    ids = next
    // The dropped tail id (see {@link placeArrival}) is NOT a departure — that message still matches
    // the query, it just sits on the next page now. So `total` only counts the arrival.
    total = total === null ? null : total + 1
    envelopes.set(arrival.id, arrival)
    placed = true
  }
  return placed ? { ids, total } : null
}

/** What {@link updateWindows} changed — the DATA a rollback needs. */
interface WindowChanges {
  /** Keys whose window lost the ids ({@link invalidateWindows} re-voids them). */
  readonly pruned: string[]
  /** Keys whose window GAINED an id locally ({@link retractWindows} takes them back out). */
  readonly inserted: string[]
}

/** Which cached windows an optimistic mutation touches, and how. */
interface WindowEffects {
  /** Windows the messages provably LEFT: drop the ids, and void the baseline they no longer match. */
  readonly left?: (window: QueryCacheRow) => boolean
  /**
   * Windows the messages provably ENTERED: splice them in when {@link arrivals} makes that possible,
   * and void the baseline either way. Without `arrivals` this is the pre-M3.10 behaviour verbatim —
   * void only, and wait for the re-query to place the row.
   */
  readonly entered?: (window: QueryCacheRow) => boolean
  /**
   * The POST-apply envelopes of the arriving messages — what {@link entered} windows are placed from.
   * They must be the patched rows, not the originals: the gate evaluates the window's own filter
   * against them, and a pre-move envelope is not yet in the destination mailbox.
   */
  readonly arrivals?: readonly EmailEnvelopeInput[]
  /**
   * Windows whose COLLATION depends on what just changed (M3.10): void the baseline and let the server
   * re-place the rows. Asked of EVERY window, unlike {@link entered} — one that keeps the message can
   * be rendering it in the wrong place, and one that does not hold it yet can be about to gain it by
   * sort alone. See {@link updateWindows} for why membership is the wrong gate here, and what it costs.
   */
  readonly resorted?: (window: QueryCacheRow) => boolean
}

/**
 * Bring this account's cached windows in line with an optimistic mutation, in ONE scan, and return the
 * keys it actually EDITED — the DATA the rollback needs ({@link invalidateWindows},
 * {@link retractWindows}).
 *
 * `left` windows lose the ids: `total` drops by the number they really held (never below 0) and
 * `upToId` is re-derived, so the row keeps the invariant every other writer maintains
 * (`upToId === ids.at(-1)`; backfill/loadMore/reconcile). `entered` windows GAIN the ids when
 * {@link WindowEffects.arrivals} lets us place them locally ({@link placeArrivals}) and otherwise keep
 * their ids untouched; `resorted` windows always keep theirs. All three void `queryState` (see the
 * invariant above) — including a successful local insert, whose index is our guess and not the
 * server's answer. A window whose `ids` did NOT actually change keeps its state, because its baseline
 * is still honest.
 *
 * `entered` IS gated on membership — PER ID (gap B8) — and `resorted` is NOT, and the asymmetry is
 * the point:
 *  - `entered` is about FILTER arrival, so it is asked only of windows still MISSING at least one of
 *    the touched ids. A window that already holds ALL of them has taken them in; there is nothing left
 *    to splice. Per ID rather than per window because a bulk move is ONE call: a window listing `e1`
 *    but not `e2` must still pick `e2` up, and the whole-window quantifier placed neither.
 *  - `resorted` is about COLLATION, which is not a property of the rows a window happens to have
 *    loaded. Gating it on membership concealed a whole case: a message can arrive in a window BY SORT.
 *    An "Unread first" folder window (filter `AND(inMailbox, after)`, sort `hasKeyword $seen`) whose
 *    loaded slice stops before `e1` must show `e1` at the TOP the moment `e1` is marked unread from
 *    somewhere else — a search result, a label view. Under the old gate `resorted` was not asked (the
 *    window does not list `e1`) and `entered` was false (a folder window carries a keyword SORT, not a
 *    keyword FILTER), so nothing voided and the row appeared only at the next full reconcile: online
 *    when the server's push echoed, offline not until reconnect. The question is therefore asked of
 *    every window, and the answer is the same either way — if a window's order depends on this
 *    keyword, then any change to that keyword on any message that could belong to it makes our
 *    baseline a lie, whether or not the id is currently listed.
 *
 * That price is real and was weighed, not overlooked: with "Unread first" ON, every mark-read voids
 * the folder window the user is looking at and buys one `fullRequery`. It is honest — they turned on a
 * sort that depends on read state, so changing read state genuinely must re-sort — and it is bounded,
 * because `runReplay` only reconciles once `pendingOutbox` is empty (engine.ts), so a triage burst
 * collapses into ONE re-query rather than one per keystroke. With the toggle OFF (the default)
 * {@link sortUsesKeyword} is false and nothing is voided at all, so the cost is strictly opt-in.
 *
 * A window is still never scanned twice and never voided twice: an `entered` window that also
 * `resorted` is written exactly once, by the insert (or by the insert's fallback void).
 *
 * MUST run inside the caller's transaction, together with the `emails` mutation it mirrors: a crash
 * between the two would leave a window listing a message that has moved out from under it.
 */
async function updateWindows(
  db: ReplicaDb,
  accountId: Id,
  emailIds: readonly Id[],
  effects: WindowEffects,
): Promise<WindowChanges> {
  if (emailIds.length === 0) return { pruned: [], inserted: [] }
  const touched = new Set<Id>(emailIds)
  const pruned: string[] = []
  const inserted: string[] = []
  for (const window of await db.queryCache.where('accountId').equals(accountId).toArray()) {
    if (effects.left?.(window) === true) {
      const ids = window.ids.filter((id) => !touched.has(id))
      const removed = window.ids.length - ids.length
      // A window pinned to the source mailbox that does not actually HOLD the id (it sits past the
      // loaded window) keeps its ids — and therefore its baseline. Nothing to do, nothing to undo.
      if (removed === 0) continue
      await db.queryCache.put({
        ...window,
        ids,
        total: window.total === null ? null : Math.max(0, window.total - removed),
        upToId: ids.at(-1) ?? null,
        queryState: null,
      })
      pruned.push(window.key)
      continue
    }
    // Membership gates `entered` ONLY, and PER ID (gap B8). A window that lists EVERY touched id has
    // nothing to pick up — a re-archive, or a `from: null` copy into a folder it was in anyway — but a
    // window that lists only SOME of them is still missing the rest, and a bulk move must place those.
    // Asking "does this window list ANY of them?" let one already-listed id suppress the whole batch:
    // a move of `[e1,e2]` into a window already showing `e1` placed neither and did not even void.
    //
    // MIND WHAT THIS ACTUALLY ASKS, because it is not the question one wants it to be. It asks "does
    // the INTENT contain an id this window does not LIST?" — it is not filter-aware, and neither is
    // `entered` itself (`filterPinsMailbox` is mailbox-coarse: pinned to the destination is necessary,
    // not sufficient). So a window that already holds every id it could ever ACCEPT is still voided
    // when the batch contains an id it would reject: `AND(inMailbox:archive, hasKeyword:$flagged)`
    // listing `e1`, given a move of `[e1,e2]` where `e2` is unflagged, buys a `fullRequery` that
    // changes nothing. That cost is deliberate and pinned by a test ("voids a window that holds every
    // id it could ACCEPT"). Making the gate filter-aware would mean asking `windowAcceptsLocally` per
    // id — and that is a deliberate allow-list which REFUSES what it cannot decide, so it would skip
    // the void exactly when we are least sure the window is still a valid baseline. Over-voiding costs
    // a re-query; under-voiding is a wrong list. Voiding is the safe direction.
    //
    // `placeArrivals` drops the already-listed ids from the batch itself, so nothing here can produce
    // a duplicate. `resorted` is asked below REGARDLESS, because a message can arrive in a window by
    // SORT.
    const holds = new Set<Id>(window.ids)
    const unlisted = emailIds.some((id) => !holds.has(id))
    if (unlisted && effects.entered?.(window) === true) {
      // Place what can be placed (M3.10, gap B2) — offline this is the ONLY thing that will ever put
      // the row on screen. `null` ⇒ nothing was provable here, which is the pre-M3.10 behaviour.
      const placed = await placeArrivals(db, accountId, window, effects.arrivals ?? [])
      if (placed === null) {
        await db.queryCache.update([accountId, window.key], { queryState: null })
        continue
      }
      // The `put` voids as well, so a window that is both `entered` and `resorted` is written exactly
      // once — the insert already tells the truth this window needed to hear.
      await db.queryCache.put({
        ...window,
        ids: placed.ids,
        total: placed.total,
        upToId: placed.ids.at(-1) ?? null,
        queryState: null,
      })
      inserted.push(window.key)
      continue
    }
    // Two cases, one answer: the order of a window that HOLDS the message changed under it, or the
    // message just sorted its way INTO a window that does not hold it yet. Both are a void.
    if (effects.resorted?.(window) === true) {
      await db.queryCache.update([accountId, window.key], { queryState: null })
    }
  }
  return { pruned, inserted }
}

/**
 * The rollback of a prune ({@link updateWindows}): mark the damaged windows as needing a full re-query.
 *
 * Still needed even though the apply already voided them: a reconcile may have run in between and
 * restored `queryState` — against a window whose ids are the ones we are now un-pruning. `update`, not
 * `put`, so a window that cache maintenance reaped in the meantime stays reaped instead of being
 * resurrected as a half-row. Deliberately NOT a re-insert at the old index (see the invariant above):
 * a rollback USUALLY happens because the server ANSWERED, so we are online and the round-trip is free.
 * The exception is `discardFailed` (engine.ts), which runs an OWED undo with no connectivity check —
 * see {@link applyUndo}.
 */
async function invalidateWindows(
  db: ReplicaDb,
  accountId: Id,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    await db.queryCache.update([accountId, key], { queryState: null })
  }
}

/**
 * The rollback of a local INSERT (M3.10, gap B2) — and the reason {@link invalidateWindows} could not
 * simply be reused: its whole body is a void, and voiding leaves the phantom id sitting in `ids`,
 * rendering a message the server rejected until the re-query lands.
 *
 * `ids` is the rollback's SCOPE, not the full intent: a partial rejection undoes only the objects that
 * actually failed (`undoTargets`), and an `insertedKeys` array records WINDOWS, not which id landed in
 * which window — so the removal intersects. An id in scope that the window does not hold costs
 * nothing. Any window in `insertedKeys` is voided whether or not it still holds the id, because the
 * apply voided it and a reconcile may have restored a `queryState` in between.
 *
 * `total` comes back down by what was removed. The ids the inserts pushed off the TAIL of an
 * incomplete window are NOT restored — nothing records them — and after N inserts that is N rows, up
 * to and including every row the window had (see the eviction paragraph in {@link applyUndo}). The
 * forced re-query brings them back.
 */
async function retractWindows(
  db: ReplicaDb,
  accountId: Id,
  keys: readonly string[],
  ids: readonly Id[],
): Promise<void> {
  if (keys.length === 0) return
  const drop = new Set(ids)
  for (const key of keys) {
    // `get`-then-`put` rather than a bare `put`, for the same reason `invalidateWindows` uses
    // `update`: a window that cache maintenance reaped meanwhile must stay reaped, not be
    // resurrected as a half-row.
    const window = await db.queryCache.get([accountId, key])
    if (window === undefined) continue
    const remaining = window.ids.filter((id) => !drop.has(id))
    const removed = window.ids.length - remaining.length
    if (removed === 0) {
      await db.queryCache.update([accountId, key], { queryState: null })
      continue
    }
    await db.queryCache.put({
      ...window,
      ids: remaining,
      total: window.total === null ? null : Math.max(0, window.total - removed),
      upToId: remaining.at(-1) ?? null,
      queryState: null,
    })
  }
}

// ---------------------------------------------------------------------------------------------
// The folder-tree counts (M3.10, gap B7).
// ---------------------------------------------------------------------------------------------

/** A change to one mailbox's `totalEmails` / `unreadEmails`, in messages. */
interface MailboxCountDelta {
  total: number
  unread: number
}

type MailboxCountDeltas = Map<Id, MailboxCountDelta>

/**
 * The pre-mutation facts a count delta is derived from. Nothing else about the envelope matters, and
 * saying so explicitly is what lets the SAME arithmetic serve the forward apply (pre-image = the rows
 * as read), the rollback (pre-image = reconstructed from the persisted {@link OutboxUndo}) and the
 * re-apply after a sync pass.
 */
interface CountPreimage {
  readonly id: Id
  /** The mailboxes the message was in BEFORE the mutation. */
  readonly mailboxIds: Readonly<Record<Id, boolean>>
  /** `$seen !== true` BEFORE the mutation. */
  readonly unread: boolean
}

function preimageOf(rows: readonly EmailRow[]): CountPreimage[] {
  return rows.map((row) => ({
    id: row.id,
    mailboxIds: row.mailboxIds,
    unread: row.keywords.$seen !== true,
  }))
}

function bump(deltas: MailboxCountDeltas, mailboxId: Id, total: number, unread: number): void {
  const entry = deltas.get(mailboxId) ?? { total: 0, unread: 0 }
  entry.total += total
  entry.unread += unread
  deltas.set(mailboxId, entry)
}

/**
 * A move: `from` loses every message that was ACTUALLY in it, `to` gains every message that was NOT
 * already there. Both gates are the pre-image's, and there are THREE cases they cover, not two — an
 * earlier version of this comment named only the first two and the third was uncovered as a result:
 *
 *  1. a re-archive of a message already in `to` credits `to` with 0;
 *  2. a `from === null` copy debits nothing;
 *  3. `from !== null` but the message was NEVER IN `from` debits `from` with 0. Ordinary, not
 *     exotic: a bulk selection made from a label or a search view spans folders, so a batch archived
 *     "from Inbox" routinely contains ids that were never in the Inbox. Debiting for them takes the
 *     badge below the truth for messages the folder never held.
 *
 * The `from` gate is the reason three call sites hand this function a membership record carrying an
 * explicit `false` rather than an absent key ({@link applyOptimistic}'s move via `hadFrom`,
 * {@link applyUndo}'s `mailboxIds` case and {@link unsentCountDeltas}'s move branch): `hadFrom` is
 * persisted on the outbox row for precisely this gate to consume. On the rollback path the gate is
 * what stops a `negate`d delta from CREDITING `from` +1 — inventing a message in a folder it was
 * never in, which no later `Mailbox/changes` need ever correct.
 */
function moveCountDeltas(
  before: readonly CountPreimage[],
  from: Id | null,
  to: Id,
): MailboxCountDeltas {
  const deltas: MailboxCountDeltas = new Map()
  for (const row of before) {
    if (from !== null && row.mailboxIds[from] === true) bump(deltas, from, -1, row.unread ? -1 : 0)
    if (row.mailboxIds[to] !== true) bump(deltas, to, 1, row.unread ? 1 : 0)
  }
  return deltas
}

/**
 * A `$seen` flip — `unreadEmails` ONLY, `totalEmails` NEVER, and only where the flag ACTUALLY
 * changed. Marking an already-read message read moves no badge, and a message counts against every
 * mailbox it is in.
 *
 * Reached only for `$seen`. A label add/strip is a keyword change too and must move NOTHING here:
 * `Mailbox.unreadEmails` is defined over `$seen`, and no other keyword has a folder count at all.
 */
function seenCountDeltas(before: readonly CountPreimage[], value: boolean): MailboxCountDeltas {
  const deltas: MailboxCountDeltas = new Map()
  for (const row of before) {
    // Only where the flag ACTUALLY flips. `value === true` (mark read) moves a badge only for a row
    // that WAS unread; `value === false` only for one that was read. Note the polarity: `unread` and
    // `value` are opposite senses, so the flip condition is `unread === value`.
    if (row.unread !== value) continue
    const step = value ? -1 : 1
    for (const [mailboxId, member] of Object.entries(row.mailboxIds)) {
      // `=== true` rather than a bare truthiness test is DEFENSIVE ONLY, with no behavioural effect
      // reachable from here, and the asymmetry with {@link moveCountDeltas} is worth stating because
      // it is not obvious: per RFC 8621 a `Mailbox/get` `mailboxIds` value is always `true`, and
      // `applyOptimistic` removes a membership with `delete`, never by assigning `false` — so every
      // pre-image reaching THIS function (and `removalCountDeltas`) is built from a stored row and
      // can only contain `true`. `moveCountDeltas` genuinely can receive `false`: its callers
      // construct `{ [from]: hadFrom.has(id) }` records on purpose. Deleting this test is green.
      if (member === true) bump(deltas, mailboxId, 0, step)
    }
  }
  return deltas
}

/** A destroy: the message leaves EVERY mailbox it was in, total and (if unread) unread alike. */
function removalCountDeltas(before: readonly CountPreimage[]): MailboxCountDeltas {
  const deltas: MailboxCountDeltas = new Map()
  for (const row of before) {
    for (const [mailboxId, member] of Object.entries(row.mailboxIds)) {
      // DEFENSIVE ONLY, exactly as in {@link seenCountDeltas} — see the asymmetry argued there.
      if (member === true) bump(deltas, mailboxId, -1, row.unread ? -1 : 0)
    }
  }
  return deltas
}

/** The rollback of any of the above. */
function negate(deltas: MailboxCountDeltas): MailboxCountDeltas {
  const out: MailboxCountDeltas = new Map()
  for (const [mailboxId, delta] of deltas) {
    out.set(mailboxId, { total: -delta.total, unread: -delta.unread })
  }
  return out
}

/** The count delta of ONE intent, given its pre-image. Four intents move a count; the rest do not. */
function countDeltasFor(
  intent: OutboxIntent,
  before: readonly CountPreimage[],
): MailboxCountDeltas {
  switch (intent.kind) {
    case 'move':
      return moveCountDeltas(before, intent.from, intent.to)
    case 'setKeywords':
      // THE GATE. `unreadEmails` is a count of `$seen`; a `work` label has no folder count, so a
      // label add or strip must leave every badge exactly where it was.
      return intent.keyword === '$seen' ? seenCountDeltas(before, intent.value) : new Map()
    case 'destroyEmails':
      return removalCountDeltas(before)
    default:
      // `createMailbox` seeds 0/0; `renameMailbox`/`moveMailbox` do not move mail; `deleteMailbox`
      // removes the row entirely; drafts are not envelopes; the contact intents (M4.2) touch cards, not
      // mail, so no `Mailbox` badge moves; and `sendEmail` writes no synthetic Sent row (the real copy
      // arrives via delta — patching here would DOUBLE it), its only replica edit being an
      // `$answered`/`$forwarded` flag, which is not `$seen`.
      return new Map()
  }
}

/**
 * Apply a count delta to the mailbox rows — a DELTA PATCH, deliberately not a recompute (M3.10, gap
 * B7).
 *
 * WHY NOT A RECOMPUTE. `db.emails` is a bounded, actively-SHRINKING horizon, not the folder:
 * `backfill.ts`'s `windowFilter` is `inMailbox AND receivedAt >= now - cacheDays`, and
 * `maintenance.ts` bulk-deletes the envelopes outside it. A local `count()` over a 50k-message Inbox
 * with `cacheDays: 30` is not merely stale, it is categorically wrong — it would replace a briefly
 * stale badge with a permanently and confidently wrong one. (`labelUnreadCounts` in `repo.ts` DOES
 * recompute, and its own doc admits it "reflects only the windowed replica subset": a label is a
 * client-side concept whose carriers are mostly recent. `Mailbox.unreadEmails` is a server-owned
 * absolute over mail this client has never seen, and the only sound local edit to it is ±1.) A
 * hybrid — recompute unread, patch total — is rejected for making one row's two numbers answer to
 * two different authorities.
 *
 * NO DEFENSIVE BOOKKEEPING IS NEEDED AGAINST THE SERVER: `patchMailboxes`/`putMailboxes` (delta.ts)
 * assign the server's ABSOLUTE number, never combine it arithmetically, so a delta that reports the
 * mailbox erases whatever we patched. What that costs instead is durability, which is why
 * {@link reapplyPendingCounts} exists.
 *
 * `Math.max(0, …)` on BOTH fields, for the same reason `updateWindows` clamps `window.total`: the
 * replica may hold a message the server's count does not reflect yet, so a decrement can outrun the
 * number it is decrementing.
 *
 * `get`-then-`put` rather than `update` because the new value is a FUNCTION OF THE OLD ONE
 * (`old + delta`, clamped), and `update` has no way to express that — it can only assign a value the
 * caller already knows, which we do not. The read is the point; the `put` is just how the computed
 * row goes back. It is NOT what stops a mailbox a concurrent `Mailbox/changes` destroyed from being
 * resurrected — an earlier version of this comment claimed that and was wrong. Dexie's
 * `Table.update()` on a missing primary key is a documented no-op returning 0 and never inserts, so
 * `update` would resurrect nothing either. The protection against the destroyed mailbox is the
 * `if (row === undefined) continue` guard below, and nothing else.
 *
 * `totalThreads`/`unreadThreads` are deliberately LEFT ALONE. They are server-owned, no surface
 * reads them, and — decisively — a per-MESSAGE mutation cannot imply a thread-count delta at all:
 * moving one message out of a three-message thread changes `totalThreads` by 0, not by 1, and there
 * is no local way to tell those two cases apart on a partial replica.
 *
 * BEHAVIOUR CHANGE, deliberate: the three non-badge readers of `totalEmails` — the delete-folder
 * confirmation (`FolderTree.tsx`), the empty-folder confirmation (`cleanup/CleanupDialogs.tsx`) and
 * `demo/MailboxListView.tsx` (static demo fixtures, which this code never reaches) — now quote the
 * OPTIMISTIC total. That is correct (they should reflect what the user just did), but the
 * delete-folder dialog is where an over-count would produce a scarier confirmation than reality.
 *
 * MUST run inside the caller's transaction, with `db.mailboxes` in scope, together with the envelope
 * mutation it mirrors — a crash between the two would leave the badge disagreeing with the list.
 */
async function adjustMailboxCounts(
  db: ReplicaDb,
  accountId: Id,
  deltas: MailboxCountDeltas,
): Promise<void> {
  for (const [mailboxId, delta] of deltas) {
    // A PURE OPTIMISATION with no behavioural effect, said plainly because it is not covered and
    // cannot be: a 0/0 delta would write the row back byte-identical. It only skips the round trip.
    if (delta.total === 0 && delta.unread === 0) continue
    const row = await db.mailboxes.get([accountId, mailboxId])
    // NOT an optimisation — THE guard that keeps a mailbox a concurrent `Mailbox/changes` destroyed
    // from being resurrected as a half-row by our `put`. See this function's doc.
    if (row === undefined) continue
    await db.mailboxes.put({
      ...row,
      totalEmails: Math.max(0, row.totalEmails + delta.total),
      unreadEmails: Math.max(0, row.unreadEmails + delta.unread),
    })
  }
}

/**
 * Re-apply the count deltas of the intents that have NOT been sent, over exactly the mailbox count
 * fields a `syncMailboxes` pass has just OVERWRITTEN with the server's pre-mutation number.
 *
 * Three narrowings, each load-bearing:
 *  1. {@link unsentOutbox}, NOT `pendingOutbox` — and its test is `pending` AND `attempts === 0`,
 *    not `pending` alone. `pending` in this state machine means "not currently dispatched", not
 *    "never dispatched": `recoverStranded`, the transient-retry branch, auth expiry AND the
 *    per-object `rateLimit` retry all return an already-dispatched row to `pending` — four paths,
 *    not the three an earlier version of this list named — and a row whose request DID reach the
 *    server has its ±1
 *    in the server's number already. Adding it again double-counts, and unlike staleness a
 *    double-count never self-corrects. The predicate fails CLOSED for exactly that reason — see
 *    {@link unsentOutbox} for the full argument and the residual `inflight` gap it accepts.
 *  2. Only the FIELDS the pass actually wrote ({@link MailboxCountWrites}). `syncMailboxes` patches
 *    only the mailboxes `Mailbox/changes` reports and only the properties it names, so a pass that
 *    left a mailbox alone must NOT have the delta added a second time on top of the patch already
 *    sitting in the row. The two halves are INDEPENDENT and both reachable: `Mailbox/changes` names
 *    `totalEmails` without `unreadEmails` whenever a READ message enters or leaves a folder, and
 *    `unreadEmails` without `totalEmails` on every remote mark-read.
 *  3. The delta is re-DERIVED from the persisted undo plus the current envelopes, not remembered —
 *    the undo is the only durable record, and it already carries exactly the gates the forward
 *    arithmetic uses (`had`, `hadTo`, `hadFrom`).
 *
 * The collision this fixes is common, not exotic: new mail arriving in the Inbox IS a server-side
 * change to the Inbox, and the Inbox is where marking-read happens.
 */
export async function reapplyPendingCounts(
  db: ReplicaDb,
  accountId: Id,
  writes: MailboxCountWrites,
): Promise<void> {
  const total = new Set(writes.total)
  const unread = new Set(writes.unread)
  // BOTH early returns are PURE OPTIMISATIONS with no behavioural effect, stated plainly because
  // neither is pinned and neither can be. With no fields written, the per-field zeroing below
  // reduces every delta to 0/0 and `adjustMailboxCounts` skips all of them; with no rows, the loop
  // body never runs. They save a pointless `rw` transaction, nothing more. (An earlier mutation log
  // recorded these as "two independent guards, one RED each" — that claim was wrong on both counts.)
  if (total.size === 0 && unread.size === 0) return
  const rows = await unsentOutbox(db, accountId)
  if (rows.length === 0) return
  await db.transaction('rw', db.emails, db.mailboxes, async () => {
    for (const row of rows) {
      const deltas = await unsentCountDeltas(db, accountId, row)
      for (const [mailboxId, delta] of deltas) {
        if (!total.has(mailboxId)) delta.total = 0
        if (!unread.has(mailboxId)) delta.unread = 0
      }
      await adjustMailboxCounts(db, accountId, deltas)
    }
  })
}

/** Re-derive one unsent row's count delta from its persisted undo and the CURRENT envelopes. */
async function unsentCountDeltas(
  db: ReplicaDb,
  accountId: Id,
  row: OutboxRow,
): Promise<MailboxCountDeltas> {
  const intent = row.payload as OutboxIntent
  const undo = row.undo
  // A CRASH GUARD with no behavioural effect reachable from here, said plainly because it is not
  // covered and cannot be: `enqueueAction` always persists an undo, and the only writer that clears
  // one (`undo: null`, after a rollback is drained) leaves the row `error`, which
  // {@link unsentOutbox} never returns. Deleting it is green. It stays because the two branches
  // below dereference `undo`, and `OutboxRow.undo` is typed optional.
  if (undo === null || undo === undefined) return new Map()
  if (intent.kind === 'setKeywords' && undo.kind === 'keywords') {
    const had = new Set(undo.had)
    const rows = present(await emailsByIds(db, accountId, intent.emailIds))
    // Routed through {@link countDeltasFor} rather than calling `seenCountDeltas` directly, so THE
    // GATE (`keyword === '$seen'`) exists exactly ONCE. It used to be duplicated here, and the copy
    // was unpinned: deleting it left the suite green while real behaviour sat behind it. An offline
    // label add/strip is a `setKeywords` intent with a `keywords` undo and reaches this line, and
    // without the gate its `had` — the set that carried the LABEL — would be read as a `$seen`
    // pre-image, moving `unreadEmails` badges that no label change may move. `unread` below is
    // therefore MEANINGLESS for a non-`$seen` keyword, and correct only because the gate discards it.
    //
    // A keyword change never touched `mailboxIds`, so the current row's membership IS the
    // pre-image's; `had` is the pre-image `$seen`. KNOWN IMPRECISION, accepted: if a LATER unsent
    // intent has moved the message since, the current membership is that move's destination, so
    // this delta is re-applied to the folder the message is in NOW rather than the one it was in
    // when the keyword flipped. Recording the membership per intent would mean growing the
    // persisted undo, which this module forbids itself. It converges — sending either intent makes
    // the server re-report both folders.
    return countDeltasFor(
      intent,
      rows.map((r) => ({ id: r.id, mailboxIds: r.mailboxIds, unread: !had.has(r.id) })),
    )
  }
  if (intent.kind === 'move' && undo.kind === 'mailboxIds') {
    const hadTo = new Set(undo.hadTo)
    const hadFrom = new Set(undo.hadFrom)
    const rows = present(await emailsByIds(db, accountId, intent.emailIds))
    // `hadTo`/`hadFrom` ARE the pre-image membership of the only two mailboxes the move's arithmetic
    // consults; a move never touched the keywords, so `unread` is still the current row's.
    return moveCountDeltas(
      rows.map((r) => ({
        id: r.id,
        mailboxIds: {
          ...(undo.from === null ? {} : { [undo.from]: hadFrom.has(r.id) }),
          [undo.to]: hadTo.has(r.id),
        },
        unread: r.keywords.$seen !== true,
      })),
      undo.from,
      undo.to,
    )
  }
  // `destroyEmails` is NOT re-derivable and is deliberately skipped: its envelopes are gone from the
  // replica and its undo (`refetchEmails`) carries only `prunedKeys`, by design — the "before" state
  // is a full envelope set, far too big to persist. So an UNSENT destroy's count patch still reverts
  // if a concurrent server change to that folder lands first. Bounded and self-correcting: sending
  // the destroy makes the server re-report the mailbox with the right number.
  return new Map()
}

/**
 * Apply an intent to the replica immediately and return the DATA needed to undo it (M3.3). Only
 * rows that actually exist locally are touched. The undo is deliberately id-set-based, not a
 * snapshot: it is persisted on the outbox row, so it must stay small and must survive being applied
 * to a SUBSET of the intent's ids (a partial rejection).
 */
export async function applyOptimistic(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
): Promise<OutboxUndo> {
  switch (intent.kind) {
    case 'setKeywords': {
      // ONE transaction, for the same reason as `move` below: the envelope patch and the window edit
      // are the same fact stated twice, and a crash between them would leave the list rendering an
      // unread message in `is:unread` that the replica already knows is read.
      return db.transaction(
        'rw',
        db.emails,
        db.queryCache,
        db.mailboxes, // the folder counts (gap B7) — same fact, same atomic unit
        async (): Promise<OutboxUndo> => {
          const originals = present(await emailsByIds(db, accountId, intent.emailIds))
          const had = originals
            .filter((row) => row.keywords[intent.keyword] === true)
            .map((r) => r.id)
          // The PRE-IMAGE, taken before anything is written — `seenCountDeltas` needs the `$seen`
          // state the mutation is about to destroy.
          const before = preimageOf(originals)
          await putEmails(
            db,
            accountId,
            originals.map((row) => {
              const keywords = { ...row.keywords }
              if (intent.value) keywords[intent.keyword] = true
              else delete keywords[intent.keyword]
              return { ...toEnvelope(row), keywords }
            }),
          )
          // The folder badges (gap B7). `$seen` ONLY, `unreadEmails` only — see
          // {@link countDeltasFor}: a label add or strip must move nothing.
          await adjustMailboxCounts(db, accountId, countDeltasFor(intent, before))
          // The windows (M3.10). MIND THE POLARITY — it is inverted between the two, and it is the whole
          // fix: `left` must prove NON-membership, so it asks for the OPPOSITE of the value being
          // written, while `entered` asks for the same value.
          //   mark read (`$seen := true`) ⇒ prune the `notKeyword:$seen` windows (`?q=is:unread`)
          //                              ⇒ void  the `hasKeyword:$seen` windows (`?q=is:read`)
          //   strip a label (`work := false`) ⇒ prune the `hasKeyword:work` window (`?label=work`)
          // `resorted` is the third case, and unlike the other two it is about ORDER, not membership:
          // the "Unread first" window keeps the message and merely renders it in the wrong place.
          // No `arrivals`: a keyword change deliberately keeps the void-only arrival (gap B2 placed the
          // arrival for a MOVE). Adding a label would have to place the row in a `?label=` view whose
          // sort we can often reproduce — but the window it arrives in is also the one whose membership
          // just changed under a DIFFERENT predicate, and that pairing has not been reasoned through.
          // Void-only there is correct, just one round-trip slower.
          const { pruned } = await updateWindows(db, accountId, intent.emailIds, {
            left: (window) => filterPinsKeyword(window.filter, intent.keyword, !intent.value),
            entered: (window) => filterPinsKeyword(window.filter, intent.keyword, intent.value),
            resorted: (window) => sortUsesKeyword(window.sort, intent.keyword),
          })
          return { kind: 'keywords', keyword: intent.keyword, had, prunedKeys: pruned }
        },
      )
    }
    case 'move': {
      const from = intent.from
      // ONE transaction: the envelope patch and the window prune are the same fact stated twice, and
      // a crash between them would leave the list rendering a message that is no longer in the folder.
      return db.transaction(
        'rw',
        db.emails,
        db.queryCache,
        db.mailboxes, // the folder counts (gap B7) — same fact, same atomic unit
        async (): Promise<OutboxUndo> => {
          const originals = present(await emailsByIds(db, accountId, intent.emailIds))
          const hadTo = originals
            .filter((row) => row.mailboxIds[intent.to] === true)
            .map((r) => r.id)
          const hadFrom =
            from === null
              ? []
              : originals.filter((row) => row.mailboxIds[from] === true).map((row) => row.id)
          // The PRE-IMAGE, taken before `moved` overwrites `mailboxIds`: `hadFrom`/`hadTo` are the
          // gates, and `$seen` is read off the ORIGINAL row.
          const before = preimageOf(originals)
          // Keep the PATCHED envelopes: they are what the window gate is evaluated against below (an
          // arrival is only in the destination mailbox after the patch), and re-reading them would cost
          // a second round through `emails` for the same rows.
          const moved = originals.map((row) => {
            const mailboxIds = { ...row.mailboxIds }
            if (from !== null) delete mailboxIds[from]
            mailboxIds[intent.to] = true
            return { ...toEnvelope(row), mailboxIds }
          })
          await putEmails(db, accountId, moved)
          // The folder badges, both ends (gap B7) — gated on `hadFrom`/`hadTo` exactly as the undo is.
          await adjustMailboxCounts(db, accountId, countDeltasFor(intent, before))
          // The windows, BOTH ends of the move (M3.8):
          //  - SOURCE: the message provably left `from` → prune it out of those windows. `from === null`
          //    is a copy (a label add, or a move from a view whose folder is unknown) — the message left
          //    nothing, so nothing is pruned.
          //  - DESTINATION: the message provably entered `to` → those windows must SHOW it. Where it goes
          //    is the server's collation, so the row is spliced in only where that is locally provable
          //    (`arrivals` → {@link placeArrivals}) and the window is marked for a full re-query either
          //    way. This is what makes Undo work: the inverse move's destination is the folder the row
          //    was archived out of, so the row comes back — offline from the splice (gap B2), online
          //    from the re-query — see the invariant above.
          const { pruned, inserted } = await updateWindows(db, accountId, intent.emailIds, {
            // (`exactOptionalPropertyTypes`: an absent `left` is the "prune nothing" case, not `undefined`.)
            ...(from === null
              ? {}
              : { left: (window: QueryCacheRow) => filterPinsMailbox(window.filter, from) }),
            entered: (window) => filterPinsMailbox(window.filter, intent.to),
            arrivals: moved,
          })
          return {
            kind: 'mailboxIds',
            from,
            to: intent.to,
            hadTo,
            hadFrom,
            prunedKeys: pruned,
            insertedKeys: inserted,
          }
        },
      )
    }
    case 'destroyEmails': {
      return db.transaction(
        'rw',
        db.emails,
        db.emailBodies, // `deleteEmails` cascades to the bodies (M3.4) — a sub-txn needs it in scope
        db.queryCache,
        db.mailboxes, // the folder counts (gap B7) — same fact, same atomic unit
        async (): Promise<OutboxUndo> => {
          // THE PRE-IMAGE MUST BE READ FIRST (gap B7). `deleteEmails` is destructive and this case
          // used to read nothing at all before it — afterwards there is no membership left to count.
          const before = preimageOf(present(await emailsByIds(db, accountId, intent.emailIds)))
          await deleteEmails(db, accountId, intent.emailIds)
          // The folder badges: the message leaves every mailbox it was in, total AND unread.
          await adjustMailboxCounts(db, accountId, countDeltasFor(intent, before))
          // A destroyed message belongs in NO window — not even a search or a label view, which would
          // otherwise render a row whose envelope no longer exists. There is no destination.
          //
          // The prune voids those windows' `queryState` like any other (the invariant above). Here it
          // is DEFENSIVE rather than load-bearing: a destroy is irreversible — the id can never re-enter
          // a query result — so the server's delta can only ever agree with us ("removed: [e1]", which
          // our prune has already applied). It is kept anyway because a destroy is the rare, deliberate
          // permanent-delete path, so a re-query of the affected windows is cheap, and one unconditional
          // invariant ("we never hand `queryChanges` a baseline we have edited") is worth more than an
          // exception that has to be re-proved every time this code is touched.
          const { pruned } = await updateWindows(db, accountId, intent.emailIds, {
            left: () => true,
          })
          // The "before" state is the full envelope set — far too big to persist. It does not need to
          // be: a REJECTED destroy means the messages still exist on the server, so the undo is a
          // re-fetch. That also self-corrects a PARTIAL rejection — only the surviving ids come back.
          return { kind: 'refetchEmails', prunedKeys: pruned }
        },
      )
    }
    case 'createMailbox': {
      const mailbox: Mailbox = {
        id: intent.creationId,
        name: intent.props.name,
        parentId: intent.props.parentId,
        // A new folder has no role until `updateMailbox` gives it one — see the intent's note.
        role: null,
        sortOrder: intent.props.sortOrder ?? 0,
        totalEmails: 0,
        unreadEmails: 0,
        totalThreads: 0,
        unreadThreads: 0,
        myRights: OPTIMISTIC_RIGHTS,
        isSubscribed: true,
      }
      await db.mailboxes.put(toMailboxRow(accountId, mailbox))
      return { kind: 'mailbox', id: intent.creationId, prior: null }
    }
    case 'renameMailbox':
    case 'moveMailbox':
    case 'deleteMailbox': {
      const prior = (await db.mailboxes.get([accountId, intent.id])) ?? null
      if (intent.kind === 'renameMailbox') {
        await db.mailboxes.update([accountId, intent.id], { name: intent.name })
      } else if (intent.kind === 'moveMailbox') {
        await db.mailboxes.update([accountId, intent.id], { parentId: intent.parentId })
      } else {
        await deleteMailbox(db, accountId, intent.id)
      }
      return { kind: 'mailbox', id: intent.id, prior }
    }
    case 'updateMailbox': {
      // Only patch a row we actually hold: a folder a concurrent `Mailbox/changes` has already
      // destroyed must not be resurrected by an `update` (the guard `adjustMailboxCounts` makes too).
      const prior = await db.mailboxes.get([accountId, intent.id])
      if (prior === undefined) return { kind: 'mailboxProps', prior: [] }
      const patch = {
        ...(intent.props.role === undefined ? {} : { role: intent.props.role }),
        ...(intent.props.isSubscribed === undefined
          ? {}
          : { isSubscribed: intent.props.isSubscribed }),
      }
      await db.mailboxes.update([accountId, intent.id], patch)
      // The pre-image of exactly the columns written — see the note on `mailboxProps` for why a
      // whole-row pre-image would be wrong when two updates are queued against the same folder.
      return {
        kind: 'mailboxProps',
        prior: [
          {
            id: intent.id,
            ...(intent.props.role === undefined ? {} : { role: prior.role }),
            ...(intent.props.isSubscribed === undefined
              ? {}
              : { isSubscribed: prior.isSubscribed }),
          },
        ],
      }
    }
    case 'reorderMailboxes': {
      const priors: Array<{ id: Id; sortOrder: number }> = []
      for (const entry of intent.order) {
        const prior = await db.mailboxes.get([accountId, entry.id])
        if (prior === undefined) continue
        priors.push({ id: entry.id, sortOrder: prior.sortOrder })
        await db.mailboxes.update([accountId, entry.id], { sortOrder: entry.sortOrder })
      }
      return { kind: 'mailboxProps', prior: priors }
    }
    case 'createContactCard': {
      // The card carries its `id === creationId` already; write it verbatim (the derived `abk` index
      // is computed by `putContactCards`). The undo is a plain delete — mirror of `createMailbox`.
      await putContactCards(db, accountId, [intent.card])
      return { kind: 'contactCard', id: intent.creationId, prior: null }
    }
    case 'updateContactCard': {
      const prior = (await db.contactCards.get([accountId, intent.id])) ?? null
      // Only patch a card we actually hold; a card past the cached window is left to the server (its
      // update still replays), and the undo (`prior: null`) then has nothing to restore.
      if (prior !== null) {
        const patched = applyPatchObject(rowToCard(prior), intent.patch)
        await putContactCards(db, accountId, [patched])
      }
      return { kind: 'contactCard', id: intent.id, prior }
    }
    case 'deleteContactCard': {
      const prior = (await db.contactCards.get([accountId, intent.id])) ?? null
      await deleteContactCards(db, accountId, [intent.id])
      return { kind: 'contactCard', id: intent.id, prior }
    }
    case 'createAddressBook': {
      const book: AddressBook = {
        id: intent.creationId,
        name: intent.props.name,
        description: intent.props.description ?? null,
        sortOrder: 0,
        isDefault: false,
        isSubscribed: true,
        myRights: OPTIMISTIC_BOOK_RIGHTS,
      }
      await putAddressBooks(db, accountId, [book])
      return { kind: 'addressBook', id: intent.creationId, prior: null }
    }
    case 'updateAddressBook': {
      const prior = (await db.addressBooks.get([accountId, intent.id])) ?? null
      if (prior !== null) {
        await db.addressBooks.update([accountId, intent.id], {
          ...(intent.props.name === undefined ? {} : { name: intent.props.name }),
          ...(intent.props.description === undefined
            ? {}
            : { description: intent.props.description }),
        })
      }
      return { kind: 'addressBook', id: intent.id, prior }
    }
    case 'deleteAddressBook': {
      const prior = (await db.addressBooks.get([accountId, intent.id])) ?? null
      await deleteAddressBooks(db, accountId, [intent.id])
      /*
       * The book row goes; the CARDS in it are left to the `ContactCard/changes` delta.
       *
       * Deliberate, and the reason is the undo: it is a persisted row, and restoring a book plus
       * every card that was only in it would mean carrying those cards in the payload — the payload
       * growth this module forbids itself (see the note on `insertedKeys`). The server destroys them
       * (`onDestroyRemoveContents`) and reports them destroyed on the next pass, which is the same
       * path a card deleted in another client takes. Until it arrives those cards are visible under
       * "All Contacts" without a book of their own: a transient, not a loss, and a REJECTED destroy
       * then needs no card restored because none was removed.
       */
      return { kind: 'addressBook', id: intent.id, prior }
    }
    case 'saveDraft':
    case 'discardDraft':
      // Drafts are edit-state, not envelope cache: the local `drafts` row is written durably by the
      // persist bridge / discard handler, not optimistically into `emails`. Nothing to undo here
      // (a rejection is surfaced on the drafts row itself by `stampDraftError`).
      return { kind: 'none' }
    case 'sendEmail': {
      // No synthetic Sent row (the real copy arrives via delta in a few ms). The only optimistic
      // replica change is the reply/forward source flag ($answered/$forwarded).
      const source = intent.source
      if (source === null) return { kind: 'none' }
      const originals = present(await emailsByIds(db, accountId, [source.emailId]))
      const had = originals.filter((row) => row.keywords[source.keyword] === true).map((r) => r.id)
      await putEmails(
        db,
        accountId,
        originals.map((row) => ({
          ...toEnvelope(row),
          keywords: { ...row.keywords, [source.keyword]: true },
        })),
      )
      return { kind: 'keywords', keyword: source.keyword, had }
    }
  }
}

/**
 * The email ids an intent's undo touches. `onlyIds` narrows it to the objects that ACTUALLY failed
 * (a partial rejection) — but only for the intents whose failure keys ARE email ids; a `sendEmail`
 * fails under its submission creation id, which says nothing about which email to restore.
 */
function undoTargets(intent: OutboxIntent, onlyIds: readonly string[] | null): Id[] {
  switch (intent.kind) {
    case 'setKeywords':
    case 'move':
    case 'destroyEmails': {
      if (onlyIds === null) return intent.emailIds
      const wanted = new Set(onlyIds)
      return intent.emailIds.filter((id) => wanted.has(id))
    }
    case 'sendEmail':
      return intent.source === null ? [] : [intent.source.emailId]
    default:
      return []
  }
}

/**
 * Undo an intent's optimistic apply from its PERSISTED {@link OutboxUndo} — for `onlyIds` alone when
 * a partial rejection is being repaired. MAY THROW (the `refetchEmails` arm needs the network); the
 * caller then leaves the undo owed on the row and retries it on the next pass.
 */
export async function applyUndo(
  db: ReplicaDb,
  port: JmapPort,
  accountId: Id,
  intent: OutboxIntent,
  undo: OutboxUndo,
  onlyIds: readonly string[] | null = null,
): Promise<void> {
  switch (undo.kind) {
    case 'none':
      return
    case 'keywords': {
      const ids = undoTargets(intent, onlyIds)
      if (ids.length === 0) return
      const had = new Set(undo.had)
      // `?? []`: `sendEmail`'s source-flag undo never prunes a window, and neither did any `keywords`
      // undo persisted before M3.10 — both read as "nothing to re-void".
      const prunedKeys = undo.prunedKeys ?? []
      await db.transaction('rw', db.emails, db.queryCache, db.mailboxes, async () => {
        const rows = present(await emailsByIds(db, accountId, ids))
        // The folder badges (gap B7), reversed. `undo.keyword === '$seen'` is THE behavioural
        // narrowing and carries the whole condition: no other keyword has a folder count, and it
        // already excludes the only other producer of a `keywords` undo — `sendEmail`'s
        // `$answered`/`$forwarded` source flag. `intent.kind === 'setKeywords'` is a TYPE NARROWING
        // and nothing more: it is what gives TypeScript the `intent.value` read below, and deleting
        // it changes no behaviour at any input. (It was previously described as a second
        // behavioural narrowing "twice over"; that was wrong — the `$seen` test alone does that work.)
        // `ids` is already `undoTargets`', so a partial rejection reverses only what actually failed.
        if (undo.keyword === '$seen' && intent.kind === 'setKeywords') {
          const before = rows.map((row) => ({
            id: row.id,
            // A keyword change never touched `mailboxIds`; `had` is the pre-image `$seen`.
            mailboxIds: row.mailboxIds,
            unread: !had.has(row.id),
          }))
          await adjustMailboxCounts(db, accountId, negate(seenCountDeltas(before, intent.value)))
        }
        await putEmails(
          db,
          accountId,
          rows.map((row) => {
            const keywords = { ...row.keywords }
            if (had.has(row.id)) keywords[undo.keyword] = true
            else delete keywords[undo.keyword]
            return { ...toEnvelope(row), keywords }
          }),
        )
        await invalidateWindows(db, accountId, prunedKeys)
      })
      return
    }
    case 'mailboxIds': {
      const ids = undoTargets(intent, onlyIds)
      if (ids.length === 0) return
      const hadTo = new Set(undo.hadTo)
      const hadFrom = new Set(undo.hadFrom)
      const prunedKeys = undo.prunedKeys ?? []
      // `?? []`: an undo persisted before M3.10 inserted nothing — it reads as "nothing to take back".
      const insertedKeys = undo.insertedKeys ?? []
      await db.transaction('rw', db.emails, db.queryCache, db.mailboxes, async () => {
        const rows = present(await emailsByIds(db, accountId, ids))
        // The folder badges (gap B7), reversed. `hadFrom`/`hadTo` ARE the pre-image membership of the
        // only two mailboxes the move's arithmetic consults, and a move never touched the keywords,
        // so `unread` is still the current row's. Unlike the WINDOW retraction below, this one is
        // exact: it is per-id, and both gates are recorded.
        await adjustMailboxCounts(
          db,
          accountId,
          negate(
            moveCountDeltas(
              rows.map((row) => ({
                id: row.id,
                mailboxIds: {
                  ...(undo.from === null ? {} : { [undo.from]: hadFrom.has(row.id) }),
                  [undo.to]: hadTo.has(row.id),
                },
                unread: row.keywords.$seen !== true,
              })),
              undo.from,
              undo.to,
            ),
          ),
        )
        await putEmails(
          db,
          accountId,
          rows.map((row) => {
            const mailboxIds = { ...row.mailboxIds }
            if (!hadTo.has(row.id)) delete mailboxIds[undo.to]
            if (undo.from !== null && hadFrom.has(row.id)) mailboxIds[undo.from] = true
            return { ...toEnvelope(row), mailboxIds }
          }),
        )
        await invalidateWindows(db, accountId, prunedKeys)
        // THE RETRACTION OVER-REMOVES, and that is accepted here rather than fixed. `insertedKeys`
        // records WINDOWS, not which id landed in which window, so the removal is a bare intersection
        // over the undo's whole id set: a window can lose an id this rollback never put there.
        //
        // B8 WIDENED that hole. Before it, a window listing any touched id was skipped by the
        // whole-window gate and could not be in `insertedKeys` at all; now a partially-overlapping
        // window is inserted into, so the intersection reaches ids that predate the mutation. And the
        // insert itself is paid for, on an INCOMPLETE window, by dropping the tail id
        // ({@link placeArrival}) — which the undo does not record. At N > 2 the eviction eats the whole
        // head page: an incomplete window `['a1','a2','e1']` with `total: 40` taking four arrivals ends
        // `['e5','e4','e3']` — correct — and then the retraction removes all four, leaving
        // `{ ids: [], total: 41 }`. An EMPTY head page carrying a total of 41. The window loses rows
        // that were there BEFORE the mutation, up to every row it had.
        //
        // AN EXACT RETRACTION WAS ATTEMPTED AND REVERTED — do not re-apply it. The attempt narrowed the
        // drop set to `ids.filter((id) => !hadTo.has(id))`, reasoning that a `hadTo` id was in the
        // destination before the move and is not this rollback's to remove. It is WRONG, because
        // `hadTo` is ENVELOPE-scoped ("this message was already in `to`") while the question here is
        // WINDOW-scoped ("did the apply splice this id into THIS window?"). The apply passes every
        // touched envelope as an arrival and {@link placeArrivals} drops only the ids the window
        // ALREADY LISTS — so a `hadTo` id that the window does NOT list is spliced in, and the
        // narrowing then leaves it there for good, along with the `+1` it added to `total`. A sound
        // narrowing needs a per-window record of which id landed where; `insertedKeys` is persisted on
        // the outbox row, and growing it into an id map is exactly the payload growth this module
        // forbids itself. So the exact retraction is not available without a design change.
        //
        // It self-corrects: the retraction voids the window and the next reconcile is a `fullRequery`
        // that rebuilds `ids` and `total` wholesale. USUALLY that is immediate, because the rollback
        // ran on the strength of a server ANSWER — a rejection — so we are online. NOT ALWAYS, and
        // the older, broader claim ("a rollback only ever happens because the server answered") was
        // simply false: `discardFailed` (engine.ts) also runs an OWED undo, it is reached from
        // `use-outbox-problems.ts` with no connectivity check, and `replayOutbox`'s `online === false`
        // bail does not cover it. Discard a dead letter offline and the retraction runs offline too,
        // with the self-correcting re-query unreachable until reconnect. Until it lands the window can
        // be empty-but-nonzero,
        // and the web UI must not paint a confident "no messages" over a window whose `total` is not
        // zero; the two halves reference each other on purpose. Pinned by "a REJECTED bulk move
        // over-retracts the id the window already listed", "an id the window did NOT list is spliced in
        // and must come back out" and "the retraction can wipe the whole head page — the eviction the
        // undo cannot record".
        await retractWindows(db, accountId, insertedKeys, ids)
      })
      return
    }
    case 'refetchEmails': {
      const ids = undoTargets(intent, onlyIds)
      if (ids.length === 0) return
      // The rejected ids still exist server-side (that is WHY the destroy was rejected). Anything
      // the server reports as `notFound` really is gone — leave it deleted.
      // The fetch is deliberately OUTSIDE the transaction below (a Dexie txn cannot survive a
      // non-Dexie await); it MAY THROW, and then the whole undo stays owed and is retried.
      const { list } = await port.getEmailEnvelopes(ids)
      const prunedKeys = undo.prunedKeys ?? []
      await db.transaction('rw', db.emails, db.queryCache, db.mailboxes, async () => {
        // A PURE OPTIMISATION with no behavioural effect, said plainly because it is not covered:
        // with an empty `list` (the server reported every id `notFound`) `putEmails` writes nothing
        // and `removalCountDeltas([])` is empty, so both calls below are already no-ops.
        if (list.length > 0) {
          await putEmails(db, accountId, list)
          // The folder badges (gap B7), restored from the RE-FETCHED envelopes and from nothing else.
          // The intent's id set would be wrong: an id the server reports `notFound` is REALLY gone
          // (that is what `notFound` means here — see above), and a count restored for it would be a
          // permanent over-count with no correction coming, because that mailbox never changes again
          // and so `Mailbox/changes` never re-reports it.
          await adjustMailboxCounts(
            db,
            accountId,
            negate(
              removalCountDeltas(
                list.map((envelope) => ({
                  id: envelope.id,
                  mailboxIds: envelope.mailboxIds,
                  unread: envelope.keywords.$seen !== true,
                })),
              ),
            ),
          )
        }
        await invalidateWindows(db, accountId, prunedKeys)
      })
      return
    }
    case 'mailbox': {
      if (undo.prior !== null) await db.mailboxes.put(undo.prior)
      else await deleteMailbox(db, accountId, undo.id)
      return
    }
    case 'mailboxProps': {
      // Column-scoped, so a rollback can only ever take back what THIS intent wrote. A folder the
      // delta has since destroyed is not re-created: `update` is a no-op on a missing key.
      for (const { id, ...props } of undo.prior) {
        if (Object.keys(props).length > 0) await db.mailboxes.update([accountId, id], props)
      }
      return
    }
    case 'contactCard': {
      // The prior row is stored whole (`abk` included), so the restore is exact — a rejected update
      // reinstates the pre-edit card, a rejected create removes it, a rejected delete brings it back.
      if (undo.prior !== null) await db.contactCards.put(undo.prior)
      else await deleteContactCards(db, accountId, [undo.id])
      return
    }
    case 'addressBook': {
      if (undo.prior !== null) await db.addressBooks.put(undo.prior)
      else await deleteAddressBooks(db, accountId, [undo.id])
      return
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Enqueue.
// ---------------------------------------------------------------------------------------------

export interface EnqueueOptions {
  /** Client-generated, stable-across-retries intent id (caller supplies it — no ambient randomness). */
  readonly id: Id
  readonly ifInState?: string | null
  readonly now: number
  /** Epoch ms before which replay must not fire (M2.8 undo-send grace); omit for immediate replay. */
  readonly notBefore?: number | null
}

/** Apply optimistically + persist the intent together with its durable undo (M3.3). */
export async function enqueueAction(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  options: EnqueueOptions,
): Promise<{ id: Id; undo: OutboxUndo }> {
  const undo = await applyOptimistic(db, accountId, intent)
  const row: OutboxRow = {
    accountId,
    id: options.id,
    type: intent.kind,
    payload: intent,
    ifInState: options.ifInState ?? null,
    status: 'pending',
    attempts: 0,
    createdAt: options.now,
    lastError: null,
    notBefore: options.notBefore ?? null,
    nextAttemptAt: null,
    undo,
    conflict: null,
    refreshes: 0,
  }
  await enqueue(db, row)
  return { id: options.id, undo }
}

// ---------------------------------------------------------------------------------------------
// Replay.
// ---------------------------------------------------------------------------------------------

function keywordUpdate(
  intent: Extract<OutboxIntent, { kind: 'setKeywords' }>,
): Record<Id, PatchObject> {
  const patch: PatchObject = { [`keywords/${intent.keyword}`]: intent.value ? true : null }
  return Object.fromEntries(intent.emailIds.map((id) => [id, patch]))
}

function moveUpdate(intent: Extract<OutboxIntent, { kind: 'move' }>): Record<Id, PatchObject> {
  const patch: PatchObject = { [`mailboxIds/${intent.to}`]: true }
  if (intent.from !== null) patch[`mailboxIds/${intent.from}`] = null
  return Object.fromEntries(intent.emailIds.map((id) => [id, patch]))
}

function executeIntent(
  port: JmapPort,
  intent: OutboxIntent,
  ifInState: string | null,
): Promise<PortSetResult> {
  switch (intent.kind) {
    case 'setKeywords':
      return port.setEmails({ update: keywordUpdate(intent), ifInState })
    case 'move':
      return port.setEmails({ update: moveUpdate(intent), ifInState })
    case 'destroyEmails':
      return port.setEmails({ destroy: intent.emailIds, ifInState })
    case 'createMailbox': {
      const props: Partial<Mailbox> = {
        name: intent.props.name,
        parentId: intent.props.parentId,
        /**
         * Sent EXPLICITLY, and the folder disappears without it. RFC 8621 §2 says `isSubscribed`
         * "SHOULD default to false for Mailboxes in shared accounts … and true for any new
         * Mailboxes created by the user themself", but that is a SHOULD and the fixture does not
         * honour it: measured on Stalwart v0.16.18, a `Mailbox/set create` that omits the property
         * is stored with `isSubscribed: false`.
         *
         * Since M-5 the sidebar hides an unsubscribed folder, so the two together produced a folder
         * that the user creates, sees (the optimistic row says `true`), and then watches vanish the
         * moment the server's own copy syncs back — with no way to get it back except "Manage
         * folders", where it is switched off for a choice nobody made. One word on the wire is the
         * whole fix; the optimistic row in `applyIntent` has always said `true`, and now agrees
         * with what the server is told.
         */
        isSubscribed: true,
      }
      if (intent.props.sortOrder !== undefined) props.sortOrder = intent.props.sortOrder
      return port.setMailboxes({ create: { [intent.creationId]: props }, ifInState })
    }
    case 'renameMailbox':
      return port.setMailboxes({ update: { [intent.id]: { name: intent.name } }, ifInState })
    case 'moveMailbox':
      return port.setMailboxes({
        update: { [intent.id]: { parentId: intent.parentId } },
        ifInState,
      })
    case 'deleteMailbox':
      return port.setMailboxes({ destroy: [intent.id], ifInState })
    case 'updateMailbox': {
      const patch: PatchObject = {}
      // `role: null` CLEARS the role and is a legitimate value, so the gate is `!== undefined`.
      if (intent.props.role !== undefined) patch.role = intent.props.role
      if (intent.props.isSubscribed !== undefined) patch.isSubscribed = intent.props.isSubscribed
      return port.setMailboxes({ update: { [intent.id]: patch }, ifInState })
    }
    case 'reorderMailboxes':
      return port.setMailboxes({
        update: Object.fromEntries(
          intent.order.map((entry) => [entry.id, { sortOrder: entry.sortOrder }]),
        ),
        ifInState,
      })
    case 'createContactCard':
      return port.setContactCards({
        create: { [intent.creationId]: cardCreateProps(intent.card) },
        ifInState,
      })
    case 'updateContactCard':
      return port.setContactCards({ update: { [intent.id]: intent.patch }, ifInState })
    case 'deleteContactCard':
      return port.setContactCards({ destroy: [intent.id], ifInState })
    case 'createAddressBook': {
      const props: Partial<AddressBook> = { name: intent.props.name }
      if (intent.props.description != null) props.description = intent.props.description
      return port.setAddressBooks({ create: { [intent.creationId]: props }, ifInState })
    }
    case 'updateAddressBook': {
      const patch: PatchObject = {}
      if (intent.props.name !== undefined) patch.name = intent.props.name
      if (intent.props.description !== undefined) patch.description = intent.props.description
      return port.setAddressBooks({ update: { [intent.id]: patch }, ifInState })
    }
    case 'deleteAddressBook':
      // `onDestroyRemoveContents` — see the intent's own note: without it a book holding a single
      // card cannot be destroyed, and the user has already been told what goes with it.
      return port.setAddressBooks({
        destroy: [intent.id],
        onDestroyRemoveContents: true,
        ifInState,
      })
    case 'saveDraft':
      // create-new + destroy-old in one call — RFC 8620 §5.3 processes create before destroy, so the
      // new draft exists before the prior one is removed (gap-free).
      return port.setEmails({
        create: { [intent.creationId]: intent.email },
        ...(intent.priorServerId ? { destroy: [intent.priorServerId] } : {}),
        ifInState,
      })
    case 'discardDraft':
      return port.setEmails({ destroy: [intent.serverEmailId], ifInState })
    case 'sendEmail':
      return port.submitEmail({
        emailCreationId: intent.emailCreationId,
        email: intent.email,
        destroyServerDraftId: intent.priorServerId,
        submissionCreationId: intent.submissionCreationId,
        identityId: intent.identityId,
        envelope: intent.envelope,
        onSuccessUpdateEmail: intent.onSuccessUpdateEmail,
        sourceUpdate: intent.source
          ? { id: intent.source.emailId, patch: { [`keywords/${intent.source.keyword}`]: true } }
          : null,
        ifInState,
      })
  }
}

/**
 * EVERY rejected object of this intent, keyed by the id (or creation id) it failed under (M3.3,
 * defect D1). The predecessor returned only the FIRST error and the caller then rolled the WHOLE
 * intent back — so one `notFound` in a 500-id destroy resurrected 500 messages.
 *
 * A `Map` (not a record) so `noUncheckedIndexedAccess` cannot be side-stepped.
 */
function rejections(intent: OutboxIntent, result: PortSetResult): Map<string, PortSetError> {
  const found = new Map<string, PortSetError>()
  const collect = (record: Record<string, PortSetError>, ids: readonly string[]): void => {
    for (const id of ids) {
      const error = record[id]
      if (error) found.set(id, error)
    }
  }
  switch (intent.kind) {
    case 'setKeywords':
    case 'move':
      collect(result.notUpdated, intent.emailIds)
      break
    case 'destroyEmails':
      collect(result.notDestroyed, intent.emailIds)
      break
    case 'createMailbox':
      collect(result.notCreated, [intent.creationId])
      break
    case 'renameMailbox':
    case 'moveMailbox':
    case 'updateMailbox':
      collect(result.notUpdated, [intent.id])
      break
    case 'reorderMailboxes':
      collect(
        result.notUpdated,
        intent.order.map((entry) => entry.id),
      )
      break
    case 'deleteMailbox':
      collect(result.notDestroyed, [intent.id])
      break
    case 'createContactCard':
      collect(result.notCreated, [intent.creationId])
      break
    case 'updateContactCard':
      collect(result.notUpdated, [intent.id])
      break
    case 'deleteContactCard':
      collect(result.notDestroyed, [intent.id])
      break
    case 'createAddressBook':
      collect(result.notCreated, [intent.creationId])
      break
    case 'updateAddressBook':
      collect(result.notUpdated, [intent.id])
      break
    case 'deleteAddressBook':
      collect(result.notDestroyed, [intent.id])
      break
    case 'saveDraft':
      collect(result.notCreated, [intent.creationId])
      break
    case 'discardDraft':
      collect(result.notDestroyed, [intent.serverEmailId])
      break
    case 'sendEmail':
      // The result is the EmailSubmission/set response — a rejected submission (bad recipient, quota,
      // size) lands in notCreated under the submission creation id.
      collect(result.notCreated, [intent.submissionCreationId])
      break
  }
  return found
}

/**
 * On a confirmed create, swap the optimistic client id for the server id — on the mailbox row AND
 * on every dependent reference: emails filed into it (mailboxIds → amb/akw recomputed), child
 * mailboxes' parentId, and any still-QUEUED outbox intent whose payload points at the temp id
 * (e.g. a rename/delete/move of the folder queued right after its create). Otherwise those
 * references dangle and the server rejects them with a bogus `notFound`.
 */
async function reconcileCreate(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  result: PortSetResult,
): Promise<void> {
  if (intent.kind !== 'createMailbox') return
  const created = result.created[intent.creationId]
  if (!created) return
  const tempId = intent.creationId
  const serverId = created.id

  const temp = await db.mailboxes.get([accountId, tempId])
  await deleteMailbox(db, accountId, tempId)
  if (temp) await db.mailboxes.put({ ...temp, id: serverId })

  // Emails filed into the temp folder → re-file under the server id (putEmails recomputes amb/akw).
  const affected = await db.emails.where('amb').equals(scopeKey(accountId, tempId)).toArray()
  if (affected.length > 0) {
    await putEmails(
      db,
      accountId,
      affected.map((row) => {
        const mailboxIds = { ...row.mailboxIds }
        delete mailboxIds[tempId]
        mailboxIds[serverId] = true
        return { ...row, mailboxIds }
      }),
    )
  }

  // Child mailboxes created under the temp folder.
  await db.mailboxes
    .where('accountId')
    .equals(accountId)
    .filter((row) => row.parentId === tempId)
    .modify({ parentId: serverId })

  // Still-queued intents that reference the temp id in their payload. An `inflight` row is being
  // executed right now against the id it was built with — rewriting it under the executing pass
  // would have no effect on the in-flight request and could corrupt its retry payload.
  const queued = await db.outbox.where('accountId').equals(accountId).toArray()
  for (const queuedRow of queued) {
    if (queuedRow.status === 'inflight') continue
    const rewritten = rewriteIntentTarget(queuedRow.payload as OutboxIntent, tempId, serverId)
    if (rewritten) {
      await db.outbox.update([accountId, queuedRow.id], { payload: rewritten })
    }
  }
}

/**
 * Rewrite every still-QUEUED intent whose payload references `tempId`, swapping in `serverId` (M4.2).
 * The contact analogue of the queued-rewrite loop inside {@link reconcileCreate}: an `inflight` row is
 * executing against the id it was built with and must be left alone. `rewrite` returns a NEW intent or
 * `null` (this row does not reference the temp id).
 */
async function rewriteQueued(
  db: ReplicaDb,
  accountId: Id,
  rewrite: (intent: OutboxIntent) => OutboxIntent | null,
): Promise<void> {
  const queued = await db.outbox.where('accountId').equals(accountId).toArray()
  for (const queuedRow of queued) {
    if (queuedRow.status === 'inflight') continue
    const rewritten = rewrite(queuedRow.payload as OutboxIntent)
    if (rewritten) await db.outbox.update([accountId, queuedRow.id], { payload: rewritten })
  }
}

/** A queued update/delete of a card created in the same session: re-point its id at the server id. */
function rewriteContactCardTarget(intent: OutboxIntent, fromId: Id, toId: Id): OutboxIntent | null {
  switch (intent.kind) {
    case 'updateContactCard':
    case 'deleteContactCard':
      return intent.id === fromId ? { ...intent, id: toId } : null
    default:
      return null
  }
}

/**
 * A queued intent referencing an address book created in the same session: re-point the book id.
 * Carriers — a card CREATED into the fresh book (`addressBookIds`), an UPDATE patch that files a
 * card into it (`addressBookIds/<tempId>` pointer), and a rename/delete of the BOOK itself queued
 * before its create was acknowledged — all of which would otherwise dangle and be answered with a
 * bogus `notFound` (the D5 defect, contacts edition).
 */
function rewriteAddressBookTarget(intent: OutboxIntent, fromId: Id, toId: Id): OutboxIntent | null {
  if (intent.kind === 'updateAddressBook' || intent.kind === 'deleteAddressBook') {
    return intent.id === fromId ? { ...intent, id: toId } : null
  }
  if (intent.kind === 'createContactCard') {
    if (intent.card.addressBookIds[fromId] !== true) return null
    const addressBookIds = { ...intent.card.addressBookIds }
    delete addressBookIds[fromId]
    addressBookIds[toId] = true
    return { ...intent, card: { ...intent.card, addressBookIds } }
  }
  if (intent.kind === 'updateContactCard') {
    const fromKey = `addressBookIds/${fromId}`
    if (!(fromKey in intent.patch)) return null
    const patch: PatchObject = {}
    for (const [key, value] of Object.entries(intent.patch)) {
      if (key === fromKey) patch[`addressBookIds/${toId}`] = value
      else patch[key] = value
    }
    return { ...intent, patch }
  }
  return null
}

/**
 * On a confirmed card create, swap the optimistic creation id for the server id (M4.2) — on the card
 * row AND on any still-queued update/delete of that card. The direct analogue of the mailbox half of
 * {@link reconcileCreate}; a card has no dependents filed UNDER it (group membership is by JSContact
 * `uid`, not JMAP id), so only the row and the queued intents move.
 */
async function reconcileContactCardCreate(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  result: PortSetResult,
): Promise<void> {
  if (intent.kind !== 'createContactCard') return
  const created = result.created[intent.creationId]
  if (!created) return
  const tempId = intent.creationId
  const serverId = created.id
  const temp = await db.contactCards.get([accountId, tempId])
  await deleteContactCards(db, accountId, [tempId])
  if (temp) await putContactCards(db, accountId, [{ ...rowToCard(temp), id: serverId }])
  await rewriteQueued(db, accountId, (queued) => rewriteContactCardTarget(queued, tempId, serverId))
}

/**
 * On a confirmed address-book create, swap the optimistic creation id for the server id (M4.2) — on
 * the book row, on every card optimistically filed into the temp book (`abk` membership index → the
 * server id, exactly as {@link reconcileCreate} re-files emails via `amb`), and on any still-queued
 * intent that referenced the temp book.
 */
async function reconcileAddressBookCreate(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  result: PortSetResult,
): Promise<void> {
  if (intent.kind !== 'createAddressBook') return
  const created = result.created[intent.creationId]
  if (!created) return
  const tempId = intent.creationId
  const serverId = created.id
  const temp = await db.addressBooks.get([accountId, tempId])
  await deleteAddressBooks(db, accountId, [tempId])
  if (temp) await db.addressBooks.put({ ...temp, id: serverId })

  const affected = await db.contactCards.where('abk').equals(scopeKey(accountId, tempId)).toArray()
  if (affected.length > 0) {
    await putContactCards(
      db,
      accountId,
      affected.map((row) => {
        const addressBookIds = { ...row.addressBookIds }
        delete addressBookIds[tempId]
        addressBookIds[serverId] = true
        return { ...rowToCard(row), addressBookIds }
      }),
    )
  }
  await rewriteQueued(db, accountId, (queued) => rewriteAddressBookTarget(queued, tempId, serverId))
}

/** On a confirmed draft save, record the new server Email id on the local drafts row (M2.6). */
async function reconcileDraftSave(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  result: PortSetResult,
): Promise<void> {
  if (intent.kind !== 'saveDraft') return
  const created = result.created[intent.creationId]
  if (!created) return
  await db.drafts.update([accountId, intent.localId], {
    serverEmailId: created.id,
    status: 'synced',
    lastError: null,
  })
}

/**
 * Mark the local drafts row `error` when its server save/discard was rejected (M2.6). `code` is a
 * stable JMAP `SetError` type or a {@link ConflictCode} — never prose (M3.3, defect D8).
 */
async function stampDraftError(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  code: string,
): Promise<void> {
  if (intent.kind !== 'saveDraft' && intent.kind !== 'discardDraft') return
  await db.drafts.update([accountId, intent.localId], {
    status: 'error',
    lastError: code,
    errorKind: 'save',
  })
}

/**
 * On a confirmed send, drop the local drafts edit-state row (M2.8 — the Sent copy arrives via delta).
 * `onSuccessUpdateEmail` (Drafts→Sent, clear `$draft`) is best-effort per RFC 8621 §7.5: if the
 * submission is accepted but the refile patch fails, the sent message lingers in Drafts flagged
 * `$draft` (a misfile the user can correct), but it was still sent — so we still drop the edit-state.
 */
async function reconcileSend(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  result: PortSetResult,
): Promise<void> {
  if (intent.kind !== 'sendEmail') return
  if (!result.created[intent.submissionCreationId]) return
  await deleteDraft(db, accountId, intent.localId)
}

/** Mark the local drafts row `error` when a send was rejected (M2.8) — the notifier reopens it. */
async function stampSendError(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  code: string,
): Promise<void> {
  if (intent.kind !== 'sendEmail') return
  await db.drafts.update([accountId, intent.localId], {
    status: 'error',
    lastError: code,
    errorKind: 'send',
  })
}

/**
 * On a REJECTED send (M2.8), adopt the draft the sibling `Email/set` just created. The submission
 * failed but its Email/set create ran first and committed (a new draft in Drafts, the prior one
 * destroyed) — so the local row's `serverEmailId` now points at a destroyed id. Re-point it at the
 * fresh id so the reopened draft's next save replaces it in place instead of destroying a gone id
 * and spawning a duplicate. Only reachable when the request itself succeeded (a per-object
 * rejection); a transport/method throw carries no result, so that residue is reconciled by re-sync.
 */
async function reconcileSendFailure(
  db: ReplicaDb,
  accountId: Id,
  intent: OutboxIntent,
  result: PortSetResult,
): Promise<void> {
  if (intent.kind !== 'sendEmail') return
  const created = result.emailCreated
  if (!created) return
  await db.drafts.update([accountId, intent.localId], { serverEmailId: created.id })
}

/**
 * Rewrite an intent's mailbox references from `fromId` to `toId`; null when it referenced neither.
 * Both the SUBJECT of a folder intent (`renameMailbox.id`, `moveMailbox.id`, `deleteMailbox.id`) and
 * its target/parent must be rewritten (M3.3, defect D5): create-then-rename a folder offline used to
 * leave the rename pointing at the temp creation id, which the server answered with `notFound` — a
 * bogus conflict plus a permanently mis-named folder on the server.
 */
function rewriteIntentTarget(intent: OutboxIntent, fromId: Id, toId: Id): OutboxIntent | null {
  switch (intent.kind) {
    case 'move':
      if (intent.to === fromId) return { ...intent, to: toId }
      if (intent.from === fromId) return { ...intent, from: toId }
      return null
    case 'renameMailbox':
    case 'deleteMailbox':
    case 'updateMailbox':
      return intent.id === fromId ? { ...intent, id: toId } : null
    // Create a folder offline, then order it or mark it as the Archive before the create has
    // replayed: without this the update would still name the creation id and come back `notFound`
    // (defect D5, the same trap the rename fell into).
    case 'reorderMailboxes': {
      if (!intent.order.some((entry) => entry.id === fromId)) return null
      return {
        ...intent,
        order: intent.order.map((entry) => (entry.id === fromId ? { ...entry, id: toId } : entry)),
      }
    }
    case 'moveMailbox': {
      const id = intent.id === fromId ? toId : intent.id
      const parentId = intent.parentId === fromId ? toId : intent.parentId
      return id !== intent.id || parentId !== intent.parentId ? { ...intent, id, parentId } : null
    }
    case 'createMailbox':
      return intent.props.parentId === fromId
        ? { ...intent, props: { ...intent.props, parentId: toId } }
        : null
    default:
      return null
  }
}

export interface ReplayOptions {
  /** Wall clock for the `notBefore` grace + the `nextAttemptAt` backoff gate; defaults to `Date.now()`. */
  readonly now?: number
  /** Injected jitter source for the backoff curve (tests pass `() => 0`); defaults to `Math.random`. */
  readonly random?: () => number
  /** Re-sync the given type and return its FRESH state string — the bounded `stateMismatch` recovery.
   *  Typed over every {@link GuardedType} so a guarded contact intent refreshes ContactCard, not Mailbox. */
  readonly refreshState?: (type: GuardedType) => Promise<string | null>
  /** `false` skips the pass entirely (the engine's `isOnline()` guard). Defaults to `true`. */
  readonly online?: boolean
  readonly backoff?: OutboxBackoff
}

export interface ReplaySummary {
  /** Rows completed this pass (confirmed, or already-satisfied server-side). */
  readonly replayed: number
  /** Rows dead-lettered this pass (a permanent, user-facing rejection). */
  readonly failed: number
  /** Rows still `pending` whose attempt count has passed {@link STUCK_AFTER_ATTEMPTS}. */
  readonly stuck: number
  /** Total dead letters in the queue after the pass (the problems-dialog backlog). */
  readonly conflicted: number
}

/** A row is replayable when BOTH its undo-send grace and its retry backoff have elapsed. */
function readyAt(row: OutboxRow): number {
  return Math.max(row.notBefore ?? 0, row.nextAttemptAt ?? 0)
}

/**
 * Apply every rollback still OWED (an `error` row whose `undo` was never applied — a re-fetch that
 * could not reach the server, or a crash between the dead-letter write and the undo). Runs at the
 * start of every pass, so a stale optimistic change can never survive silently: it is either undone
 * or still visibly listed as a problem.
 */
async function drainOwedUndos(port: JmapPort, db: ReplicaDb, accountId: Id): Promise<void> {
  for (const row of await failedOutbox(db, accountId)) {
    const undo = row.undo ?? null
    if (undo === null) continue
    try {
      await applyUndo(
        db,
        port,
        accountId,
        row.payload as OutboxIntent,
        undo,
        row.conflict?.ids ?? null,
      )
      await db.outbox.update([accountId, row.id], { undo: null })
    } catch {
      // Network — the rollback stays OWED and is retried on the next pass. Never dropped.
    }
  }
}

/**
 * Recover intents stranded `inflight` by a leader killed mid-request. Re-sending an idempotent `set`
 * is safe → back to `pending`. But an `EmailSubmission` is NOT idempotent: a re-sent `sendEmail`
 * could deliver the message twice, so a stranded send is dead-lettered with the `sendInterrupted`
 * CODE ("was it sent?") instead of auto-resent (M2.8) — the user decides via the reopened draft.
 *
 * `attempts` IS INCREMENTED on the way back to `pending`. A stranded row was dispatched — the
 * request went out and we simply never learned its fate — so recording the attempt is true on its
 * own terms. It is also load-bearing: {@link unsentOutbox} reads `attempts === 0` as "provably never
 * dispatched", and without the increment this function would launder a dispatched row into a set
 * whose whole purpose is to exclude it, double-counting its ±1 on top of a server number that may
 * already contain it. Note the asymmetry with the safety argument one line up: a re-sent `set` is
 * harmless BECAUSE it is idempotent, and a ±1 count delta is precisely the thing that is not.
 *
 * TWO REAL SIDE EFFECTS, both accepted. A row stranded {@link STUCK_AFTER_ATTEMPTS} times is now
 * REPORTED as stuck — which is accurate (it has been dispatched six times and never settled) and
 * costs nothing but a "still trying" notice; it is never discarded or rolled back. And the next
 * transient failure's backoff is computed from the higher counter, so it waits one step longer.
 * Neither delays THIS recovery: `nextAttemptAt` is untouched, so the row is ready immediately.
 */
async function recoverStranded(db: ReplicaDb, accountId: Id, now: number): Promise<void> {
  const stranded = await db.outbox
    .where('[accountId+status]')
    .equals([accountId, 'inflight'])
    .toArray()
  for (const row of stranded) {
    const intent = row.payload as OutboxIntent
    if (intent.kind !== 'sendEmail') {
      await db.outbox.update([accountId, row.id], {
        status: 'pending',
        attempts: row.attempts + 1,
      })
      continue
    }
    const code: ConflictCode = 'sendInterrupted'
    await stampSendError(db, accountId, intent, code)
    const conflict: OutboxConflict = {
      code,
      errorType: null,
      detail: null,
      ids: [intent.submissionCreationId],
      at: now,
    }
    await db.outbox.update([accountId, row.id], { status: 'error', lastError: code, conflict })
  }
}

/**
 * Replay the pending outbox in FIFO order against the server.
 *
 *  1. drain any OWED rollback, 2. recover stranded `inflight` rows, 3. replay every `pending` row
 *  whose grace + backoff have elapsed.
 *
 * A transient failure backs the row off and STOPS the pass (the server is unhappy, not the row —
 * and FIFO means the failed row is first anyway) WITHOUT rolling back or dead-lettering. A permanent
 * rejection undoes only the FAILED ids, dead-letters the row and CONTINUES (a poison intent must not
 * starve the FIFO tail). Auth expiry re-throws with the row left `pending`.
 */
export async function replayOutbox(
  port: JmapPort,
  db: ReplicaDb,
  accountId: Id,
  options: ReplayOptions = {},
): Promise<ReplaySummary> {
  const now = options.now ?? Date.now()
  const random = options.random ?? Math.random
  const backoff = options.backoff ?? DEFAULT_OUTBOX_BACKOFF

  const summarize = async (replayed: number, failed: number): Promise<ReplaySummary> => {
    const live = await pendingOutbox(db, accountId)
    const stuck = live.filter(
      (row) => row.status === 'pending' && row.attempts >= STUCK_AFTER_ATTEMPTS,
    ).length
    const conflicted = (await failedOutbox(db, accountId)).length
    return { replayed, failed, stuck, conflicted }
  }

  // Offline: nothing to attempt. Rows keep their optimistic state, `attempts` stays put, and NOTHING
  // is rolled back or discarded — an outage of any length costs the queue nothing.
  if (options.online === false) return summarize(0, 0)

  // Stranded-recovery FIRST: a send interrupted mid-flight becomes a dead letter whose undo (the
  // source `$answered` flag) is then owed — the drain below settles it in this same pass.
  await recoverStranded(db, accountId, now)
  await drainOwedUndos(port, db, accountId)

  const rows = (await pendingOutbox(db, accountId)).filter(
    (row) => row.status === 'pending' && readyAt(row) <= now,
  )
  let replayed = 0
  let failed = 0

  /** Dead-letter a row: undo ONLY the failed objects, stamp the conflict, keep the rest applied. */
  const deadLetter = async (
    row: OutboxRow,
    intent: OutboxIntent,
    code: ConflictCode,
    errorType: string | null,
    detail: string | null,
    ids: string[],
  ): Promise<void> => {
    failed += 1
    const conflict: OutboxConflict = { code, errorType, detail, ids, at: now }
    // Persist the dead letter with its undo STILL SET (⇒ owed) before attempting the rollback, so a
    // crash or a failing re-fetch mid-undo leaves a row that `drainOwedUndos` will finish later.
    await db.outbox.update([accountId, row.id], {
      status: 'error',
      lastError: errorType ?? code,
      conflict,
    })
    await stampDraftError(db, accountId, intent, errorType ?? code)
    await stampSendError(db, accountId, intent, errorType ?? code)
    const undo = row.undo ?? null
    if (undo === null) return
    try {
      await applyUndo(db, port, accountId, intent, undo, ids)
      await db.outbox.update([accountId, row.id], { undo: null })
    } catch {
      // Owed — drained on a later pass.
    }
  }

  for (const row of rows) {
    const intent = row.payload as OutboxIntent
    // Atomically claim the row before executing: re-read + flip pending→inflight in ONE rw txn so a
    // concurrent cancelSend (undo) that deletes the row wins the race, instead of the send firing on
    // a row that was just deleted (a Dexie `update` on a missing key is a silent no-op). Skip the row
    // if it is gone or no longer pending (already claimed / canceled / not yet ready).
    const claimed = await db.transaction('rw', db.outbox, async () => {
      const current = await db.outbox.get([accountId, row.id])
      if (current === undefined || current.status !== 'pending') return false
      if (readyAt(current) > now) return false
      await db.outbox.update([accountId, row.id], { status: 'inflight' })
      return true
    })
    if (!claimed) continue

    // Execute, with a BOUNDED `stateMismatch` auto-resolve: re-sync to a fresh state and re-run. The
    // counter is persisted, so a server that always mismatches cannot spin forever across reloads.
    let ifInState = row.ifInState
    let refreshes = row.refreshes ?? 0
    let result: PortSetResult | undefined
    let thrown: unknown
    for (;;) {
      try {
        result = await executeIntent(port, intent, ifInState)
        break
      } catch (error) {
        const verdict = classifyThrown(error, row.attempts + 1, random(), backoff)
        if (
          verdict.kind !== 'refresh' ||
          refreshes >= MAX_REFRESHES ||
          options.refreshState === undefined
        ) {
          thrown = error
          break
        }
        refreshes += 1
        await db.outbox.update([accountId, row.id], { refreshes })
        // Re-execute against the FRESH state; the server's answer to that re-run IS the re-check of
        // the precondition (its per-object SetError is authoritative — a locally-derived predicate
        // could disagree with it). Refresh the type that guards THIS intent — a guarded contact intent
        // re-syncs ContactCard, not Mailbox. (`?? 'Mailbox'` is unreachable: only a guarded intent, one
        // with a non-null `stateGuardType`, can carry the `ifInState` that yields a `stateMismatch`.)
        ifInState = await options.refreshState(stateGuardType(intent.kind) ?? 'Mailbox')
      }
    }

    if (result === undefined) {
      // ---- thrown ----
      if (isAuthExpiry(thrown)) {
        // The session expired: nothing about this row is wrong. Put it back and let the engine route
        // to the re-auth funnel (FR-AUTH-06).
        //
        // `attempts` IS incremented, for {@link unsentOutbox}'s "provably never dispatched" test and
        // for no other reason. A 401/403 very probably precedes processing — but "very probably" is
        // the wrong standard for an arithmetic re-apply whose failure mode (a double-counted ±1) does
        // not self-correct, while the cost of being conservative is a badge that reverts until the
        // intent lands. The row is still ready immediately (`nextAttemptAt` untouched) and is not
        // rolled back; the only visible cost is that a session expiring
        // {@link STUCK_AFTER_ATTEMPTS} times over gets the row a "still trying" notice.
        await db.outbox.update([accountId, row.id], {
          status: 'pending',
          attempts: row.attempts + 1,
        })
        throw thrown
      }
      const attempts = row.attempts + 1
      // An `EmailSubmission` is NOT idempotent, and a THROWN error leaves it UNKNOWN whether the
      // submission reached the server — the request may have been processed and only the RESPONSE
      // lost. Auto-retrying could deliver the message TWICE. So a thrown send is dead-lettered as
      // `sendInterrupted`, exactly like a stranded `inflight` one ({@link recoverStranded}), and the
      // user decides via the reopened draft ("check Sent before resending"). Without this the
      // transient branch below would reset it to `pending` and silently re-send it. (Auth expiry is
      // handled above and IS safe to keep pending: a 401 is rejected before the mail is processed.)
      if (intent.kind === 'sendEmail') {
        await db.outbox.update([accountId, row.id], { attempts })
        await deadLetter(
          { ...row, attempts },
          intent,
          'sendInterrupted',
          thrownErrorType(thrown),
          errorMessage(thrown),
          rejectionKeys(intent),
        )
        continue
      }
      const verdict = classifyThrown(thrown, attempts, random(), backoff)
      if (verdict.kind === 'retry') {
        // TRANSIENT — the ONE branch that must never roll back and never dead-letter (defect D3).
        await db.outbox.update([accountId, row.id], {
          status: 'pending',
          attempts,
          nextAttemptAt: now + verdict.delayMs,
          lastError: thrownErrorType(thrown) ?? errorMessage(thrown),
        })
        break // the server/network is down — hammering the FIFO tail against it is pointless
      }
      // Not retryable ⇒ dead-letter it. A `refresh` verdict that reaches here has exhausted its
      // MAX_REFRESHES budget (a server that mismatches forever) — that IS the state conflict.
      // (`satisfied` is unreachable: a call that THREW cannot have already succeeded.)
      const code: ConflictCode = verdict.kind === 'conflict' ? verdict.code : 'stateConflict'
      const detail = verdict.kind === 'conflict' ? verdict.detail : errorMessage(thrown)
      await db.outbox.update([accountId, row.id], { attempts, refreshes })
      await deadLetter({ ...row, refreshes }, intent, code, thrownErrorType(thrown), detail, [
        ...rejectionKeys(intent),
      ])
      continue
    }

    // ---- a response came back: classify it per REJECTED OBJECT ----
    const failures = rejections(intent, result)
    if (failures.size === 0) {
      await reconcileCreate(db, accountId, intent, result)
      await reconcileContactCardCreate(db, accountId, intent, result)
      await reconcileAddressBookCreate(db, accountId, intent, result)
      await reconcileDraftSave(db, accountId, intent, result)
      await reconcileSend(db, accountId, intent, result)
      await db.outbox.delete([accountId, row.id])
      replayed += 1
      continue
    }

    const retryIds: string[] = []
    const conflictIds: string[] = []
    let worst: { code: ConflictCode; errorType: string; detail: string | null } | undefined
    for (const [id, error] of failures) {
      const verdict = classifySetError(intent.kind, error)
      if (verdict.kind === 'retry') retryIds.push(id)
      else if (verdict.kind === 'conflict') {
        conflictIds.push(id)
        worst ??= { code: verdict.code, errorType: error.type, detail: verdict.detail }
      }
      // `satisfied` (a destroy of an already-gone object) needs NOTHING: the optimistic state is
      // correct and the object is not restored (defect D2).
    }

    if (conflictIds.length === 0 && retryIds.length === 0) {
      // Every failure was `satisfied` — the intent's goal already holds server-side. A SUCCESS.
      await db.outbox.delete([accountId, row.id])
      replayed += 1
      continue
    }

    if (retryIds.length > 0) {
      // At least one object failed TRANSIENTLY (`rateLimit`) — whether or not others failed
      // permanently. Back the WHOLE row off and re-execute it later; re-sending the already-applied
      // objects is a no-op because every intent is idempotent.
      //
      // This MUST be checked before the dead-letter branch: dead-lettering a MIXED result would
      // silently drop the transient objects — never retried, never undone, never recorded in
      // `conflict.ids` — leaving their optimistic change in the replica while the server never saw
      // it. That is exactly the silent divergence FR-OFF-03 forbids. It converges: once the transient
      // failures clear, a later pass sees only the permanent ones and dead-letters then.
      const attempts = row.attempts + 1
      await db.outbox.update([accountId, row.id], {
        status: 'pending',
        attempts,
        nextAttemptAt: now + backoffDelayMs(attempts, random(), backoff),
        lastError: 'rateLimit',
      })
      break
    }

    // A permanent rejection of SOME objects: undo ONLY those, keep the applied ones applied.
    const reason = worst ?? { code: 'serverRejected' as ConflictCode, errorType: '', detail: null }
    await reconcileSendFailure(db, accountId, intent, result)
    await db.outbox.update([accountId, row.id], { attempts: row.attempts + 1 })
    await deadLetter(row, intent, reason.code, reason.errorType || null, reason.detail, conflictIds)
  }

  return summarize(replayed, failed)
}

/** Every object key this intent could fail under — the undo scope when the whole call threw. */
function rejectionKeys(intent: OutboxIntent): string[] {
  switch (intent.kind) {
    case 'setKeywords':
    case 'move':
    case 'destroyEmails':
      return [...intent.emailIds]
    case 'createMailbox':
      return [intent.creationId]
    case 'renameMailbox':
    case 'moveMailbox':
    case 'deleteMailbox':
    case 'updateMailbox':
      return [intent.id]
    // Every sibling in the group: a `Mailbox/set` that rejects one `sortOrder` names that id, and a
    // throw names none of them — so the whole group is the undo scope.
    case 'reorderMailboxes':
      return intent.order.map((entry) => entry.id)
    case 'createContactCard':
    case 'createAddressBook':
      return [intent.creationId]
    case 'updateContactCard':
    case 'deleteContactCard':
    case 'updateAddressBook':
    case 'deleteAddressBook':
      return [intent.id]
    case 'saveDraft':
      return [intent.creationId]
    case 'discardDraft':
      return [intent.serverEmailId]
    case 'sendEmail':
      return [intent.submissionCreationId]
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
