# 041 — The JMAP session document is persisted, and it lives with the credentials rather than in the replica

- **Status:** accepted
- **Date:** 2026-09-04
- **Deciders:** the project owner, on the post-V1 backlog release of 2026-09-04
- **Work package:** the offline cold start — `docs/implementation-plan.md` §11, code review
  2026-09-01 finding R-78, FR-OFF-01
- **Relates to:** `apps/web/src/auth/secret-store.ts` (`SecretName.JmapSession`),
  `apps/web/src/auth/controller.ts` (`rememberJmapSession` / `recallJmapSession`),
  `apps/web/src/app/session/SessionProvider.tsx` (`restoreOfflineSession`),
  `packages/jmap/src/session.ts` (`sessionFromStore`),
  [ADR-004](004-account-scoped-auth-storage.md) (the per-account encrypted store this joins),
  [ADR-008](008-replica-account-scoping-shared-db.md) (the replica it deliberately does
  not join)

## Context

FR-OFF-01 is a Must and reads: *"The app shell loads offline (service worker precache); opening
the installed app without network shows cached mail, clearly marked offline."* Since M3.5 the app
delivered the first half and stopped exactly one step short of the second.

Opened offline, the installed PWA booted its shell out of the precache. `AuthController.restore()`
then succeeded — it only reads the encrypted store in IndexedDB, so it works with no network at
all, exactly as its doc-comment claims. But `SessionProvider.boot()` fed the restored session
straight into `connectSession()`, which calls `connect()` and **fetches the JMAP Session document
over the network**. `jmapSession` was held in memory and persisted nowhere. Offline that fetch
threw, the boot's outer catch turned it into `goToLogin(…)`, and the reader was left looking at the
sign-in form reading *"Could not reach the server"* — a form that cannot be submitted offline, in
front of a fully populated replica they could not reach.

This was known and deliberately pinned. `e2e/tests/pwa.spec.ts` asserted `toBeHidden()` on the
cached mail as a tripwire, and its block comment named the defect correctly. R-78 filed it as a
tracking entry so the Must did not live only in a test comment. The owner released it for
implementation on 2026-09-04, having been told first what the Session document contains
(`packages/jmap/src/types/core.ts`: the username, the accounts with their names, the four URLs,
the capability list, and the opaque `state`) and that no token and no mail content joins it.

So the shape of the decision was fixed before the work started: **persist the Session document.**
What was open is *where*, and that turns out to be the load-bearing question.

## Decision

**The JMAP Session document is written to the encrypted credential store (`waxwing-auth`), beside
the `AuthRecord`, and it is persisted if and only if that record is.**

Three rules follow, and each is enforced in one place:

1. **`rememberJmapSession` writes nothing when there is no `AuthRecord`.** No record means no
   `restore()` on the next cold start, which means nothing could ever read the document back —
   and an unreadable document is a username and a server left on a disk for no reason. Basic
   without "stay signed in" and public-computer OAuth both persist no record, so both keep
   persisting nothing. That is not a special case bolted on; it is the same predicate.
2. **Every path that establishes a new identity deletes the old document**, on the same lines that
   write the new `AuthRecord` — `startBasicLogin` (both branches) and `completeRedirect`.
3. **`logout()` destroys it with everything else**, because `SecretStore.wipe()` is a
   `deleteDatabase`. Plain *Sign out* and *Sign out & remove data* therefore behave identically
   here, with no second code path to keep in step.

**Reading it back re-validates it as if it had just been fetched.** `sessionFromStore` in
`@waxwing/jmap` re-runs both of `getSession`'s checks — the shape check and the origin check on
the four URLs — against the connect URL the app is booting to. `SessionProvider` additionally
requires that the recorded `connectUrl` is the one this boot is for.

**The offline path is entered only on a `TypeError` while `navigator.onLine` is false**, and the
resulting `ConnectedSession` carries `offline: true` until a full reconnect replaces it.

## Why not the replica, which is what R-78 and the plan entry both sketched

The plan entry says "write the session document into the **encrypted replica**". Two things about
that sentence turned out to be wrong, and the second is the reason for the deviation.

**The replica is not encrypted.** `sync/db.ts` says so in its own header — it is "a non-sensitive
cache", and `sync/ephemeral.ts` states plainly that "IndexedDB is **not encrypted**". Only the
auth store is (AES-GCM under a non-extractable key, ADR-004). So the store this ADR chooses is the
one the plan text described; the replica is the one it pointed at. That is a tie-breaker, not the
argument.

**The argument is lifetime.** The document is only ever usable together with the credentials
`restore()` returns, and the replica's lifetime is not the credentials' lifetime in three separate
ways:

- **It survives a plain sign-out.** That is deliberate and documented (SECURITY.md §3: signing back
  in should not re-download a month of mail). A document there would have to be deleted by hand in
  `endSession`, in a teardown that already races a five-second budget.
- **It is shared across accounts by design** (ADR-008: one database, account-scoped rows). The
  Session document is what *decides* the account id, so it has no `accountId` to be scoped by — it
  would need a sentinel key or a table scan, and neither says what it means.
- **It is written whether or not anything about the session is meant to be restorable.** The
  conditional would have to be re-derived at the write site, from `basicStayRef` and the ephemeral
  flag, rather than read off the one record that already answers the question.

Add them up and the invariant *"the stored document belongs to the stored credentials"* becomes
something maintained by hand at five call sites, in a component that is already the most heavily
commented file in the app. In the credential store it is structural: same database, same wipe, and
the two deletions sit on the same lines as the `AuthRecord` writes, where the next person changing
the sign-in flow cannot miss them.

The cost is honest and worth stating: **a non-secret now lives in a store whose header says
"secrets".** The header says so explicitly, and this ADR is why.

**Not the service-worker cache, at all.** `sw-routes.ts`'s central invariant is that the worker
caches zero bytes from JMAP, and the Session document is served from a JMAP path. That invariant is
enforced by `check:dist` and proven by a live E2E; nothing here touches it.

## Why the reconnect is a whole connect, not `refreshSession()`

R-78's sketch says "`refreshSession()` on reconnect". That would swap the document inside the
client and leave `connected.accounts` and `connected.delegated` exactly as stale as they were —
and those two lists are what the sidebar and the engine fleet actually read. So the `online` event
re-runs `connectSession` in full: it re-fetches, re-probes the shares (S-4), re-derives both lists,
rewrites the stored document, and answers "this account is gone" the way a fresh sign-in does. The
fleet is already built to be torn down and rebuilt on a new `connected` object; this is the same
lifecycle a re-auth uses.

Offline, the share probe cannot run, so `deriveDelegation` receives an empty verdict map. That is
not a shortcut: `sharing/probe.ts` already specifies an absent verdict as "granted everywhere",
precisely because a rail that empties itself when the network drops is worse than one showing a
section that turns out to be empty.

## Why the browser has to agree that it is offline

`isOfflineFailure` requires **both** a `TypeError` — a failed `fetch`, the only shape a request
that got no answer at all can take here — **and** `navigator.onLine === false`.

The wide reading was considered and rejected. With the device claiming a connection and the connect
still failing (a captive portal, a server that is down, a host that has moved), the honest answer is
the one the app already gives: *"Could not reach {{host}}"*, on a form where the server is editable.
That is a fault the reader can act on. Opening a read-only replica instead would hide a fixable
problem behind a working-looking app — and no `online` event would ever arrive to end that state,
because the browser never thought it was offline.

`navigator.onLine` is a floor rather than a guarantee: it can claim "online" wrongly, which is the
case this excludes, and it does not claim "offline" wrongly.

## Consequences

- **FR-OFF-01 is met in full.** An installed app opened with no network shows the mailbox it
  already holds, marked "Offline" by the same chip a live session raises when the connection drops.
  No second vocabulary was invented for the state, and no new user-visible string was added.
- **What is persisted grew by one document**, and this is the record of it: username, accounts with
  their names, the four URLs, capabilities, `state`. No token, no mail, no address book. It is
  encrypted at rest for the same reason everything else in that database is, and it goes with the
  credentials on either sign-out.
- **The E2E tripwire is spent.** `e2e/tests/pwa.spec.ts` asserted the old limit deliberately so
  that closing it would go red. It did, and it is now the offline cold-start test M3.5 originally
  asked for, plus a counter-test that a sign-in without "stay signed in" still lands on onboarding.
- **Multi-account is unaffected, and that is because there is only ever one session.** The switcher
  (M5.14, ADR-037) ends the current session and asks for a fresh sign-in, so exactly one document
  exists at a time and it belongs to the account whose credentials are in the store. Switching
  offline is not possible and was not possible before: it needs a sign-in, which needs a server.
  When W-17 lands the per-account store, this document is scoped by it for free — it is a
  `SecretName` in a `SecretStore` that already takes a scope.
- **A stale document cannot mislead for long, and cannot mislead at all about identity.** Its
  `state` is refreshed by the reconnect; an account that has disappeared is answered by the same
  `NoAccountError` a fresh connect gives. And a document whose URLs no longer sit on the connect
  URL's origin is refused outright rather than trusted, which is what keeps the `Authorization`
  header on the configured host.
- **Devices that signed in before this shipped have credentials and no document**, and get the
  sign-in form offline exactly as they did. The first successful connect fixes that silently.
