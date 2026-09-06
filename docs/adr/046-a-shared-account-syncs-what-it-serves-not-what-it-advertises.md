# 046 — A shared account syncs what it serves, not what it advertises

- **Status:** accepted
- **Date:** 2026-09-05
- **Work package:** S-4 — delegated calendars and address books in their rails (PR #68 by
  Sam Sequi, completed here)
- **Relates to:** `apps/web/src/sync/engine/fleet.ts` (`FleetAccount.syncMail`),
  `apps/web/src/sync/engine/engine.ts` (`runDeltaBlock`),
  `apps/web/src/sync/engine/react.tsx` (`fleetAccounts`),
  `apps/web/src/app/session/accounts.ts` (`delegatedPimAccounts`), ADR-018, ADR-020, ADR-032,
  `docs/jmap-gap-2026-08-21/README.md` §S-4

## Context

S-4's brief is that a shared calendar or address book "erscheint zwar in der Session, ist im Client
aber nicht erreichbar". PR #68 built the rails for it: an account section in the contacts rail, an
account nav in the calendar rail, and `?account=` routes so a delegated book opens in ITS account
rather than the same-id book in the reader's own (the ADR-018 collision).

The rails were right and they drew nothing. Measured in the browser against the fixture, with
carol's address book shared to alice and nothing else:

| what | after 2 s | after 30 s |
| --- | --- | --- |
| the account section | rendered | rendered |
| books inside it | "No address books." | "No address books." |
| carol's calendar, opened from the share card | spinner | spinner |

…while the same session, asked directly, got the data:

```
AddressBook/get  200 list=1 ["Stalwart Address Book (carol@waxwing.test)"]
Calendar/get     200 list=1 ["Stalwart Calendar (carol@waxwing.test)"]
Mailbox/get      200 ERROR {"type":"forbidden","description":"You do not have access to account d"}
```

Two rules met and left a gap between them:

1. **The client reads PIM data out of the replica.** Contacts since M4.2, the calendar since K-8 —
   K-8 replaced a live per-visit fetch precisely so a train or a flaky hotel network stops emptying
   a month the device already had.
2. **Only a mail account gets an engine,** and only an engine writes the replica. `fleetAccounts`
   read `connected.accounts`, which `deriveDelegation` narrows to accounts that answered
   `Mailbox/get` — deliberately, because a capability list cannot tell the areas apart (see
   `app/session/delegation.test.ts`, and the note that a share of one object advertises all
   seventeen capabilities).

An account that shares only its address book satisfies neither: it has no engine, so its rows never
arrive, so a rail reading the replica shows an empty section for ever. Starting a normal engine for
it does not help either — the mail legs OPEN `runDeltaBlock`, so the `forbidden` above throws before
the contacts leg, `runSyncPass` catches it as an ordinary `deltaError`, and the retry fails
identically. Every pass, for ever.

### The second cause, which is not S-4's

The rails stayed empty for delegated accounts that DO serve mail too, and for a different reason.
With carol's inbox shared read-only — the fixture's own delegation setup — she is a mail account by
every test the client has, gets a full engine, and her mail syncs. Her books still never arrived.
Measured over 15 s of live traffic:

```
Mailbox/get@d      -> Mailbox/get
Identity/get@d     -> ERROR:forbidden
Mailbox/changes@d  -> Mailbox/changes
Identity/get@d     -> ERROR:forbidden          (and so on, four times in fifteen seconds)
AddressBook/get@d  -> called ONCE, by the delegation probe, and never by a sync
```

`Identity/get` on a delegated account is refused, which is not a malfunction: ADR-020 already
records that send-as from a delegated account is refused by the server, so there are no identities
to hand out. But `syncIdentities` sat unguarded in the MIDDLE of the mail leg, so the refusal threw
out of the delta block and the pass ended in `error` before the contacts, calendar and files legs —
every pass, for ever, on every delegated mailbox. The account's mail worked, because the legs above
it had already run, so nothing about the symptom pointed at identities.

This predates S-4 and would outlive it. It is fixed here because it is the other half of the same
empty rail.

## Decision

**An engine is started for every delegated account that serves SOMETHING, it runs only the legs its
account actually serves, and a leg the server permanently refuses costs that leg and nothing
more.** `FleetAccount.syncMail` is `false` for an account whose `mail` area the probe found
`denied` while `contacts` or `calendar` is served; `runDeltaBlock` skips the mail block wholesale
under that flag.

Four consequences worth stating, because each is a rule this codebase held until now:

- **"One engine per MAIL account" becomes "one engine per served account."** The fleet's other
  invariants are untouched: a non-primary engine still holds `${SYNC_LOCK}:${id}`, a no-op bus and a
  discarding status sink, so a background account still cannot flicker the primary's badge.
- **An account that serves nothing gets nothing.** All four areas `denied` is a session entry and
  not a reason to hold a leader lock, open a push subscription and retry four `forbidden`s.
- **A permanently refused leg is isolated, not fatal.** `syncIdentities` now joins the calendar leg
  in being guarded: a `forbidden` marks it done (retrying it every sweep would be one pointless
  round-trip per shared account for ever), anything else still propagates so an offline or transient
  failure retries. Auth expiry propagates from both, so the re-auth funnel is unaffected.
- **A contacts-only share now counts as "the server shares something",** so the primary joins the
  push mux instead of opening its own SSE channel. The byte-for-byte single-account invariant is
  unchanged in the case it was written for — nothing shared — but a shared address book is now on
  the shared side of that line, where a shared mailbox already was.

The alternative — a live fetch when no engine exists — was rejected: it reintroduces exactly what
K-8 removed, and it would make a delegated calendar the one surface in the app that goes blank
offline.

## Consequences

The rails fill. Measured after the change, same fixture, same share: carol's book appears in her
section and her event appears in her calendar, from the replica, and therefore also on the second
visit with the network off.

`app/session/delegation.test.ts` changed one assertion and this is the one to read twice. It said
"AND NO SYNC ENGINE STARTS FOR IT", which was right while an engine meant mail. It now says **no
MAIL sync runs for it** — `fleetAccounts` lists the account with `syncMail: false` — and the
original hazard it was written for is still pinned, both there and in `engine.pim.test.ts`, whose
second test is the mutation probe: drop the flag and the account syncs nothing at all, which is
what shipped.

What this does NOT do is make a delegated account writable. #68 withholds creating, renaming,
deleting and importing while the screen visits one, and that stands: the engine now exists, but
whether the server accepts a write depends on `myRights` per object, and offering an action that
can only fail is worse than not offering it. That is its own work package.
