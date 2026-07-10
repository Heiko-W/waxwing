# Stalwart JMAP dev / E2E fixture

A one-command, local-only [Stalwart](https://stalw.art) JMAP server for development and
Playwright E2E (work package **P0.4**). It gives any contributor a working mail server with
known test accounts, over plain HTTP on `localhost`.

> **Dev only — never expose this.** No TLS, a well-known admin password, world-known
> account passwords, and data on an ephemeral volume. It is deliberately insecure so it is
> zero-friction locally.

## Quick start

From the repo root:

```sh
pnpm e2e:server        # compose up -> wait ready -> provision accounts -> smoke check
pnpm e2e:server:down   # stop + remove containers AND the ephemeral data volume
```

`pnpm e2e:server` is idempotent and self-verifying: it brings the container up, polls
`/.well-known/jmap` until the server answers, (re)provisions the domain and accounts, and
runs the smoke check before returning. Re-running it against an already-up server just
re-checks everything.

Requires Docker (`docker` + `docker compose`). No other local dependencies — the control
script (`fixture.mjs`) uses only Node ≥ 22 built-ins.

## Test accounts

The baseline is **Stalwart v0.16.x** (NFR-COMPAT-02). In v0.16 the config file is only a
data-store descriptor — domains and accounts live inside the store — so accounts cannot be
declared statically. `fixture.mjs provision` creates them idempotently over Stalwart's JMAP
management API (`x:Domain/set`, `x:Account/set`) after the server is up.

Everything shares one dev password: **`waxwing-e2e-Pw1!`**

| Login | Role | Password |
|---|---|---|
| `admin` | master admin (via `STALWART_RECOVERY_ADMIN`, HTTP Basic) | `waxwing-e2e-Pw1!` |
| `alice@waxwing.test` | test user | `waxwing-e2e-Pw1!` |
| `bob@waxwing.test` | test user | `waxwing-e2e-Pw1!` |
| `carol@waxwing.test` | test user | `waxwing-e2e-Pw1!` |

Domain: **`waxwing.test`** (the RFC 6761 reserved `.test` TLD — never resolves publicly).
Note: Stalwart rejects `test.example`, so `waxwing.test` is used instead (see `docs/adr/002`).

## Ports

Only the plain-HTTP JMAP listener is mapped:

| Host | Container | Purpose |
|---|---|---|
| `18080` | `8080` | plain-HTTP JMAP / web / OAuth2·OIDC / `.well-known` / `healthz` |

`18080` avoids clashes with the app dev server and needs no root (unlike `:443`). Stalwart
seeds other default listeners internally (25/465/993/995/4190/443), but they are **not**
published — this fixture is JMAP-only. Map more in `docker-compose.yml` if you need
IMAP/SMTP later.

Key URLs once up:

- Session: `http://localhost:18080/.well-known/jmap` → 307 → `/jmap/session`
- OIDC discovery: `http://localhost:18080/.well-known/openid-configuration`
- Liveness / readiness: `http://localhost:18080/healthz/live` · `/healthz/ready`

OAuth 2.0 / OIDC is enabled by default with no configuration (Authorization Code + PKCE,
refresh, device code); the issuer and endpoints are advertised as `http://localhost:18080`
because the container sets `STALWART_PUBLIC_URL` to the host-visible URL.

## TLS choice: plain HTTP on localhost

This fixture serves **plain HTTP** (no TLS). Stalwart's default `:443` listener has no
certificate on a fresh box, and provisioning real certs (mkcert) for an ephemeral,
loopback-only test server buys nothing but friction. Plain HTTP on `localhost` is the
documented dev exception; production deployments always run behind TLS. See `docs/adr/002`.

## Smoke check (P0.4 Done-when)

`fixture.mjs smoke` (run automatically by `up`) asserts the server is a real,
auth-enforcing JMAP endpoint:

1. **Unauthenticated** `/.well-known/jmap` → **200** with an *anonymous, capabilities-only*
   session (empty `accounts`/`username`). Stalwart v0.16 does **not** return 401 here; the
   invariant we assert is that **no account data leaks** without credentials. (This differs
   from the original plan wording — see `docs/adr/002`.)
2. **Invalid** Basic credentials → **401** (authentication is enforced).
3. **Valid** Basic credentials for a test account → **200** with a parseable session
   document that has `capabilities` **and** a non-empty `accounts` map.

A richer, fixture-backed Playwright suite (real login, mailbox listing, send/receive) lands
with **M1.9**; it will reuse `fixture.mjs` (its `up`/`provision`/constants are exported) as
a global setup instead of the current self-contained placeholder `webServer`.

## SP.4 raw demo (`pnpm demo`)

`scripts/demo.mjs` reuses this fixture (its `up`/`down`/`ACCOUNTS` exports) to power the
dev-only raw end-to-end demo — see the root README's "Raw end-to-end demo" section. Two
fixture-side hooks make the browser demo work:

- **`STALWART_PUBLIC_URL` is overridable** — `docker-compose.yml` now reads
  `${STALWART_PUBLIC_URL:-http://localhost:18080}`. Stalwart bakes this exact origin into the
  **absolute** session URLs (`apiUrl`, `download`/`upload`/`eventSource`) and every OAuth/OIDC
  endpoint, and it ignores `Host`/`X-Forwarded-*`. `pnpm demo` sets it to the *browser's*
  origin (e.g. `http://localhost:5173`) so a same-origin Vite proxy is all that's needed — no
  CORS, no cross-origin loopback. `pnpm e2e:server` and the integration tests leave it unset,
  so their behaviour is unchanged (default `http://localhost:18080`).
- **`seed-demo.mjs`** idempotently seeds alice's inbox with 25 deterministic demo mails (a
  plain-text mail, an HTML mail with a `<script>` + remote `<img>`, a `message/rfc822`
  attachment for `Email/parse`, and filler for paging). Every seeded mail carries the `wdemo`
  keyword; a reseed destroys the previous batch first. Run standalone against a running
  fixture with `node e2e/stalwart/seed-demo.mjs`.

## Compatibility profile (`main`)

`docker-compose.yml` defines two variants behind compose **profiles** so a bare
`docker compose up` starts nothing by accident:

- **`dev`** — pinned `stalwartlabs/stalwart:v0.16.11-alpine`, the tested baseline. This is
  what `pnpm e2e:server` runs.
- **`main`** — `stalwartlabs/stalwart:latest`, for the scheduled, **non-blocking** compat
  job wired in **P0.5**. It never runs by default. Both share host port `18080`, so run
  only one at a time.

```sh
# compat target (P0.5 will automate this; runs the same provision + smoke):
node e2e/stalwart/fixture.mjs up main
node e2e/stalwart/fixture.mjs down     # tears down whichever profile is running
```

## Files

| Path | What |
|---|---|
| `docker-compose.yml` | pinned image, port map, healthcheck, ephemeral volumes, `dev`/`main` profiles |
| `config/config.json` | the RocksDB data-store descriptor (the only file-based config v0.16 supports) |
| `fixture.mjs` | control script: `up` / `down` / `provision` / `smoke` / `status` |

## Troubleshooting

- **Alpine image issues** — swap `:v0.16.11-alpine` for the non-alpine `:v0.16.11` in
  `docker-compose.yml` (both were verified to boot identically) and note it here.
- **Port 18080 in use** — something else holds the port; free it or change the host port in
  **all three** places, which must stay in sync: the `ports:` mapping **and**
  `STALWART_PUBLIC_URL` in `docker-compose.yml`, plus `HOST_PORT` in `fixture.mjs`. Missing
  `STALWART_PUBLIC_URL` is silent: the smoke check still passes, but the session/OIDC
  documents keep advertising endpoints on the old port and the browser breaks.
- **Stale state** — `pnpm e2e:server:down` wipes the data volume; the next `up` starts
  fresh. Inspect with `node e2e/stalwart/fixture.mjs status` or
  `docker logs waxwing-stalwart-dev`.
