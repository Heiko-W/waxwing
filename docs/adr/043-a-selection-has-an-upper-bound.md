# 043 — A selection has an upper bound, and past it the app says so instead of trying

- **Status:** accepted
- **Date:** 2026-09-04
- **Work package:** §11 post-V1 backlog, *Select-all-in-folder, the rest of FR-LST-04* (R-08 stage 2)
- **Relates to:** `apps/web/src/mail/use-select-all-in-query.ts` (`SELECT_ALL_LIMIT`),
  `apps/web/src/sync/react.tsx` (`useEmailWindow`), `apps/web/src/mail/MessageList.tsx` (the bulk
  bar's own subscription), `apps/web/src/shortcuts/use-shortcut-context.ts` (the second one),
  ADR-042, §13 finding **B10**

## Context

Once "Select all {{total}}" pins ids (ADR-042), the size of a folder becomes the size of something
the tab holds. 300 is nothing. 50 000 is not.

The cost is **not** the paging. 50 000 ids is 100 `Email/query` calls of 500, ids only, and they
scale flat. The cost is what the app does with a selection afterwards: the id-set is read back by two
live `useEmailWindow` subscriptions — the bulk bar's (which hydrates the read/flag toggle labels) and
the shortcut context's (which hydrates the same predicate for the chords, the duplication B10 tracks)
— and each is a `bulkGet` of every selected id, re-run whenever the `emails` table changes.

Measured with `emailsByIds` on fake-indexeddb, which is the pessimistic end (a browser's IndexedDB is
several times faster) and the number available without a browser:

| ids | one `emailsByIds` pass |
| --- | --- |
| 1 000 | 61 ms |
| 5 000 | 288 ms |
| 10 000 | 588 ms |
| 50 000 | 4 010 ms |

It is not paid per message — the optimistic apply of a bulk action is one transaction, so one re-run
— but it is paid on the click that builds the selection and again after each bulk write, twice over.

Three ways out were weighed. **Dedupe the two subscriptions** (B10's own plumbing) halves the number
and changes no order of magnitude. **Page the selection lazily** — hold the ids and hydrate only what
a control needs — is a rewrite of two independent hooks for a case nobody has. **Refuse past a
limit** costs one sentence.

## Decision

`SELECT_ALL_LIMIT = 10_000`. Past it the second step is still DRAWN and still focusable, carrying
`unavailableReason`: *"More than 10000 messages — too many to select in one step."* — the `Button`
rule for a refusal the reader should be told about, as opposed to an action that is structurally
absent and stays hidden.

Ten thousand is where the worst measured pass stays a pause rather than a freeze, and it is past any
folder a person picks a selection out of. Above it the honest statement is that a selection is the
wrong tool: the app's folder-level operations ("Empty Trash", "Empty Junk", "Delete older than…")
already do that work through `Engine.emptyMailbox` / `deleteOlderThan`, which page and chunk the same
query without ever building a selection — which is why the limit can be a plain refusal rather than a
dead end.

The engine enforces the same bound structurally: `collectQueryIds` stops at `max` and returns
`complete: false`, and the caller must not apply what it got. That is the folder that grew past the
limit between the render and the click — applying 10 000 ids under a label that said 10 004 is the
false promise this whole work item exists to remove.

## Consequences

- **A folder between 51 and 10 000 messages selects whole, and that is nearly all of them.** The
  refusal is reachable only in a folder that is already outside what a person triages by hand.
- **The number is a measurement, not a taste**, and it moves when the measurement does. Deduping the
  two subscriptions (B10) or hydrating lazily would each buy a bigger one; until then this file is
  where the number and its evidence live together.
- **The refusal is spoken on the control, and the control stays in the tab order.** `disabled` would
  remove it and put the explanation out of reach of the reader who most needs it (FR-A11Y-01).
- **A failure is not a refusal.** A request that was made and did not arrive leaves the selection
  untouched and raises a toast; the button stays pressable, because trying again is the sensible next
  move. Only a bound the app knows in advance goes on the button.
- **`perf-large.spec.ts`'s 100 000-message folder is now above the limit**, so what it exercises is
  the refusal rather than the selection. Its existing assertions are about the honest window counter
  and virtualization and are unaffected.
