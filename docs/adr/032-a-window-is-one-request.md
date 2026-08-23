# 032 — A window is one request; the sync pass stays one queue

- **Status:** accepted
- **Date:** 2026-08-23
- **Work package:** B55 — one JMAP method call per HTTP request
- **Relates to:** `apps/web/src/sync/engine/engine.ts` (`runDeltaBlock`),
  `apps/web/src/sync/engine/port.ts`
  (`queryEmailsWithEnvelopes`), `apps/web/src/sync/engine/backfill.ts`, RFC 8620 §3.2/§3.7,
  ADR-031, B55

## Context

The owner reported on 2026-08-22: *"immer wenn man auf Nachrichten klickt, dann dauert es häufig
eine weile bis die Synchronisierung abgeschlossen ist."* B54 found and fixed one contributor (a
notification a failed pass swallowed). This ADR is about the other one: the shape of the traffic.

Waxwing sent **one JMAP method call per HTTP request**. JMAP is designed the other way round:
`methodCalls` is an array (RFC 8620 §3.2) and back-references let one request chain `Email/query`
into `Email/get` without a round-trip in between (§3.7).

### Measured, at a latency that exists

On localhost none of this is visible, which is why it never surfaced: transfer time is nil and
fourteen sequential requests look like four hundred milliseconds of nothing much. Measured instead
against the fixture with CDP latency emulation at **50 ms RTT**:

| Path | Requests | Method calls | Sequential depth | Wall clock |
|---|---|---|---|---|
| Cold sign-in → inbox visible | 10 | 10 | 6 | 956 ms |
| **Warm pass → new mail visible** | **15** | **15** | **11** | **820 ms** |

The warm pass is the one the report is about — new mail arriving while the client is open — and
**about 570 ms of its 820 ms is spent waiting for the previous answer.** The chain showed why: the
contacts and calendar legs sat at the *end* of it, behind mail work they do not depend on, and three
`X/changes` → `X/get` pairs each cost two round-trips where one would do.

## Decision

Two changes, both measured before and after.

**1. A window and its envelopes are one request.** `port.queryEmailsWithEnvelopes` issues
`Email/query` and an `Email/get` whose `#ids` back-references the query's `/ids`, so the server
resolves the join. Both backfill paths use it. This is the commonest shape in the client — a window
is always "which ids, then what is in them" — and it is exactly what §3.7 is for.

The window row is still persisted **before** the envelopes. That ordering is load-bearing for
M3.4's prune (a window is what makes its ids un-prunable) and is unaffected: batching changes when
the data *arrives*, not when it is *written*.

**2. A sync pass stays one queue — after trying the alternative and measuring it.**

Mail, contacts and calendar/files share no state key, no table and no ordering requirement, so
running them concurrently is the obvious win. It was implemented, and it worked: a warm pass went
from **15 requests at depth 11 to 13 at depth 8**, a cold sign-in from depth 6 to 5.

**It was then reverted**, because the read suite produced a failure it had not produced in forty CI
runs or fifty local ones: a folder deleted through the UI came back, and stayed. The mechanism is a
race this code already half-acknowledges. A mailbox create/destroy is applied optimistically while
its intent waits in the outbox, and `syncMailboxes` writes the server's ABSOLUTE list — which still
contains the folder — over the top of it. The replay that would make the server agree runs *after*
the whole delta block, so shortening the block simply widens the window in which a delta pass can
revert an optimistic mutation. `reapplyPendingCounts` exists for exactly this hazard on the COUNT
fields; nothing covers creates and destroys.

So the concurrency is not wrong, it is **blocked**: it needs that gap closed first. Restoring it
before then trades a real correctness race for about 150 ms, which is a bad trade in a mail client.
The reasoning is left in a comment at the top of `runDeltaBlock` so the next person to notice the
obvious win finds out what happened when it was taken.

## Consequences

Measured after, same rig — the batching alone:

| Path | Requests before | after | Depth before | after |
|---|---|---|---|---|
| Cold sign-in | 10 | **8** | 6 | **5** |

One round-trip removed from the path that decides how soon a folder paints, on every window the
client opens. Modest, and honest: at 50 ms RTT it is worth about one RTT.

### What is deliberately not done

The mail track still walks `Mailbox/changes` → `Mailbox/get` → `Email/changes` → `Email/get` →
`Email/queryChanges` → `Email/get`. Batching those three pairs — one request each, with two `/get`s
back-referencing `/created` and `/updated` — would remove about three more steps, **≈ 150 ms of the
819 ms a reader waits for new mail to appear.** It is worth doing and it is recorded as the open half
of B55.

It is not done here because it needs a two-path `syncEmails`: the batched first page, then
`drainChanges` for the rest when `hasMoreChanges` is set. That is the function that decides which
mail the reader sees and which notifications fire — the one B54 had just been fixed in, in this same
change — and adding a second code path through it at the end of a long session is how a latency
improvement becomes a correctness bug.

The same judgement produced the revert above. Both halves of what is left are recorded in B55 with
the numbers attached, so the next attempt starts from measurement rather than from the same guess.

### The fakes

`JmapPort` grew a method, so six fake ports in the unit tests grew one too. They get it from
`withBatchedQuery` in `sync/test-utils.ts`, which composes it from the `queryEmails` and
`getEmailEnvelopes` the fake already answers — real batching is one *request*, but what a unit test
controls is the two *answers*, not the transport that carries them. A fake that wants to observe the
batched call itself defines the method and the helper leaves it alone.
