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

## Highlights (planned for V1)

- **Mail**: conversations, blazing-fast virtualized lists, full-text search, keywords/labels
- **Compose**: rich text (Fastmail's Squire), drafts autosave, attachments, identities, undo send
- **Contacts**: JMAP for Contacts (RFC 9610) address books, groups, composer autocomplete
- **Live**: push via WebSocket (RFC 8887) / EventSource; system notifications via Web Push — even while closed
- **Offline**: cached mail, offline outbox, installable PWA
- **Self-service**: vacation responder right in settings; Sieve filter rules follow in V1.x
- **Private & safe**: remote content blocked by default, sandboxed HTML rendering, zero telemetry
- **Yours**: Apple-inspired minimalist design, dark/light, white-label via `config.json` + `theme.css`

## Documents

- [Functional specification](docs/functional-specification.md)
- [Technology stack & architecture](docs/tech-stack.md)
- [Implementation plan](docs/implementation-plan.md)

## Status

🚧 **Phase 0 (Foundation) in progress.** The repository is being bootstrapped — pnpm
workspace, TypeScript, Biome, and the package skeleton are in place. Follow progress on the
[implementation plan](docs/implementation-plan.md) status board.

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
| `pnpm e2e:server` | Start a local Stalwart JMAP server with test accounts (Docker) |
| `pnpm e2e:server:down` | Stop it and wipe its ephemeral data |
| `pnpm demo` | Dev-only raw end-to-end demo: Stalwart fixture + seeded mail + a throwaway login/read UI at `http://localhost:5173` (Docker) |
| `pnpm demo --lan` | Same, served on your LAN IP so another machine can open it (Basic sign-in only — see below) |

**Before committing, run `pnpm verify`** (and `pnpm verify:e2e` when you have Docker). These
scripts are the pre-merge gate: they run the same checks a CI would (typecheck, Biome, tests,
build, `size-limit` budget, the Stalwart fixture smoke, and the Playwright suite). GitHub
Actions CI is deliberately deferred while the project is local ([ADR-003](docs/adr/003-local-verify-first-ci-later.md));
the future workflow will simply wrap these scripts.

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

## License

- App: **AGPL-3.0**
- `@waxwing/jmap` client library: MIT (planned, to seed the JMAP ecosystem)
