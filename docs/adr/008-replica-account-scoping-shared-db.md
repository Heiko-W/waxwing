# 008 — Replica account-scoping: one shared database with `[accountId+id]` keys

- **Status:** accepted
- **Date:** 2026-07-10
- **Deciders:** M1.2 implementer. Reconciles the implementation-plan M1.2 table spec (which keys
  every table `[accountId+id]` and lists an `accounts` registry) with ADR-004, whose closing note
  says "the Dexie mail replica (M1.2) will follow the same account-scoping principle for its own
  databases" — read literally, a *database per account*. This ADR records which reading wins and
  why. Not a deviation from the spec/tech-stack; a choice the plan constrained and ADR-004 gestured
  at without deciding.

## Context

M1.2 builds the local replica (`apps/web/src/sync/`): the Dexie/IndexedDB store the UI reads from
via liveQuery. It must be **account-scoped from day one** (FR-AUTH-07: "the data layer must be
account-scoped so multi-account is additive later"), even though V1 ships a single sign-in.

Two scoping shapes were available, mirroring the tension between the two source documents:

1. **One shared database, compound `[accountId+id]` keys** — the implementation-plan M1.2 spec:
   ten tables, each carrying `accountId`, plus an `accounts` registry table.
2. **One database per account** (`waxwing-replica-<accountId>`) — the shape ADR-004 chose for the
   auth `SecretStore`, where per-account logout is a single `deleteDatabase`.

ADR-004's rationale for per-account databases was **crypto isolation**: each account's secrets are
wrapped by that database's own non-extractable AES-GCM key, so a second account is additive and a
compromise is contained. That rationale is load-bearing *for secrets*.

## Decision

**Use one shared `waxwing-replica` database with compound `[accountId+id]` primary keys** (option 1,
the plan's spec). The `accounts` table is the registry, keyed by the bare account id (it *is* the
scope). Every other table carries `accountId` and a secondary `accountId` index; email
folder/keyword membership is indexed by account-scoped composite values (`"<accountId>\0<value>"`)
so a query never crosses accounts. Per-account eviction is a scoped bulk delete (`clearAccount`);
the full FR-AUTH-05 wipe is `wipeReplica` (`db.delete()`).

The deciding difference from ADR-004: **the replica holds no secrets.** It is a rebuildable cache of
server-side mail state (envelopes, bodies, query windows). ADR-004's crypto-isolation argument for
separate databases therefore does not transfer. What the replica *does* want — a single `accounts`
registry, and the option of cross-account views later (unified search, an all-inboxes list) — is
served naturally by a shared database and would be awkward across N separate ones. Account tokens
and credentials remain in the per-account, encrypted auth store (ADR-004, NFR-SEC-02); that boundary
is unchanged.

## Consequences

- **+** Matches the plan's explicit table spec; the `accounts` registry has an obvious home; a
  second account is additive (new rows, new key prefix — never a migration), satisfying FR-AUTH-07.
- **+** Cross-account features (unified search/list) stay open without a schema change.
- **+** One Dexie connection and one liveQuery observation domain — simpler for the M1.3 engine and
  cross-tab reactivity.
- **−** Per-account logout is a scoped bulk delete across ten tables, not a single `deleteDatabase`;
  slightly more code, and it relies on every table having an `accountId` index (it does). Covered by
  a test asserting `clearAccount` removes exactly the target account across every table.
- **−** No storage-level isolation between accounts (a corruption is shared). Acceptable: the
  replica is a rebuildable cache, and the sensitive material is elsewhere (auth store).
- **Deferred, additive (owed to FR-AUTH-07 / ADR-004's follow-up list, not this WP):** the stable
  account-id *derivation* (issuer + normalized username, or a generated UUID) for the account
  switcher — the replica currently scopes on the JMAP `primaryAccounts` mail account id, which is
  all a single connected session needs; and wiring `wipeReplica` into the app's
  "Sign out & remove data" path, which lands with the M1.3 engine that first populates the replica.
- **Revisit** if a future requirement needs hard per-account storage isolation (e.g. per-account
  encryption of cached bodies), at which point a per-account-database variant can be reconsidered —
  the account-scoped keys make that migration mechanical.
