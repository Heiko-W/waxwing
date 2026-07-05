# 002 — Stalwart dev/E2E fixture design

- **Status:** accepted
- **Date:** 2026-07-05
- **Deciders:** project owner, P0.4 implementer

## Context

P0.4 provisions a one-command Stalwart JMAP server for development and E2E. Bringing the
real image up (`stalwartlabs/stalwart:v0.16.11-alpine`) surfaced several facts that diverge
from assumptions baked into the implementation plan and require decisions:

1. **No static accounts.** In Stalwart **v0.16** the config file is JSON (not TOML) and is
   *only a data-store descriptor* — domains, accounts, listeners, auth all live inside the
   store. There is no file-based or CLI `apply` way to declare accounts on boot, and
   `stalwart-cli` is not in the image.
2. **Unauthenticated session is 200, not 401.** The plan's P0.4 smoke test expected an
   unauthenticated `/.well-known/jmap` to return **401**. Stalwart v0.16 instead returns
   **200** with an *anonymous, capabilities-only* session document (empty `accounts` and
   `username`), even when reached over the mapped host port (non-loopback). A **401** is
   returned only for *invalid* credentials.
3. **`test.example` is rejected** as an invalid domain name by Stalwart; reserved-TLD names
   like `waxwing.test` are accepted.
4. **TLS.** Stalwart's default `:443` listener has no certificate on a fresh box; the plan
   left the dev TLS story open (mkcert vs. plain-HTTP exception).

## Decision

- **Fixture shape.** A single-line RocksDB store descriptor at
  `e2e/stalwart/config/config.json`; the container runs `v0.16.11-alpine` with
  `STALWART_PUBLIC_URL=http://localhost:18080` and `STALWART_RECOVERY_ADMIN=admin:<pw>`.
  Data lives on an **ephemeral named volume** (wiped by `down -v`). Both the `dev` baseline
  and the `main` compat target sit behind compose **profiles**.
- **Accounts are provisioned, not static.** `e2e/stalwart/fixture.mjs` creates the test
  domain `waxwing.test` and users `alice`/`bob`/`carol` **idempotently** over the JMAP
  management API (`x:Domain/set`, `x:Account/set`, query-before-create) after boot. One
  shared dev password for all accounts.
- **Plain HTTP on localhost, no TLS.** Adopt the plain-HTTP loopback dev exception rather
  than mkcert. The mapped listener is host `18080` → container `8080`; `:443` is not
  published. Production always runs behind TLS.
- **Smoke test asserts the security-equivalent invariant, not a literal 401.** The P0.4
  smoke check asserts: unauthenticated session → **200 anonymous with no `accounts`/
  `username`** (no data leak); invalid credentials → **401**; valid credentials → **200**
  with `capabilities` + a non-empty `accounts` map. The plan's P0.4 wording is updated to
  match.

## Consequences

- `implementation-plan.md` P0.4 is updated: the smoke-test bullet no longer claims an
  unauthenticated **401**; it states the real invariant. Downstream auth work (**SP.2**)
  must not assume an unauthenticated session 401s — the JMAP client always sends
  credentials and reads the authenticated session.
- Provisioning depends on a running server + the `urn:stalwart:jmap` management capability.
  It is Stalwart-specific (the app itself stays server-agnostic); if the compat `main`
  image changes the registry schema, the scheduled P0.5 job surfaces it (non-blocking).
- Test domain is `waxwing.test`, not `test.example`, everywhere accounts are referenced.
- Because the fixture is plain-HTTP and loopback-only, cross-origin/CORS and TLS behaviours
  are **out of scope here** and validated separately in the spike (SP.5).
- If `:v0.16.11-alpine` ever misbehaves, fall back to non-alpine `:v0.16.11` (verified to
  boot identically) and note it in the fixture README.
