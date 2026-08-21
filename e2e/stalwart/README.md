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

## Upgrading the pinned image — recreate the volume, or defaults go missing

> **After changing the pinned image tag in `docker-compose.yml`, tear the fixture down with
> `pnpm e2e:server:down` before the next `pnpm e2e:server`.** Otherwise the new binary boots
> against the registry the *old* version populated, and **server-generated defaults are not
> regenerated**.

This is not hypothetical bookkeeping. Stalwart seeds its defaults **only into a virgin registry**
— the whole block in `crates/common/src/manager/defaults.rs` is nested inside
`if count_object(OidcProvider) == 0`. Anything it would create on first boot is therefore created
**once, by whichever version got there first**, and never again.

The concrete case that bit us: v0.16.14 auto-generates the **RFC 9749 Web-Push VAPID keypair** at
that step. Bump the tag from v0.16.11, run `pnpm e2e:server` without a prior `down`, and the server
is v0.16.14 but advertises **no** `urn:ietf:params:jmap:webpush-vapid` — because the registry is
not virgin. `e2e/tests/settings.spec.ts` fails on its premise, and the pin is entirely innocent.

`up()` deliberately does **not** wipe the volume for you: that would destroy seeded state (demo
mail, mailboxes, anything you were mid-way through) without asking. `down` is the explicit,
data-losing step, and it stays explicit. `up` warns when it notices the data volume is older than
the image it is running (see “Troubleshooting”), but a warning is all it can safely do.

```sh
# after editing the `image:` tag in docker-compose.yml
pnpm e2e:server:down   # removes containers AND the data volume
pnpm e2e:server        # fresh registry -> defaults regenerated
```

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

### Delegated (shared) mailboxes — opt-in (M4.4)

`provision()` leaves the three accounts **standalone**. The shared-account suite calls
`ensureDelegations()` itself and `revokeDelegations()` in its teardown:

| Owner | Grantee | Mailbox | Access |
|---|---|---|---|
| `bob@waxwing.test` | `alice@waxwing.test` | Inbox | read-write (`mayReadItems`, `mayAddItems`, `mayRemoveItems`, `maySetSeen`, `maySetKeywords`) |
| `carol@waxwing.test` | `alice@waxwing.test` | Inbox | read-only (`mayReadItems` only) |

**Why it is not part of `provision()`.** A share changes what alice's UI *is*: the sidebar switches
from one folder tree to account-grouped sections, which makes the plain `treeitem name=/Inbox/`
locator that 19 call sites across 8 suites use ambiguous. Measured, not assumed — enabling it in
`provision()` failed the entire read suite. It would also leave the single-account path (Waxwing's
documented byte-for-byte invariant) with no end-to-end coverage at all.

**`up` does not wipe the volume**, so a share left behind by an interrupted run persists and would
silently reshape every later suite. `smoke()` therefore asserts the single-account default and fails
with that explanation.

How it works, established against the live fixture rather than assumed:

- Sharing is `Mailbox/set` + `shareWith` (`urn:ietf:params:jmap:mail:share`, which Stalwart
  advertises per account), keyed by the grantee's **principal** id from `Principal/get`.
- The **grantor** performs it — the recovery admin cannot share on a user's behalf.
- The grantee then sees the account in `/.well-known/jmap` with `isPersonal: false` and
  `urn:ietf:params:jmap:mail` in that account's own `accountCapabilities` (what
  `packages/jmap/src/session.ts` filters on), and sees **only the shared mailbox**, not the tree.
- **`Account.isReadOnly` stays `false` even for a read-only share** — the truth is each mailbox's
  `myRights`, so the account flag is not a usable permission signal (see defect B34).
- Writes beyond the grant are rejected server-side **per id**:
  `notUpdated[id] = { type: 'forbidden', description: … }`, never wholesale.

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

- **`dev`** — pinned `stalwartlabs/stalwart:v0.16.18-alpine`, the tested baseline. This is
  what `pnpm e2e:server` runs. **Changing this tag requires a `pnpm e2e:server:down` before the
  next `up`** — see “Upgrading the pinned image” above.
- **`main`** — `stalwartlabs/stalwart:latest`, intended for a scheduled, **non-blocking** compat
  job. That job does not exist: no workflow carries a `schedule:` trigger. The profile is run by
  hand (`pnpm e2e:server:main`). Compat
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

- **Alpine image issues** — swap `:v0.16.18-alpine` for the non-alpine `:v0.16.18` in
  `docker-compose.yml` (both were verified to boot identically) and note it here.
- **Port 18080 in use** — something else holds the port; free it or change the host port in
  **all three** places, which must stay in sync: the `ports:` mapping **and**
  `STALWART_PUBLIC_URL` in `docker-compose.yml`, plus `HOST_PORT` in `fixture.mjs`. Missing
  `STALWART_PUBLIC_URL` is silent: the smoke check still passes, but the session/OIDC
  documents keep advertising endpoints on the old port and the browser breaks.
- **Stale state** — `pnpm e2e:server:down` wipes the data volume; the next `up` starts
  fresh. Inspect with `node e2e/stalwart/fixture.mjs status` or
  `docker logs waxwing-stalwart-dev`.
- **“data volume predates the image” warning, or a capability the pinned version should have is
  missing** — the registry was populated by an older Stalwart and its first-boot defaults were
  never regenerated. `pnpm e2e:server:down`, then `pnpm e2e:server`. See “Upgrading the pinned
  image”. The warning is a heuristic (volume creation time vs. image build time) and only ever
  warns — it never blocks or deletes anything.
