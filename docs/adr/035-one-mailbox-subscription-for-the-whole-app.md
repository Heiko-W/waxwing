# 035 — One mailbox subscription for the whole app

- **Status:** accepted
- **Date:** 2026-08-25
- **Work package:** §13 finding **B10** (root-caused 2026-07-20 while fixing a G2 test flake)
- **Relates to:** `apps/web/src/sync/mailbox-store.ts`, `apps/web/src/sync/react.tsx`
  (`useMailboxes`, `useMailboxesFor`, `useMailboxByRole`, `useMailboxByRoleOptional`),
  ADR-030 (the folder query), `apps/web/src/mail/use-action-overflow.ts`

## Context

`useMailboxes()` was a plain `useLiveQuery`, and so was `useMailboxByRole()`. Twenty-nine call sites
therefore held twenty-nine **independent** subscriptions to the same rows — at least three in the
triage path alone (`MessageList`, `useShortcutContext`, `useTriage`, the last of which opened five by
itself).

Independent subscriptions resolve on independent ticks. For one Dexie `storagemutated` → re-query →
render cycle, two components can hold **different** mailbox lists and act on them. This was proven
directly rather than inferred: with the reveal layer already re-rendered without Archive, `e` still
dispatched `{kind:'move', to:'archive'}` into the mailbox that had just been deleted.

The window is small — single-digit milliseconds — and it fails **visibly**: the move lands in the
outbox, the server rejects it against a destroyed mailbox, and `use-outbox-problems.ts` surfaces a
dead letter with retry/discard. It is also only reachable when a *concurrent* client mutates the
mailbox list at that instant. What made it worth fixing at the root rather than papering over is that
it is **not shortcut-specific**: any two consumers can disagree, so a guard in any one layer would be
theatre.

Three options were weighed.

1. **A React context holding the list.** Rejected on where it would have to be mounted. The consumers
   are not all under one provider — the folder rail scopes a `ReplicaProvider` per account (M4.4
   Etappe 4) and `useSearch` runs *above* the account scope it feeds — so the context would have to
   sit near the root, where every mailbox write (every unread count!) re-renders the whole shell.
2. **Guard the triage path only.** Cheap, and dishonest: it would close the one path that had been
   demonstrated and leave the mechanism in place everywhere else.
3. **One module-level store per `(db, accountId)`**, read through `useSyncExternalStore`.

## Decision

**Option 3.** `mailbox-store.ts` owns one Dexie `liveQuery` per account, ref-counted by its
consumers and torn down when the last one unmounts. `useMailboxes` / `useMailboxesFor` read it, and
`useMailboxByRole` / `useMailboxByRoleOptional` are now a `find` over the same snapshot instead of a
query of their own.

It is keyed by the database **object** (a `WeakMap`), not by its name: the suite builds a fresh
`ReplicaDb` per test, and a name key would hand the next test an entry subscribed to a deleted
database.

This is the same module-level-store shape `theme.ts`, `app/shell/layout.ts` and `offline-prefs.ts`
already use, so it introduces no new pattern.

## Consequences

- Two consumers now read one **snapshot**: `useMailboxes()` in two components returns the same array
  object, and a role mailbox is the same row object for a chord and for the button beside it. What
  this does *not* promise is that both render it in the same commit — React decides that. It removes
  the second subscription that could be a tick behind, which is what produced the wrong move.
- `useMailboxByRole` changes its tie-break: it was `.first()` on the `[accountId+role]` index and is
  now the first match in tree order. For any well-formed account these are the same row (RFC 8621 §2
  gives a role to at most one mailbox per account); they can differ only on a malformed account that
  carries a role twice, and there the tree order is at least the order the reader sees.
- Fewer live queries is a real cost saving on a large account, but it was **not** the reason and
  should not be cited as one.
- **It removed an accident another component depended on.** `useActionOverflow` measured its unit
  from the overflow trigger alone, which is only rendered when something is already hidden — a fixed
  point: no trigger, no unit, "everything fits", still no trigger. The bulk bar used to escape it by
  luck, because its role mailboxes arrived on separate ticks and the action count grew past a
  `visible` initialised smaller, rendering the trigger for one commit. With one subscription the bar
  mounts at its final count and the trigger never appears, so the bar drew six controls in a box that
  fits five. The hook now falls back to any button in the row as its unit. **The lesson generalises:**
  a component that only works because two queries land at different times is relying on something
  nothing guaranteed, and this change is the kind that surfaces those.
- The test hazard the B10 row really tracked is unchanged and still real: an assertion barrier that
  waits on component A proves nothing about component B. `CommandPalette.test.tsx` needed a second
  barrier for exactly this reason once folders stopped resolving on the same tick as labels.
