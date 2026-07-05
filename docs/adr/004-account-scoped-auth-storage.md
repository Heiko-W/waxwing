# 004 — Account-scoped auth storage from day one

- **Status:** accepted
- **Date:** 2026-07-05
- **Deciders:** project owner

## Context

FR-AUTH-07 (Could) ships single sign-in in V1 but requires that **the data layer be
account-scoped from day one so multi-account is additive later**. SP.2's declared scope is
FR-AUTH-01..05, so the auth *feature* is single-account — but the *persistence layer* it
lays down must not bake in a single-account assumption that a second account would later
force us to migrate around.

As first written, the auth persistence was globally keyed: a single IndexedDB database name
(`waxwing-auth`), global secret keys (`oauth.refreshToken`, `basic.credentials`,
`oauth.pkce`, `auth.record`) and a single persisted `AuthRecord`. A second account would
collide on that database name and those keys, so adding multi-account would have required
renaming keys or the database — i.e. a migration, not an additive change. A code review
flagged this as inconsistent with FR-AUTH-07's "from day one" wording.

## Decision

Scope the auth persistence **by database name**, controlled by an injectable account scope
that threads from `AuthController` into `SecretStore`:

- `SecretStore` takes an optional `scope`. The backing database is `waxwing-auth` for the
  default (first) account and `waxwing-auth-<scope>` for a named account. Each database
  carries its **own** non-extractable AES-GCM wrapping key and its own `SecretName` set.
- `AuthController` takes an optional `accountId` and passes it as the store's `scope` when
  it constructs the default store. V1 omits it (single account → base database).

Database-name scoping (over key-prefixing) was chosen because it (a) keeps the existing
`SecretName` constants and the encrypted-at-rest unit tests — which read raw IndexedDB keys
— unchanged, (b) gives each account independent crypto isolation (a separate wrapping key),
and (c) makes per-account logout a single `deleteDatabase(waxwing-auth-<scope>)`.

A second account is therefore **purely additive**: it opens a new, non-colliding database;
account A's data is never touched, renamed, or migrated.

## Consequences

- **No migration debt for multi-account.** When FR-AUTH-07 lands, a per-account
  `SecretStore` + a small account registry (which scopes exist, which is active) is layered
  on top; the storage contract established here does not change.
- **Deferred, additive follow-ups (M1.2 / when FR-AUTH-07 is scheduled):** the account-id
  derivation (issuer + normalized username, or a generated UUID), the account registry, a
  selective per-account `SecretStore.clearScope()`/wipe, and the multi-store orchestration
  in the controller. These are new code, not rewrites.
- **V1 behavior is unchanged.** With no scope the store uses `waxwing-auth` exactly as
  before; `SecretName` values and the full-database logout wipe are untouched.
- The Dexie mail replica (M1.2) will follow the same account-scoping principle for its own
  databases; this ADR fixes the pattern for the auth layer specifically.
