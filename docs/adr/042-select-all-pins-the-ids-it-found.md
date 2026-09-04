# 042 — "Select all 300" pins the 300 ids it found; it does not follow the query

- **Status:** accepted
- **Date:** 2026-09-04
- **Work package:** §11 post-V1 backlog, *Select-all-in-folder, the rest of FR-LST-04*
  (filed 2026-09-02 with review finding **R-08**, stage 2)
- **Relates to:** `apps/web/src/mail/message-selection.ts` (`selectAllInQuery`, `beyondWindow`),
  `apps/web/src/mail/list-store.ts` (`pruneSelection`),
  `apps/web/src/mail/use-select-all-in-query.ts`, `apps/web/src/sync/engine/engine.ts`
  (`collectQueryIds`), `apps/web/src/mail/rights.ts` (the account floor), ADR-043 (the bound)

## Context

FR-LST-04 asks for "select-all-in-folder". What shipped was select-all-in-**window**: `selectAll`
ticks the loaded `queryCache` ids, which start at 50 and grow only as `loadMore` pages, so in a
folder of 300 it selected 50. R-08 stage 1 made the surface honest about that (a mixed header box
and "50 of 300 selected"); stage 2 is the missing scope, and the question it has to answer first is
what "all 300" is going to MEAN between the click that says it and the Archive that acts on it.

Two models, and they are not variations of one thing:

1. **A scope.** The selection records "the query, whole", and every action resolves it at dispatch
   time. This is what Gmail does, and it is the only model that can be correct about a folder that
   changes: the action lands on whatever matches when it lands.
2. **A snapshot.** The ids are paged out of `Email/query` at the moment of the click and become an
   ordinary explicit selection of 300 ids.

The scope model does not survive contact with this app's write path. Every write is an outbox intent
over an explicit `emailIds` array — that is what makes it durable, replayable offline and undoable by
dispatching the inverse — so a scope would have to be resolved into ids at dispatch time anyway, only
later, on a network round trip, in a code path that has no way to report "I could not read the
folder" to a user who has already been told the action was queued. Offline it could not resolve at
all. And it would make the bar's own sentence unfalsifiable: "all 300" would mean "however many there
turn out to be", so the number would be decoration rather than a statement.

## Decision

**The snapshot.** `Engine.collectQueryIds(key, {max})` pages the ids out of `Email/query` in chunks
of 500 (no `Email/get` — ids are a selection, envelopes are a download), the reducer takes them as
`selectAllInQuery`, and from that moment on it is an ordinary selection that happens to be large.

Three things follow from it, and all three are load-bearing rather than incidental:

- **The bar names a NUMBER, never "all".** "300 selected" is a fact about what is held. A message
  arriving a second later is not in the set, the count does not move, and the header checkbox goes
  back to mixed because the window now holds a row that is not selected. Nothing has to be explained
  because nothing was over-claimed.
- **The spec comes off the cached window row**, not from the caller: `filter`, `sort` and
  `collapseThreads` together are what make an id-set. `collapseThreads` is the sharp one — a
  collapsed query answers with one id per thread and WHICH one depends on the sort, so re-deriving
  the sort here (oldest-first would be the more robust paging order, and `collectMatchingIds` uses it
  for exactly that reason) would select a different message per thread from the one on screen.
- **The store's prune needs a second rule.** `pruneSelection` drops any selected id the window no
  longer lists, which is right for a window selection and would take 250 of these 300 back on the
  next window publication. Under `beyondWindow` it prunes only ids that WERE in the window and are
  not any more — the one departure this store can observe — and leaves ids the window never held
  alone.

## Consequences

- **A message can leave the folder without leaving the selection.** Nothing on the client sees a
  removal it never held a row for, so an action can target an id that no longer matches the query.
  The blast radius is small and pre-existing in kind: a `move` patch against a message already
  elsewhere is a no-op on the source key, and a destroyed id comes back `notFound` and dead-letters
  where `use-outbox-problems.ts` can show it. It is the honest cost of a snapshot, and it is why the
  bar states a size instead of a claim.
- **Paging is racy at the edges, deliberately.** Walking `position` while another client edits the
  folder can repeat an id (de-duplicated) or skip one across a page boundary. The selection then
  holds a few fewer than `total` — and says the smaller number, because that is the one it can
  honour.
- **The rights verdict was already prepared for this and did not change.** With 250 of 300 rows
  unhydrated, `messageRights` falls back to the ACCOUNT FLOOR: granted iff every mailbox in the
  account grants the right. On the user's own account that is true and every verdict is unchanged;
  on an account with one denying mailbox the bulk actions refuse as a whole and say why. Deleting
  that clause would make select-all-in-folder go dead, which its own comment already warned about.
- **Undo carries the whole set for free.** The inverse is one more `move` intent over the same id
  array, auto-chunked on the wire like the forward one (`packages/jmap/src/chunking.ts`), so a
  300-message archive has a 300-message undo. The permanent destroy has no undo by definition and
  keeps the confirmation dialog it already had, which names the count.
- **A snapshot has to be bounded.** Holding the ids means holding them in two live `useEmailWindow`
  subscriptions; ADR-043 is where that number comes from.
