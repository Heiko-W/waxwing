<p align="center">
  <img src="assets/logo/waxwing-icon.svg" width="112" alt="Waxwing logo"/>
</p>

<h1 align="center">Waxwing</h1>

<p align="center"><b>A serverless webmail client for JMAP.</b><br/>
Just static files and your mail server — no middleware, no database, no container.</p>

---

Waxwing is a modern, minimalist webmail client that runs entirely in the browser and talks
directly to a JMAP mail server such as [Stalwart](https://stalw.art) — over HTTPS and
WebSocket. It ships as plain static files: Stalwart can host it itself (via its
*Applications* feature), or you serve it from any web server or CDN. Installable as a
Progressive Web App with real push notifications, offline reading, and an offline outbox.

> The waxwing is named for the sealing-wax-red tips of its wing feathers — the bird that
> carries a wax seal. Silky plumage, no excess, letters delivered sealed: that's the brand.

## Why

Classic webmail (Roundcube & friends) needs its own server-side stack because IMAP was
never meant for browsers. JMAP is: JSON over HTTPS, parsed and indexed by the mail
server. That makes the extra webmail server obsolete — Waxwing is the client that follows
through on that idea.

## Install it

Stalwart can host Waxwing itself and keep it updated. One command, and it is done:

```sh
curl -u 'admin:PASSWORD' -X POST https://mail.example.com/jmap/ \
  -H 'Content-Type: application/json' \
  -d '{
    "using": ["urn:ietf:params:jmap:core"],
    "methodCalls": [["x:Application/set", {
      "create": {
        "waxwing": {
          "enabled": true,
          "description": "Waxwing webmail",
          "resourceUrl": "https://github.com/Heiko-W/waxwing/releases/latest/download/waxwing-stalwart.zip",
          "urlPrefix": { "/webmail": true },
          "autoUpdateFrequency": 604800000
        }
      }
    }, "c1"]]
  }'
```

Restart Stalwart and open `https://mail.example.com/webmail/`. That is the whole installation:
no web server to run, no container, no database. `autoUpdateFrequency` makes Stalwart re-fetch
the release weekly, so new versions arrive on their own — drop that field if you would rather
update by hand, or point `resourceUrl` at a versioned asset to pin one.

Not using Stalwart, or want it behind your own nginx? Two more paths — and the honest
trade-off of the cross-origin one — are in the **[deployment guide](docs/deployment.md)**.

## What it does

- **Mail** — conversations, a virtualized list that stays smooth at 100 000 messages, full-text
  search, labels, and triage that works entirely from the keyboard
- **Compose** — rich text (Fastmail's Squire), draft autosave, attachments, identities, undo send
- **Contacts** — JMAP for Contacts (RFC 9610) address books, groups, composer autocomplete
- **Live** — push over WebSocket (RFC 8887) / EventSource, system notifications via Web Push
- **Offline** — a local replica, an outbox that survives a reload and a reconnect, installable as a PWA
- **Private** — remote content blocked by default, message bodies rendered in a script-free
  sandboxed frame, zero telemetry
- **Yours** — minimalist design, dark/light, white-label through `config.json` + `theme.css`
  with no rebuild

## Status

**v0.9.0 — feature-complete, and deliberately not 1.0 yet.**

Every planned work package is done and the release gate is signed off: 2 997 unit tests, 9
integration suites against a live Stalwart, and 99 end-to-end tests across six Playwright
suites, all green. Performance and accessibility are measured rather than asserted — the
numbers are in the [implementation plan](docs/implementation-plan.md).

What 1.0 is waiting on is **use**. A mail client earns that number by being lived in for a
while, against more than one server and more than one mailbox. That has not happened yet.

Known gaps, stated plainly:

- **No screen reader has been used on it by a person.** The accessibility work is automated and
  thorough; nobody has listened to it. See [`docs/accessibility.md`](docs/accessibility.md).
- **Stalwart is the only server it has been tested against.** JMAP is a standard and the client
  reads the session capabilities rather than assuming, but "should work" is not "does work".
- **Cached mail is not encrypted at rest** — a browser has nowhere to put a key. Not suitable
  for an untrusted shared machine.
- **The phishing link check is friction, not a boundary.** No warning means "nothing found",
  not "checked and safe". [`SECURITY.md`](SECURITY.md) says why in detail.

## Documentation

**Running it**

- [Deployment guide](docs/deployment.md) — three ways to host it, and which to pick
- [`config.json` reference](docs/configuration.md) — every setting, with its range and reasoning
- [Theming](docs/theming.md) — white-labelling without a rebuild
- [Accessibility](docs/accessibility.md) — what is verified, how, and what is not
- [Security & threat model](SECURITY.md) — including where a defence is only friction

**Building on it**

- [Contributing](CONTRIBUTING.md) — start here; the test discipline is the part worth reading
- [Functional specification](docs/functional-specification.md) — what it does, by requirement id
- [Technology stack & architecture](docs/tech-stack.md) — how, and why those choices
- [Implementation plan](docs/implementation-plan.md) — the work-package history and defect log
- [Architecture decisions](docs/adr/) — every deviation, with its reasoning

## Contributing

Contributions are welcome, and the project is unusually explicit about what it expects — see
[CONTRIBUTING.md](CONTRIBUTING.md). The short version: `pnpm gate` has to be green, and **a
test has to fail when your fix is removed.** That second one is the house rule; the guide
illustrates it with three real cases where a green test was measuring nothing.

Good places to start are in the issue tracker. Bug reports are genuinely useful — especially
with a `.eml` attached for anything about how a message renders, which is the only way to
reproduce those exactly.

## Licence

The app is **AGPL-3.0-only**: run it, modify it, host it for others — and if you modify it and
let people use it over a network, they get your changes too.

Two packages are **MIT** so that clients which are not themselves AGPL can use them:
[`@waxwing/jmap`](packages/jmap) (a typed JMAP client, no runtime dependencies) and
[`@waxwing/jscontact`](packages/jscontact) (JSContact ⇆ vCard). Neither is on npm yet.

## Development

**Prerequisites:** [Node.js](https://nodejs.org) ≥ 22 and [pnpm](https://pnpm.io) ≥ 10
(`corepack enable` picks up the version pinned in `package.json`).

```sh
pnpm install
```

Common scripts, run from the repo root:

| Command | What it does |
|---|---|
| `pnpm typecheck` | TypeScript strict type-check across all workspace packages |
| `pnpm lint` | Biome lint + format + import-sort check |
| `pnpm lint:fix` | Biome auto-fix (lint + format + import sort) |
| `pnpm format` | Biome format-write |
| `pnpm test` | Unit/component tests (Vitest) |
| `pnpm build` | Build all packages |
| `pnpm size` | Build `apps/web` and check it against the `size-limit` budget (≤ 300 KB gz initial JS) |
| `pnpm verify` | **Run before committing** — the fast gate: `typecheck` → `lint` → `test` → `size` (no Docker/browser) |
| `pnpm verify:e2e` | The E2E gate (needs Docker): install chromium, bring the Stalwart fixture up + smoke, run Playwright, always tear down |
| `pnpm verify:all` | `pnpm verify` then `pnpm verify:e2e` |
| `pnpm gate` | **The local pipeline** — preflight (pins the Node major) → `verify` → the `@waxwing/jmap` integration suites against a live fixture → the E2E suites, with a per-stage summary |
| `pnpm gate:fast` | The hermetic half of the pipeline; what `.githooks/pre-push` runs |
| `pnpm e2e:server` | Start a local Stalwart JMAP server with test accounts (Docker) |
| `pnpm e2e:server:down` | Stop it and wipe its ephemeral data |
| `pnpm demo` | Dev-only raw end-to-end demo: Stalwart fixture + seeded mail + a throwaway login/read UI at `http://localhost:5173` (Docker) |
| `pnpm demo --lan` | Same, served on your LAN IP so another machine can open it (Basic sign-in only — see below) |

**Before committing, run `pnpm verify`** (and `pnpm verify:e2e` when you have Docker). These
scripts are the pre-merge gate: typecheck, Biome, tests, build, the `size-limit` budget, the
Stalwart fixture smoke and the Playwright suites. [CI](.github/workflows/ci.yml) runs the very
same scripts — it was written that way on purpose ([ADR-003](docs/adr/003-local-verify-first-ci-later.md)),
so the local and hosted gates cannot drift apart.

### The local pipeline (`pnpm gate`)

`pnpm gate` sequences those scripts and adds the three things a gate you run by hand cannot give you:

- **A Node preflight.** `.nvmrc` pins 24 while `engines` says `>=22`, so a newer major satisfies the
  manifest and still breaks the suite — on Node ≥ 25 a global `localStorage` shadows jsdom's and
  ~22 tests fail for reasons unrelated to the code. The pipeline refuses to run rather than hand you
  results you would have to distrust.
- **The `@waxwing/jmap` integration suites, actually run** (defect B22). They `describe.skipIf`
  themselves away when the fixture is unreachable, so a skip was indistinguishable from a pass; the
  stage brings a fixture up and then asserts nothing was skipped.
- **Automation.** Enable the versioned hook once per clone:

  ```sh
  git config core.hooksPath .githooks   # pre-push runs `pnpm gate:fast`
  ```

  Push anyway with `git push --no-verify` when you mean to.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the same stages by calling the same
scripts. Running it locally with [`act`](https://github.com/nektos/act)
was evaluated and rejected: act mounts the host Docker socket instead of nesting a daemon, so the
fixture's compose bind mounts resolve to non-existent host paths and are silently replaced with empty
directories — Stalwart then boots with no config and no diagnostic. Details in ADR-019.

Need a real mail server to develop against? `pnpm e2e:server` brings up a pinned, local,
plain-HTTP [Stalwart](https://stalw.art) instance with ready-made test accounts in one
command. See [`e2e/stalwart/README.md`](e2e/stalwart/README.md) for accounts, ports, and
the dev-only TLS choice. Requires Docker.

### Raw end-to-end demo (`pnpm demo`)

`pnpm demo` (work package SP.4) is a **dev-only, throwaway** UI that talks straight to the
JMAP fixture — login (OAuth + Basic), a mailbox list with counts, a paged message list, a
raw message view (text + naive HTML in a sandboxed iframe) and an `Email/parse` button for a
`message/rfc822` attachment. It is **not** in the production bundle (it is gated on
`import.meta.env.DEV && VITE_WAXWING_DEMO === '1'`, so every `vite build` dead-code-eliminates
it). One command brings up the Stalwart fixture, advertises the browser's origin, seeds
alice's inbox with demo mail, and starts a same-origin Vite proxy + dev server; Ctrl-C tears
everything back down.

```sh
pnpm demo          # open http://localhost:5173 — Basic AND OAuth both work (secure context)
pnpm demo --lan    # open http://<your-lan-ip>:5173 from another machine on your LAN
```

Sign in with the fixture account the banner prints (`alice@waxwing.test` /
`waxwing-e2e-Pw1!`; the form is pre-filled). **LAN caveat:** a plain-`http` LAN IP is an
*insecure context*, so `crypto.subtle` is unavailable — OAuth and "stay signed in" are
disabled there and only **Basic** sign-in works (the demo says so and disables OAuth). Serve
the demo over HTTPS at the LAN origin (or use `localhost`) if you need OAuth.

The matching Playwright check is `pnpm e2e:demo` (run it in a second terminal while
`pnpm demo` is up; it skips cleanly if the demo isn't running).

This is a **pnpm workspace**:

- `apps/web` — the Waxwing SPA (AGPL-3.0)
- `packages/jmap` — `@waxwing/jmap`, typed JMAP client (MIT)
- `packages/jscontact` — `@waxwing/jscontact`, JSContact ↔ vCard 4 conversion (MIT)
- `packages/mail-html` — `@waxwing/mail-html`, HTML-mail sanitizer + sandboxed renderer (AGPL-3.0)
- `e2e` — Playwright suites + the Stalwart Docker fixture
- `docs` — specification, tech stack, implementation plan, and ADRs
