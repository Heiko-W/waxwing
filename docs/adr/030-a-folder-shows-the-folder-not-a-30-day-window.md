# 030 — A folder shows the folder; the cache horizon is not a visibility horizon

- **Status:** accepted
- **Date:** 2026-08-23
- **Work package:** M-13 — mail older than the cache window was unreachable in its folder
- **Relates to:** FR-OFF-02 (the cache window this ADR keeps), FR-LST-01 (the folder list this ADR
  fixes), M1.3 `backfill.ts`, M3.4 `maintenance.ts` (the prune, untouched), ADR-005

## Context

Reported from production on 2026-08-23, with a screenshot: opening a folder of older mail rendered

> "No messages from the last 30 days. Older mail is on the server — this device only keeps the last
> 30 days."

…beside a sidebar listing that folder as a normal folder. The owner's objection was the correct one:
a mail client may keep 30 days *in the local cache*, but a folder the user opens must show what is
in it.

### One constant, two jobs

`offline.cacheDays` (default 30) governed two different things, and only one of them was ever
intended:

1. **What the replica KEEPS** — `maintenance.ts` prunes envelopes past `cacheDays + 7 days` that no
   live window references. This is FR-OFF-02, and it is correct.
2. **What a folder SHOWS** — `backfill.ts`'s `windowFilter` built
   `inMailbox AND receivedAt >= now − cacheDays`, and that filter is what the folder list renders
   from.

Nothing in FR-OFF-02 asks for (2). It describes a *cache*. The second job was an accident of reusing
one filter for both, and it made the app's visible behaviour a function of a storage setting.

### Why "load more" could not rescue it

`loadMore` pages a window by `position` against **the row's own persisted `filter`**. That filter
carried the `after` bound, so every page it requested was bounded by it too. Infinite scroll also
stops at `ids.length >= total`, and `total` was the total *of the windowed query*. There was no
sequence of user actions that reached past the boundary — the mail was reachable only through
search, which never carried the bound.

Measured against the fixture before the fix, a folder seeded with 12 messages all older than 30 days:

| | |
|---|---|
| `Mailbox/get` → `totalEmails` | **12** |
| `Email/query` with the app's own filter | `ids: 0`, **`total: 0`** |
| the same query without the `after` condition | `ids: 12`, `total: 12` |

The server had the mail and answered for it. The client did not ask.

### It had been seen, and read as a fixture problem

`seed-large.mjs` carried a comment explaining that its 100 000-message corpus had to be *compressed*
to 20-second spacing (23 days) so it would fit inside the window — because at the original spacing
the perf suite "reported an empty folder while the server happily answered 100 000". That is this
defect, observed in July, diagnosed as test data being too old, and worked around by making the test
data younger. The fixture was bent around the defect instead of the defect being reported.

`MessageList` had also grown an `outsideWindow` branch whose whole job was to explain the missing
mail to the user, and a test asserting that copy. Both were honest reactions to the symptom.

## Decision

**The folder query carries no date bound.** `windowFilter`/`windowQueryKey` become
`folderFilter`/`folderQueryKey`, and a folder's filter is `AND(inMailbox, notKeyword $snoozed)` —
the whole folder, newest first. `cacheDays` is no longer an input to any query; it keeps job (1) and
loses job (2).

What keeps the first screen cheap is what always did the actual work: **the page limit.** The initial
backfill asks for 50, `loadMore` appends 50 at a time as the list is scrolled, and the virtualizer
renders ~15 rows regardless of window size. The `after` bound never reduced what was transferred.

**The cache policy is untouched.** `maintenance.ts` still prunes envelopes past `cacheDays + grace`
that no live window references, still evicts bodies and blobs by LRU under pressure, and still honours
folder pins. Scrolling deep into an old folder holds those envelopes for as long as that window is
watched, and the ordinary reap (unwatched + 24 h) followed by the prune reclaims them. This is the
correct meaning of "this device keeps the last 30 days": it is about what survives, not about what
you are allowed to look at.

**The `outsideWindow` empty state is deleted**, along with `list.emptyOutsideWindow` in both locales.
"No messages in this folder." is the plain truth again.

### Consequences

- **The query key is now stable indefinitely.** It used to contain a UTC-midnight-floored boundary,
  so every folder window was orphaned at midnight and re-backfilled the next day. That daily
  re-backfill is gone — a small, free improvement to exactly the first-open latency the owner
  complained about separately on 2026-08-22.
- **A message moved into a folder is spliced in correctly regardless of its age.** `windowAcceptsLocally`
  (outbox.ts) refuses to splice a row its window's filter does not accept; with the `after` condition
  gone, an old message moved into the Inbox now lands in the list instead of being dropped until the
  next full reconcile. The `after`/`before` arms of that function stay — search windows still use them.
- **Deep scrolling in an old folder holds more envelopes than before**, bounded by what the user
  actually scrolled through and released by the existing reap + prune. Accepted: the alternative is
  the defect.
- **`Mailbox.unreadEmails` badges are unaffected** — they were never computed locally (outbox.ts
  explains why), so widening the query changes nothing about them.

## Alternatives considered

**A second "history" window per folder, appended to the first.** Keeps the watched window exactly as
it is and adds an append-only `before: <boundary>` query beside it. Rejected: the two id lists only
concatenate correctly under a date sort — under `subject`/`from`/`size` the result is two sorted runs
glued together, which is not a sorted list. It also doubles the per-folder query bookkeeping to
preserve a bound that has no requirement behind it.

**Switching to an unwindowed query only once the window is exhausted.** Same ordering problem, plus a
visible jump as the list swaps sources mid-scroll, plus a second round-trip per folder.

**A "Load older messages" button.** Rejected against FR-LST-01 and the owner's stated goal of an
Apple-Mail-like feel: a folder that hides its own contents behind a button is the same defect with a
control attached.

**Making `cacheDays` user-configurable (B23).** Would let a user raise the ceiling, not remove it,
and leaves the app's visible contents a function of a storage setting. B23 remains open on its own
merits — as a *cache* setting.
