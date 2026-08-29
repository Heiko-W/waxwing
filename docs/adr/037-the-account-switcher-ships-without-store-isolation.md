# 037 — The account switcher ships without the per-account store, and says so

- **Status:** accepted
- **Date:** 2026-08-29
- **Work package:** code review 2026-08-29, finding W-17
- **Relates to:** [ADR-004](004-account-scoped-auth-storage.md) (which this does not yet fulfil),
  `apps/web/src/auth/secret-store.ts`, `apps/web/src/app/services.tsx`,
  `apps/web/src/app/shell/AccountMenu.tsx`, `apps/web/src/auth/controller.ts`

## Context

ADR-004 designed the auth store to be account-scoped from day one: the first account lives in
`waxwing-auth`, any further account in `waxwing-auth-<scope>`, each with its own wrapping key. It
also stated plainly that V1 ships single sign-in and passes no scope.

M5.14 then shipped the multi-account **UI** — a registry of signed-in mailboxes and a switcher in
the account menu — while the scope stayed unwired. `AuthControllerOptions.accountId` exists and is
honoured; the one production construction site (`services.tsx`) never sets it. Three consequences,
none of them documented until this review:

1. **`logout()` wipes the shared store**, and switching accounts calls `signOut()`. So every switch
   forces a full re-authentication, which is the opposite of what FR-AUTH-07 promises, and the
   switcher lists accounts there is nothing to switch back to.
2. **The code said the opposite.** The comment in `AccountMenu.tsx` read "the other account's
   credentials live in its own store (ADR-004), and this account's survive for switching back".
   Both halves were false, and a comment that describes a hole as closed is worse than no comment:
   it is the reason nobody looked.
3. **A cross-tab credential path.** Tab 1 is signed in to server X and holds its OAuth config in
   memory. The same profile signs in to server Y in tab 2, overwriting the shared refresh token.
   An hour later tab 1's silent refresh reads Y's token out of the shared store and POSTs it to
   X's token endpoint. No XSS is involved; the shared store is enough.

## Decision

Wiring the scope through is the right fix and is not a small one: the scope is derived from
(issuer, username), and the username is not known until AFTER the OAuth exchange — which needs the
store the scope is supposed to select. Doing it properly means a two-phase store or a migration
step, and that is account work, not review work.

So, for now:

- **Point (3) is fixed on its own**, because it is a credential disclosure and does not depend on
  the isolation. `doRefresh` reads the persisted `AuthRecord` and refuses to send a refresh token
  whose record names a different issuer than the config it is refreshing against. The check costs
  one store read on a path that is already doing IO.
- **Points (1) and (2) are made honest rather than fixed.** The comment now says what the code
  does. The menu labels say "Sign in as …" and "Sign in to another account" instead of "Switch
  to …" and "Add another account", because a fresh sign-in is what happens.

## Consequences

- FR-AUTH-07's "fast switching" is not delivered, and the UI no longer implies it is. A user with
  two mailboxes re-authenticates on every switch — the same as before, now without the surprise.
- The registry keeps its value: it remembers which mailboxes exist on this browser and pre-fills
  the sign-in. It holds no secret (see `registry-store.ts`), and public-computer sessions are kept
  out of it entirely (W-05).
- When the scope IS wired, the issuer check added here becomes redundant but stays correct — it
  asserts an invariant that per-account stores would enforce structurally.
- The honest labels are the thing to revisit first when that work starts; they are the visible half
  of this ADR.
