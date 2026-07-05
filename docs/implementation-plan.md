# Waxwing — Implementation Plan

| | |
|---|---|
| **Project** | Waxwing — a serverless webmail client for JMAP |
| **Version** | 0.1 |
| **Date** | 2026-07-05 |
| **Companions** | [functional-specification.md](./functional-specification.md) (WHAT) · [tech-stack.md](./tech-stack.md) (HOW) |
| **Status** | Living document — the authoritative roadmap; updated at the end of every work session |

---

## 1. Purpose

This document turns the milestone sketch in [tech-stack.md §9](./tech-stack.md) into an
executable roadmap: phases → work packages (WPs) with scope, dependencies, spec references,
task lists and exit criteria. It is written for AI agents (and humans) picking up the
project in future sessions: any session should be able to start from the
[status board (§3)](#3-status-board) alone and know what to do next.

Precedence on conflict: **functional-specification.md and tech-stack.md win over this
plan.** This plan describes sequencing and packaging, not requirements. If implementation
reveals that a spec or stack decision doesn't hold, record an ADR (§2.3) and update all
affected documents — never silently diverge.

## 2. How to Use This Plan (session protocol)

### 2.1 Session start

1. Read (or re-read) `docs/functional-specification.md`, `docs/tech-stack.md`, and this
   plan's status board (§3). Skim existing ADRs in `docs/adr/` once that directory exists.
2. Pick the next WP that is `todo` and whose dependencies are all `done` — unless the user
   directs otherwise. Prefer finishing an `in-progress` WP over starting a new one.
3. Set the WP's status to `in-progress` in the board before writing code.
4. Work on **one WP at a time**. If a WP turns out too large for the session, complete a
   coherent subset, check off the finished tasks, and leave the repo green (build, lint,
   tests all passing) at session end.

### 2.2 Session end

1. Update the status board (§3) and the WP's task checkboxes to match reality.
2. Add discovered follow-up work as new checkbox items in the relevant WP (or a new WP if
   it doesn't fit anywhere) — never keep TODOs only in your head or in code comments.
3. If anything deviated from spec/stack/plan: write an ADR (§2.3) and adjust the docs.
4. Append a one-line entry to the changelog (§15): date, WP(s) touched, outcome.

### 2.3 Change management (ADRs)

Architecture/scope decisions made during implementation go to `docs/adr/NNN-title.md`
(lightweight [MADR](https://adr.github.io/madr/) style: Context → Decision → Consequences,
one page max). Number sequentially from `001`. Typical triggers: a spike finding
invalidates an assumption, a library must be replaced, a requirement needs
re-interpretation, a WP is split or re-scoped.

### 2.4 Global Definition of Done

Applies to **every** WP in addition to its own "Done when" list:

- `pnpm typecheck`, `pnpm lint` (Biome) and all tests pass; CI is green.
- New logic has unit/component tests; user-visible flows touched get/keep E2E coverage.
- No hardcoded user-visible strings — everything through i18next with `en` **and** `de`
  entries (FR-I18N-01 demands i18n *from day one*).
- Interactive UI is keyboard-operable with visible focus; images/icons have accessible
  names (FR-A11Y-01 is continuous, not an M4 afterthought).
- Bundle-size budget respected (`size-limit` gate, NFR-PERF-01); new dependencies justified
  against §2 of tech-stack.md and license-checked (AGPL-compatible; packages/* stay MIT-clean).
- All new code account-scoped where it touches persisted data (FR-AUTH-07 readiness).
- Docs updated where behavior/config changed (`config.json` reference, deployment notes).

### 2.5 Conventions

- **Commits:** Conventional Commits (`feat(scope): …`, `fix: …`, `chore: …`); scopes:
  `web`, `jmap`, `mail-html`, `jscontact`, `sync`, `e2e`, `docs`, `ci`.
- **Package naming:** `@waxwing/jmap`, `@waxwing/jscontact`, `@waxwing/mail-html`.
- **Licenses:** repo root AGPL-3.0; `packages/jmap` and `packages/jscontact` MIT (pending
  decision D1, §13); `packages/mail-html` AGPL-3.0.
- **Estimates legend:** S ≈ ½–1 focused session · M ≈ 1–3 sessions · L ≈ 3+ sessions
  (consider splitting when an L drags). Calendar figures in §4 are orientation only.

## 3. Status Board

Single source of truth for progress. Statuses: `todo` · `in-progress` · `blocked` ·
`done` · `dropped`. Keep the table sorted as-is; only edit Status and Notes.

### Phase 0 — Foundation

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P0.1 | Repo bootstrap (git, workspaces, tooling) | S | — | done | git, pnpm workspace, TS 6 strict base, Biome 2.5, licenses, skeleton |
| P0.2 | App scaffold (Vite/React, tokens, i18n, config boot) | M | P0.1 | done | Vite 8 + React 19; tokens (WCAG-AA, light/dark); runtime config.json+theme.css; i18n en/de lazy; strict CSP; 80.95 KB gz initial |
| P0.3 | Test infrastructure (Vitest, RTL, Playwright) | S | P0.1 | todo | |
| P0.4 | Stalwart dev/E2E fixture (Docker) | M | P0.1 | todo | |
| P0.5 | CI pipeline + size budgets | S | P0.2–P0.4 | todo | |

### Phase 1 — Spike (validate risky assumptions)

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| SP.1 | `@waxwing/jmap` core (session, calls, chunking) | L | P0.1, P0.4 | todo | |
| SP.2 | Auth: OAuth PKCE + token storage + Basic scheme | M | SP.1, P0.4 | todo | |
| SP.3 | Push transports: EventSource + WebSocket (RFC 8887) | M | SP.1 | todo | |
| SP.4 | Raw end-to-end demo (login → list → message) | M | SP.1, SP.2, P0.2 | todo | |
| SP.5 | Spike report, ADRs, validation checklist | S | SP.1–SP.4 | todo | |
| **G1** | **Gate: owner reviews spike findings, plan adjusted** | — | SP.5 | todo | blocks M1 |

### Phase 2 — M1 "Read"

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| M1.1 | Design system foundation (doc, tokens, base components) | L | P0.2 | todo | |
| M1.2 | Local replica schema (Dexie, account-scoped) | M | SP.1, P0.3 | todo | |
| M1.3 | Sync engine core + action queue skeleton | L | M1.2, SP.3, G1 | todo | |
| M1.4 | App shell: routing, layout, config/theme boot, auth UX | L | M1.1, SP.2 | todo | |
| M1.5 | Folder tree (roles, counts, manage) | M | M1.3, M1.4 | todo | |
| M1.6 | Message list: virtualization, threading, selection | L | M1.3, M1.4 | todo | |
| M1.7 | `@waxwing/mail-html`: sanitizer + iframe renderer | L | P0.1, SP.1 | todo | |
| M1.8 | Reading experience (conversation view, actions, attachments) | L | M1.6, M1.7 | todo | |
| M1.9 | Live updates end-to-end + E2E read suite | M | M1.5, M1.6, M1.8 | todo | |

### Phase 3 — M2 "Write"

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| M2.1 | Squire editor wrapper component | M | M1.1 | todo | |
| M2.2 | Composer container (docked/fullscreen, parallel drafts) | M | M2.1, M1.4 | todo | |
| M2.3 | Reply / reply-all / forward (quoting, subjects, headers) | M | M2.1, M1.8 | todo | |
| M2.4 | Recipient fields (pills, validation, basic autocomplete) | M | M2.2, M1.2 | todo | |
| M2.5 | Identities & signatures | S | M2.2 | todo | |
| M2.6 | Drafts autosave (server + local, crash-safe) | M | M2.2, M1.3 | todo | |
| M2.7 | Attachments & inline images (upload pipeline) | M | M2.2, SP.1 | todo | |
| M2.8 | Send pipeline (submission, errors, undo send) | M | M2.3–M2.7 | todo | |
| M2.9 | E2E write suite (send/receive round-trip) | S | M2.8 | todo | |

### Phase 4 — M3 "Daily driver"

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| M3.1 | Search (operators, chips, scoping) | M | M1.6 | todo | |
| M3.2 | Keywords/labels UI + folder cleanup tools | M | M1.6 | todo | |
| M3.3 | Offline outbox hardening + conflict UX | M | M1.3, M2.8 | todo | |
| M3.4 | Cache policy & storage management | M | M1.3 | todo | |
| M3.5 | PWA: manifest, service worker, offline shell, updates | M | M1.4 | todo | |
| M3.6 | Web Push notifications + preferences | M | M3.5, SP.3 | todo | |
| M3.7 | Settings area: capabilities panel, vacation, quota | M | M1.4 | todo | |
| M3.8 | Keyboard shortcuts + command palette | M | M1.4 | todo | |
| M3.9 | Reading & triage polish (headers, .eml, phishing, DnD, swipe) | M | M1.8 | todo | |
| M3.10 | E2E: offline & push suites | M | M3.3, M3.5, M3.6 | todo | |
| **G2** | **Gate: Stalwart-v1.0 baseline decision (D3) + M3 review** | — | M3.10 | todo | blocks M4 finish |

### Phase 5 — M4 "V1 release"

| WP | Title | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| M4.1 | `@waxwing/jscontact` (JSContact ↔ vCard 4) | M | P0.1 | todo | |
| M4.2 | Contacts area (books, cards, groups) | L | M4.1, M1.1, M1.3 | todo | |
| M4.3 | Contacts↔mail integration (autocomplete, hover cards, import/export) | M | M4.2, M2.4 | todo | |
| M4.4 | Shared accounts (delegated mailbox trees) | M | M1.3 | todo | |
| M4.5 | Theming & white-label completion | M | M1.4 | todo | |
| M4.6 | i18n completion (en + de), RTL readiness audit | M | all UI WPs | todo | |
| M4.7 | Accessibility audit & fixes (WCAG 2.2 AA) | M | all UI WPs | todo | |
| M4.8 | Performance hardening & budget verification | M | all UI WPs | todo | |
| M4.9 | Release engineering: artifacts, guides, security docs, v1.0.0 | L | M4.1–M4.8, G2 | todo | |
| **G3** | **Gate: release sign-off (a11y, perf, security, docs)** | — | M4.9 | todo | |

## 4. Phase Overview & Dependencies

```
P0 Foundation ──► SP Spike ──► G1 ──► M1 Read ──► M2 Write ──► M3 Daily driver ──► G2 ──► M4 V1 ──► G3
 ~1 week          1–2 weeks          4–6 weeks    3–5 weeks     4–6 weeks                 4–6 weeks
```

Calendar figures assume part-time work with agent support and are **orientation only** —
the unit that matters is the WP. Within a phase, WPs with disjoint dependencies can run in
parallel (e.g. M1.1/M1.2/M1.7 right after G1; M4.1 any time). Two WPs are deliberately
early despite belonging to later feature areas: the action-queue skeleton (in M1.3) and
account-scoping (M1.2), because retrofitting either would be expensive.

Phase-level exit criteria are listed at the end of each phase section. Gates G1–G3 are
explicit stop points requiring the project owner's review.

---

## 5. Phase 0 — Foundation

Goal: a repo where every later WP finds tooling, tests, CI and a live JMAP server ready.
No product features.

### P0.1 — Repo bootstrap

Spec: §2 tech-stack (constraints), licensing. Size: S.

- [x] `git init`, `.gitignore` (node, dist, playwright artifacts), `.editorconfig`.
- [x] pnpm workspace: `pnpm-workspace.yaml` covering `apps/*`, `packages/*`, `e2e`;
      root `package.json` with `engines` pin and scripts (`typecheck`, `lint`, `test`, `build`).
- [x] Directory skeleton per tech-stack §5: `apps/web`, `packages/jmap`,
      `packages/jscontact`, `packages/mail-html`, `e2e`, `docs/adr/`.
- [x] TypeScript strict base config (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`,
      `exactOptionalPropertyTypes`, `isolatedModules`); per-package tsconfigs extend it.
- [x] Biome config (lint + format, one config at root).
- [x] Licenses: `LICENSE` (AGPL-3.0) at root; `LICENSE` (MIT) in `packages/jmap` and
      `packages/jscontact` — flagged pending D1 (§13, noted in each package README).
- [x] README: add "Development" section (prereqs, `pnpm install`, script overview).

Done when: `pnpm install && pnpm typecheck && pnpm lint` run clean on a fresh clone.
✅ Verified 2026-07-05: `pnpm install` (6 workspace projects) → `pnpm typecheck` →
`pnpm lint` all green. Toolchain pinned: Node ≥ 22, pnpm 11.1.1, TypeScript 6.0.3,
Biome 2.5.2.

### P0.2 — App scaffold

Spec: FR-DEP-01/02/03/04, FR-THEME-01/02 (boot path only), FR-I18N-01, NFR-SEC-01. Size: M.

- [x] Vite 8 + React 19 app in `apps/web` (see ADR-001); **`base: './'`** (relative asset paths — required
      for Stalwart `<base href>` rewriting, FR-DEP-02); verify built `index.html` uses only
      relative URLs.
- [x] CSS Modules wired; `src/ui/tokens.css` starter: `--waxwing-*` custom properties
      (color, spacing 8-pt scale, radius, typography), light + dark sets behind
      `prefers-color-scheme` plus a manual override (`:root[data-theme=…]`).
- [x] Boot loader: fetch `config.json` and `theme.css` from the deployment directory at
      startup (network-first, graceful defaults when absent); typed config schema matching
      spec §9; document that these files are **never** precached later.
- [x] i18next scaffold: lazy-loaded JSON locales `en`/`de`, `Intl`-based date/number
      helpers, a `t()` lint convention (no raw strings in JSX).
- [x] Strict CSP in dev (`vite` dev-server headers) and documented for deployment:
      no inline script, no `eval`, `frame-src` for the mail iframe strategy.
- [x] Icons: Lucide installed, tree-shaking verified in a build.

Done when: `pnpm --filter web build` produces a static bundle that boots from a plain
file server under an arbitrary path prefix, shows a placeholder shell in en/de, light/dark.
✅ Verified 2026-07-05 (multi-agent workflow): typecheck/lint/build green; initial JS
80.95 KB gz (budget 300 KB); Playwright boot under an arbitrary `/deploy/mail/` prefix —
shell renders product name from `config.json`, en↔de (lazy locale chunks) and
light↔dark (persisted) both work, **all 8 requests same-origin** (NFR-PRIV-01), 0 console
errors; 18 token contrast pairs pass WCAG AA in both themes; ADR-001 records the Vite 8
decision. Follow-ups tracked: SRI for own assets (release/M4.9) and radiogroup a11y
polish for the switches (with P0.3 tests).

### P0.3 — Test infrastructure

Spec: NFR-QUAL-01, tech-stack §7. Size: S.

- [ ] Vitest workspace config (per-package projects); Testing Library + `jsdom` for
      `apps/web`; `fake-indexeddb` for Dexie-touching unit tests.
- [ ] Playwright skeleton in `e2e/` (config, one placeholder spec, HTML reporter);
      browsers pinned.
- [ ] `axe-core` integration helper for component a11y assertions.
- [ ] One example test per level proving the harness works.

Done when: `pnpm test` and `pnpm e2e` (against the P0.4 fixture) run green in one command each.

### P0.4 — Stalwart dev/E2E fixture

Spec: NFR-COMPAT-02 (baseline v0.16), tech-stack §7. Size: M.

- [ ] `e2e/stalwart/docker-compose.yml` with **pinned Stalwart v0.16.x** image; volumes
      ephemeral; ports documented.
- [ ] Provisioning script (idempotent): test domain, admin, 2–3 test accounts with known
      passwords, OAuth/OIDC enabled; runs via Stalwart CLI or HTTP admin API.
- [ ] TLS story for dev: mkcert or plain-HTTP localhost exception — document choice.
- [ ] `pnpm e2e:server` (up + provision + healthcheck on `/.well-known/jmap`),
      `pnpm e2e:server:down`.
- [ ] Smoke test: unauthenticated session request returns 401; authenticated (Basic)
      session document parses.
- [ ] Second compose profile tracking `stalwart:main` for the scheduled compat job (used
      by P0.5, non-blocking).

Done when: one command gives any contributor a working JMAP server with test accounts.

### P0.5 — CI pipeline + size budgets

Spec: NFR-PERF-01/03, NFR-QUAL-01, tech-stack §6. Size: S.

- [ ] GitHub Actions: install (pnpm cache) → typecheck → Biome → unit/component tests →
      build → `size-limit` gate → Playwright E2E against the P0.4 fixture.
- [ ] `size-limit` config: **≤ 300 KB gzipped initial JS** for `apps/web` critical path;
      per-package budgets for `@waxwing/jmap` (target ≤ 15 KB gz) and `@waxwing/mail-html`.
- [ ] Scheduled weekly job: E2E smoke against `stalwart:main` (non-blocking, opens an
      issue on failure).
- [ ] Badge/status wiring in README.

Done when: a PR that violates the size budget or breaks a test cannot merge.

**Phase 0 exit criteria:** all P0 WPs done; a fresh clone reaches green CI locally in
< 10 minutes; Stalwart fixture documented in README.

---

## 6. Phase 1 — Spike

Goal: retire the project's riskiest unknowns with running code, per tech-stack §9.1. Code
quality matters (SP.1/SP.2 are production foundations), but **UI polish explicitly does
not** — SP.4 is a throwaway dev page. Everything learned lands in SP.5's report.

### SP.1 — `@waxwing/jmap` core

Spec: FR-SRV-01/02/03, tech-stack §4.2. Size: L.

- [ ] Package scaffold: zero runtime deps, ESM, `exports` map, tsup or vite lib build.
- [ ] Session: fetch + parse `/.well-known/jmap` (relative for same-origin, absolute for
      manual connect); typed `Session`, `Account`, capability objects; re-fetch on
      `sessionState` change.
- [ ] Request layer: typed `Invocation`s, method-call builder with client-side ids,
      **back-references** (`ResultReference`/`#`), request-level and method-level error
      types per RFC 8620 §3.5–3.6.
- [ ] **Auto-chunking** against session limits: `maxCallsInRequest`, `maxObjectsInGet`,
      `maxObjectsInSet`, `maxSizeRequest` (FR-SRV-03); transparent re-assembly of results.
- [ ] Types (spike scope): Core (`Core/echo`), `Mailbox/*`, `Email/*` (incl. `Email/query`,
      `Email/changes`, `Email/queryChanges`, `Email/parse`), `Thread/*`. Reference
      `jmap-rfc-types` / `jmap-jam` (MIT) for shape-checking, don't depend on them.
      *(Submission, Identity, VacationResponse, SearchSnippet, PushSubscription follow in
      M1/M2; Blob RFC 9404, Quota RFC 9425, Sieve RFC 9661, Contacts RFC 9610 follow when
      first used — but reserve the module layout for all of them now.)*
- [ ] Blob transfer: upload via session `uploadUrl`, download via `downloadUrl` URI
      template ({accountId}, {blobId}, {type}, {name}); progress callbacks.
- [ ] Auth-scheme abstraction (`Bearer` / `Basic`) injected into all transports (FR-AUTH-04
      groundwork).
- [ ] Unit tests: chunking edge cases, back-ref resolution, error mapping (mock fetch).

Done when: against the P0.4 fixture, an integration test lists mailboxes, queries and
fetches emails, and round-trips a blob — all through the typed API.

### SP.2 — Auth: OAuth PKCE + token storage + Basic

Spec: FR-AUTH-01/02/03/04/05, NFR-SEC-02, tech-stack §4.7. Size: M.

- [ ] RFC 8414 discovery against Stalwart's OIDC metadata; Authorization Code + PKCE via
      `oauth4webapi`; redirect handling that works under any path prefix (FR-DEP-02).
- [ ] Token lifecycle: access token in memory only; refresh token in IndexedDB wrapped by
      a **non-extractable WebCrypto AES key** (also stored in IndexedDB as CryptoKey);
      silent refresh; offline start from persisted refresh token.
- [ ] Clarify Stalwart client-registration behavior: default no pre-registration vs.
      `requireClientRegistration` → client id from `config.json` (record in SP.5).
- [ ] Basic-auth path behind the same auth-scheme abstraction; "stay signed in" opt-in.
- [ ] Logout: token revocation where supported + full local wipe (IndexedDB, caches,
      registrations) — the FR-AUTH-05 primitive, UI comes in M1.4.
- [ ] Unit tests for token store; integration test: full PKCE dance against the fixture
      (Playwright, since it needs a real redirect).

Done when: login → API call → token refresh → logout works against local Stalwart with
both OAuth and Basic.

### SP.3 — Push transports

Spec: FR-NOTIF-01, tech-stack §4.2/§8. Size: M.

- [ ] EventSource client for the session `eventSourceUrl` (URI template:
      {types}, {closeafter}, {ping}). **Open question to answer here:** EventSource cannot
      send an `Authorization` header — determine Stalwart's supported auth for SSE
      (token query param? cookie? fetch-based SSE reader as fallback) and record it.
- [ ] WebSocket RFC 8887 client: `capability:websocket` detection, subprotocol `jmap`,
      request/response framing (`@type: Request/Response/WebSocketPushEnable/…`), push
      enable/disable, `StateChange` delivery.
- [ ] Shared reconnect/backoff with jitter; transport auto-selection: WebSocket →
      EventSource → polling stub (interface only, implemented in M1.3).
- [ ] Instrumented demo: deliver a mail via the fixture, log `StateChange` latency on both
      transports.

Done when: both transports deliver `StateChange` events for incoming mail against the
fixture and survive a server restart (reconnect).

### SP.4 — Raw end-to-end demo

Spec: validates FR-AUTH-01, FR-MBX/LST plumbing; tech-stack §9.1. Size: M.

- [ ] Dev-only route in `apps/web` (excluded from production build): login form (OAuth +
      Basic), mailbox list with counts, paged message list (`Email/query` +
      `Email/get`), raw message view (text body, naive HTML in sandboxed iframe —
      **not** the real sanitizer).
- [ ] No replica, no virtualization, no design system — direct client calls only.
- [ ] Exercise `Email/parse` on an attached `message/rfc822` to answer the SP.5 question.

Done when: a human can log into the fixture and read a delivered test mail end-to-end.

### SP.5 — Spike report, ADRs, validation checklist

Size: S. Deliverable: `docs/adr/` entries + a findings section appended to this plan (§13
notes or new ADRs), answering **each** of:

- [ ] CORS: exact behavior of cross-origin JMAP calls against Stalwart with/without
      `usePermissiveCors` (FR-DEP-05 docs input).
- [ ] `Email/parse`: supported by Stalwart v0.16? (decides whether `postal-mime` fallback
      is needed for FR-RD-07).
- [ ] WebSocket RFC 8887: works as specced? Push over WS reliable? (decides D2.)
- [ ] EventSource auth mechanism (see SP.3).
- [ ] `Email/queryChanges`: supported/reliable, or `cannotCalculateChanges` common?
      (shapes M1.3's sync strategy.)
- [ ] SearchSnippet support (shapes M3.1).
- [ ] OIDC: client registration needs, refresh-token lifetimes, revocation endpoint.
- [ ] Session limits actually reported by Stalwart (informs chunking defaults).
- [ ] Blob upload quirks (size caps, content-type handling).
- [ ] Stalwart Applications mount: build a throwaway zip of the P0.2 shell, mount it,
      verify `<base href>` rewriting + relative assets under `/mail` (FR-DEP-02).
- [ ] Sharing capability (`urn:ietf:params:jmap:principals` / Stalwart sharing) present?
      (feeds M4.4 planning.)

**Gate G1:** owner reviews the report; decisions D2 (WebSocket in V1 core?) and any plan
adjustments are recorded; M1 unblocks.

**Phase 1 exit criteria:** SP.5 checklist fully answered; G1 passed; `@waxwing/jmap`
core + auth are merged, tested foundations (not throwaway).

---

## 7. Phase 2 — M1 "Read"

Goal: Waxwing becomes a read-only mail client you'd actually leave open: local-first
replica, live folder tree, fast list, safe reading. This phase builds the architectural
spine (replica + sync + action queue) that every later phase leans on.

### M1.1 — Design system foundation

Spec: FR-UI-01/02, FR-A11Y-01, FR-THEME-01. Size: L.

- [ ] Write `docs/design-system.md`: principles (Apple-HIG-inspired, calm, content-first),
      token catalog, spacing/typography scales, motion rules (`prefers-reduced-motion`),
      component inventory. (The spec references this as a separate document — this WP
      creates it.)
- [ ] Complete the token sets from P0.2 for both themes; contrast-check every token pair
      (WCAG AA) and record results in the doc.
- [ ] Base components in `src/ui/`: Button, IconButton, TextInput, Select, Checkbox/Switch,
      Menu (roving focus), Dialog (focus trap), Tooltip, Toast/Snackbar, Avatar (initials),
      Badge, SplitPane, VisuallyHidden, Spinner/Skeleton.
- [ ] Every component: keyboard support, ARIA per APG pattern, axe test, both themes.
- [ ] 44-px minimum touch targets baked into tokens/components (FR-A11Y-01).

Done when: a component gallery dev page shows all base components in light/dark, and axe
reports zero violations on it.

### M1.2 — Local replica schema

Spec: FR-OFF-02 (basis), FR-AUTH-07 (account-scoping), tech-stack §4.3. Size: M.

- [ ] Dexie 4 schema in `src/sync/db.ts`. Tables (all keyed `[accountId+id]` — account
      scoping is non-negotiable from day one): `accounts`, `mailboxes`, `threads`,
      `emails` (index/envelope fields: mailboxIds, keywords, from/to, subject,
      receivedAt, preview, hasAttachment, size), `emailBodies` (fetched bodies + body
      structure, separate table so the index stays lean), `blobsMeta`, `syncState`
      (per account+objectType: JMAP state string), `queryCache` (canonical query key →
      ids, queryState, upToId), `outbox`, `localPrefs`.
- [ ] Canonical serialization for query keys (filter+sort normalized).
- [ ] Migration strategy documented (Dexie `version()` chain; never destructive).
- [ ] `dexie-react-hooks` `useLiveQuery` wrappers with account context.
- [ ] Unit tests on `fake-indexeddb`: schema round-trips, index queries used by the list.

Done when: replica CRUD + the exact queries M1.5/M1.6 need are tested and fast (indexed,
no full-table scans).

### M1.3 — Sync engine core + action queue skeleton

Spec: FR-NOTIF-01, FR-OFF-03 (skeleton), tech-stack §4.3. Size: L.

- [ ] **Leader election** via `navigator.locks.request('waxwing-sync', …)`; followers
      detect leader loss and re-elect; `BroadcastChannel` for engine status/events
      (replica reactivity itself comes free via Dexie liveQuery cross-tab).
- [ ] Push integration: transport auto-select from SP.3 (per G1/D2 decision), `StateChange`
      → targeted delta fetch; **polling fallback** implementation.
- [ ] Delta sync: `Mailbox/changes`, `Thread/changes`, `Email/changes` (with
      `updatedProperties` optimization); per-watched-query `Email/queryChanges`; recovery
      path on `cannotCalculateChanges` → full re-query + reconciliation.
- [ ] Windowed backfill: recent N days/messages per mailbox (default from `config.json`
      `offline.cacheDays`), oldest-window bookkeeping for "load more".
- [ ] **Action queue (outbox) skeleton** — even "mark read" is a write and must flow
      through it: intents as idempotent JMAP `set` patches with client ids; optimistic
      local apply → replay → confirm/rollback; `ifInState` where appropriate. M1 scope:
      online replay + basic retry. (Offline replay hardening + conflict UX = M3.3.)
- [ ] Actions implemented now: setKeywords (read/unread, flag), move (archive, junk,
      trash, arbitrary), delete (trash → destroy), mailbox create/rename/move/delete.
- [ ] Engine state surface for UI: syncing/offline/error, per-mailbox freshness.
- [ ] Unit tests: state-string bookkeeping, queryChanges reconciliation,
      cannotCalculateChanges recovery, optimistic apply/rollback, leader failover.

Done when: two open tabs stay consistent while mail is delivered to the fixture; killing
the leader tab hands over within seconds; a flag toggled offline-simulated (devtools)
replays on reconnect.

### M1.4 — App shell

Spec: FR-UI-03, FR-AUTH-01/02/05/06, FR-THEME-02, FR-DEP-04. Size: L.

- [ ] Routing (hash-free, base-path-safe): `/mail/:mailboxId/:emailId?`, `/contacts`,
      `/settings/*`; lazy route chunks (NFR-PERF-03).
- [ ] Responsive layout: three-pane desktop / two-pane tablet / single-pane phone with
      back navigation (FR-UI-03); reading-pane modes right/bottom/off (FR-LST-07 layout half).
- [ ] Onboarding: same-origin autoconnect (FR-AUTH-01); manual connect flow with
      email→domain `/.well-known/jmap` discovery and `config.json` pinning (FR-AUTH-02);
      login via OAuth redirect or Basic form per config.
- [ ] Session UX: re-auth prompt on expiry without losing state (FR-AUTH-06); "Sign out"
      vs "Sign out & remove data" (FR-AUTH-05).
- [ ] Branding applied from config: product name, logo, accent, links (FR-THEME-02 —
      no user-visible "Waxwing" hardcoded anywhere).
- [ ] Offline indicator + engine status in the chrome.

Done when: install → onboard → login → empty three-pane shell works on desktop and phone
viewport, branded via a test `config.json`.

### M1.5 — Folder tree

Spec: FR-MBX-01/02/04. Size: M.

- [ ] Tree from replica via liveQuery; role mailboxes (`inbox`, `drafts`, `sent`, `junk`,
      `trash`, `archive`) pinned, localized, iconographic; custom folders below, sorted
      per `sortOrder`/name.
- [ ] Live unread/total badges (push-updated).
- [ ] Manage: create, rename, move, delete with non-empty confirmation; honor `myRights`
      (`mayCreateChild`, `mayRename`, `mayDelete`, …) per mailbox (FR-MBX-02).
- [ ] Collapsible state + per-folder prefs persisted locally (FR-MBX-04).

Done when: folder CRUD round-trips against the fixture; a second client's changes appear
live; rights violations are prevented in UI, not just server-rejected.

### M1.6 — Message list

Spec: FR-LST-01/02/03/04/05/07, FR-ORG-01 (flows). Size: L.

- [ ] TanStack Virtual list bound to `queryCache` windows; sustained 60 fps target with
      100 k-message fixture mailbox (generate via seeding script — add one to e2e/).
- [ ] Threading via `Thread` objects; flat-view toggle global + per-folder (FR-LST-02).
- [ ] Row: sender, subject, server preview, relative localized time, unread/flagged/
      attachment/answered indicators, initials avatar (FR-LST-03 — never remote images).
- [ ] Selection model: click, shift/ctrl ranges, select-all-in-folder (id-set on the
      query, not just loaded rows); bulk actions bar → action queue (FR-LST-04, FR-ORG-01).
- [ ] Sorting: date/from/subject/size + unread-first toggle (FR-LST-05) — each sort is its
      own watched query.
- [ ] Density comfortable/compact (FR-LST-07).
- [ ] Infinite scroll = backfill trigger ("load more" into the window).

Done when: the 100 k seeded mailbox scrolls smoothly (measured, recorded in WP notes),
bulk-move of 500 messages works optimistically and syncs.

### M1.7 — `@waxwing/mail-html` package

Spec: FR-RD-01/02/03, NFR-SEC-01, tech-stack §4.5. Size: L.

- [ ] Sanitizer pipeline: DOMPurify with hooks that (a) strip script-bearing anything,
      (b) rewrite/strip `src`/`srcset`/`style url()` for **remote-content blocking**
      with a collected manifest of blocked resources, (c) rewrite `cid:` to JMAP blob
      download URLs, (d) enable DOM-clobbering protections; returns
      `{ html, blockedRemote: […], hasRemoteContent }`.
- [ ] Iframe renderer: `srcdoc` + `sandbox` (no `allow-scripts`, no
      `allow-top-navigation`), own minimal CSP via `<meta>` inside the document, `csp`
      attribute where supported; auto-height via ResizeObserver + postMessage; dark-mode
      strategy for mail content (conservative: light background, documented).
- [ ] Link handling: clicks intercepted inside the frame, re-dispatched to the app,
      opened `noopener noreferrer` with **visible target host** (FR-RD-08 groundwork).
- [ ] Plain-text renderer: linkification + quoted-text folding (`>` levels) (FR-RD-01).
- [ ] "Load remote content" mode: second sanitize pass allowing http(s) images —
      per-message and per-sender-allowlist logic stays in the app, package just executes
      policy.
- [ ] Adversarial test suite: XSS corpus (script, event handlers, `javascript:`, svg,
      CSS exfiltration, meta refresh, form action, DOM clobbering, `<base>` injection),
      remote-content leak tests (nothing fetched until allowed — assert via test server).

Done when: the corpus passes; **zero network requests** occur rendering a hostile mail
with remote content blocked (verified by an integration test with a network spy).

### M1.8 — Reading experience

Spec: FR-RD-03/04/05, FR-OFF-02 (opened bodies). Size: L.

- [ ] Message view composing `mail-html` output; on-open body fetch → `emailBodies`
      (cached forever until LRU, FR-OFF-02).
- [ ] Remote-content banner: load-once, per-sender "always allow" list in `localPrefs`
      (FR-RD-02) with privacy explanation.
- [ ] Conversation view: thread messages, older collapsed, expand-on-demand, quoted-text
      folding inside each (FR-RD-04).
- [ ] Attachments: list with type icons + sizes; download; inline preview for images and
      PDF (object/iframe, sandboxed); save-all (FR-RD-03).
- [ ] Action bar + context menus: reply/reply-all/forward (stubs enabled in M2), archive,
      delete, junk/not-junk, move (folder picker), flag, mark unread (FR-RD-05).
- [ ] Print stylesheet: clean single-message print (FR-RD-05).
- [ ] Unread handling: auto-mark-read on open (configurable delay later in settings).

Done when: an HTML newsletter, a plain-text mail, and a threaded conversation from the
fixture all read correctly, offline-reopenable after first open.

### M1.9 — Live updates end-to-end + E2E read suite

Spec: FR-NOTIF-01, NFR-QUAL-01. Size: M.

- [ ] Wire push → sync → liveQuery through every M1 surface: new mail appears in list +
      tree counts + open conversation without refresh.
- [ ] Playwright suite "read": login (OAuth + Basic), folder navigation, list scroll,
      open/read/flag/move/delete, live-update assertion (deliver via fixture SMTP during
      the test), two-tab consistency.
- [ ] Perf smoke in CI: folder switch < 200 ms perceived, cached message open < 100 ms
      (NFR-PERF-02) on the seeded mailbox — record method + numbers.

Done when: suite green in CI; M1 demo-able as a daily reading client.

**Phase 2 exit criteria:** all M1 WPs done; NFR-PERF-02 numbers recorded; size budget
still green; a tester can read mail on phone-sized viewport.

---

## 8. Phase 3 — M2 "Write"

Goal: full compose/send. After M2, Waxwing is a functional mail client (online).

### M2.1 — Squire editor wrapper

Spec: FR-CMP-01, tech-stack §4.4. Size: M.

- [ ] React wrapper around `squire-rte`: controlled-enough API (value in/out as HTML),
      toolbar state syncing (bold/italic/underline, lists, links, quote, font basics),
      clean lifecycle (no leaks on unmount).
- [ ] Output hygiene: generated HTML is mail-compatible (inline-safe styles, no
      editor-only attributes); **plain-text alternative generator** (HTML → text with
      sensible quoting/line breaks) as a pure, unit-tested function.
- [ ] Per-message plain-text-only mode (swaps editor surface, keeps content).
- [ ] Keyboard + a11y pass on the toolbar (roving focus, shortcuts ⌘B/⌘I/⌘K-link).
- [ ] Keep Squire behind our component API so it stays swappable (tech-stack §8 risk).

Done when: editor round-trips pasted third-party HTML unmangled (fixture corpus test) and
emits a sane text alternative.

### M2.2 — Composer container

Spec: FR-CMP-09. Size: M.

- [ ] Docked mini-composer (bottom-right) ↔ expand to full-screen; multiple parallel
      drafts on desktop; single full-screen composer on phone.
- [ ] Composer state store (Zustand): one instance per draft, survives route changes.
- [ ] Unsaved-changes guard on close (relies on M2.6 autosave, so mostly invisible).

Done when: two drafts can be edited in parallel, docked, expanded, and restored after a
route change.

### M2.3 — Reply / reply-all / forward

Spec: FR-CMP-02, FR-CMP-10 (forward originals). Size: M.

- [ ] Recipient derivation: reply (Reply-To > From), reply-all (dedup, drop own
      identities), forward (empty).
- [ ] Quoting: HTML `<blockquote>` with attribution line; `>`-quoting in text mode;
      quote folding in the editor (collapsed by default, expandable).
- [ ] Subject handling: `Re:`/`Fwd:` detection incl. localized variants, **no stacking**
      (FR-CMP-02).
- [ ] Threading headers: `In-Reply-To`, `References` built from the source message.
- [ ] Forward: original attachments included by reference to existing blobs (FR-CMP-10).
- [ ] Identity preselection: infer From by which identity the source was addressed to
      (FR-CMP-06 hook, logic here).

Done when: reply round-trip against the fixture threads correctly in a second client
(headers verified in the raw message).

### M2.4 — Recipient fields

Spec: FR-CMP-05 (recents part; contacts autocomplete lands in M4.3). Size: M.

- [ ] To/Cc/Bcc pill UI: parse on paste (comma/semicolon lists, `Name <addr>`), edit
      pills, drag between fields, keyboard-only operable.
- [ ] Validation: RFC-plausible address check, invalid pills flagged.
- [ ] Autocomplete v1: **recent correspondents** ranked by recency/frequency from the
      replica (an `addressStats` accumulation — add to M1.2 schema via migration).
- [ ] Typo heuristic, local only: common mail-domain edit-distance warning
      ("did you mean …@gmail.com") (FR-CMP-05).
- [ ] Autocomplete data source behind an interface so M4.3 can add address books.

Done when: fast keyboard-only recipient entry works; suggestions appear from mail history.

### M2.5 — Identities & signatures

Spec: FR-CMP-06. Size: S.

- [ ] `Identity/get` into replica; From selector listing identities (aliases).
- [ ] Per-identity signature (HTML + text) applied above quote (placement configurable),
      swap-on-identity-change without clobbering user edits.
- [ ] Per-identity reply-to honored.

Done when: switching From swaps signatures correctly in both HTML and text modes.

### M2.6 — Drafts autosave

Spec: FR-CMP-03. Size: M.

- [ ] Local-first: every few seconds of typing → replica (`outbox`-adjacent draft store);
      crash-safe (kill tab test loses ≤ a few seconds).
- [ ] Server sync: debounced `Email/set` create/update in Drafts mailbox with `$draft`
      keyword; updates replace prior draft version (destroy/create or update per server
      behavior — decide via fixture test, record).
- [ ] Offline: draft stays local, marked pending, syncs on reconnect (uses M1.3 queue).
- [ ] Draft lifecycle: open-from-Drafts resumes editing; discard destroys local + server.

Done when: pull-the-plug test (kill tab mid-typing) recovers the draft; drafts created
offline appear on the server after reconnect.

### M2.7 — Attachments & inline images

Spec: FR-CMP-04. Size: M.

- [ ] Upload pipeline via session `uploadUrl` (SP.1 blob API): file picker, drag & drop
      onto composer, **paste** (incl. screenshot paste → inline image) — inline images
      upload → `cid:` reference in HTML body.
- [ ] Progress UI per attachment, cancel, retry; failures don't lose the draft.
- [ ] Validation before send: `maxSizeUpload` / total size vs. server limits with clear
      errors (FR-CMP-04, FR-SRV-03).

Done when: a pasted screenshot arrives as a proper inline image in another client;
oversized files are rejected client-side with a useful message.

### M2.8 — Send pipeline

Spec: FR-CMP-07/08/10. Size: M.

- [ ] `EmailSubmission/set` with envelope from identity; `onSuccessUpdateEmail`: move
      draft → Sent, clear `$draft`, set `$seen` (FR-CMP-07).
- [ ] Set `$answered`/`$forwarded` on the source message after successful send.
- [ ] Error surfacing: per-recipient rejections, quota, size — actionable notices, draft
      preserved (FR-CMP-07).
- [ ] **Undo send:** client-side grace delay before submission fires; snackbar with Undo;
      configurable off/5/15/30 s, default 15 s, hoster default via `config.json`
      `undoSendSeconds` (FR-CMP-08 + decision log #2). Implemented as delayed outbox
      entry so navigation/tab-close during grace is handled predictably (document
      behavior).
- [ ] "Attachment mentioned but none attached" warning — localized keyword list en/de
      (FR-CMP-10).

Done when: send → lands in fixture inbox; Sent copy correct; Undo actually prevents
submission; rejected recipient shows a clear error.

### M2.9 — E2E write suite

Spec: NFR-QUAL-01. Size: S.

- [ ] Playwright: compose → send → receive round-trip between two fixture accounts;
      reply threading; attachment round-trip; draft autosave/recovery; undo send.

Done when: suite green in CI.

**Phase 3 exit criteria:** all M2 WPs done; a tester can hold a real e-mail conversation
(receive, reply with attachment) using only Waxwing.

---

## 9. Phase 4 — M3 "Daily driver"

Goal: the features that make Waxwing the client you *don't close*: search, labels, real
offline, PWA install, push notifications, settings, shortcuts.

### M3.1 — Search

Spec: FR-SRCH-01/02, FR-SRCH-03 (scoping + history; saved searches → V1.x). Size: M.

- [ ] Global search box (shortcut `/`): server-side `Email/query` with full filter
      mapping: text/from/to/subject/body, hasAttachment, before/after, mailbox, keywords.
- [ ] Operator parser: `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`,
      `in:folder`, `before:`/`after:` → JMAP `FilterCondition`s 1:1 (FR-SRCH-02); chips
      UI ↔ text operators stay in sync; advanced search panel builds the same filter.
- [ ] Results as a virtualized list (reuse M1.6) with highlighted snippets via
      `SearchSnippet/get` where supported (SP.5 finding; fallback: server preview).
- [ ] Scoping current-folder/everywhere; local search history (`localPrefs`).

Done when: operator strings and panel produce identical JMAP filters (unit-tested);
results render with highlights against the fixture.

### M3.2 — Keywords/labels + cleanup tools

Spec: FR-ORG-02/04. Size: M.

- [ ] Label management: create/color/rename custom keywords (IMAP-interoperable names;
      color map stored in `localPrefs` — document that colors are client-local).
- [ ] Assign/remove via list bulk actions, message view, and keyboard; filter/browse by
      label in the sidebar alongside folders (FR-ORG-02).
- [ ] Empty-trash / empty-junk with retention hint; per-folder "delete older than" bulk
      cleanup (FR-ORG-04) — chunked destroys respecting `maxObjectsInSet`.

Done when: labels round-trip with another IMAP/JMAP client against the fixture; bulk
cleanup of thousands of messages completes without tripping server limits.

### M3.3 — Offline outbox hardening + conflict UX

Spec: FR-OFF-03. Size: M.

- [ ] Extend the M1.3 queue: durable replay across restarts, exponential backoff,
      dependency ordering (e.g. draft create before send), dedup on reconnect storms.
- [ ] Conflict detection via state strings / `ifInState`; classification: auto-resolvable
      (retry with fresh state) vs. user-facing.
- [ ] Conflict UX: gentle, actionable notices ("couldn't move — folder deleted; keep in
      Inbox?") — never silent loss (FR-OFF-03).
- [ ] Offline send: queued submissions marked in UI ("will send when online"), cancelable
      while queued.
- [ ] Chaos tests: scripted offline/online flapping while performing actions (Playwright
      network throttling), server-side concurrent modifications.

Done when: chaos suite shows zero lost actions and correct conflict surfacing.

### M3.4 — Cache policy & storage management

Spec: FR-OFF-02/04. Size: M.

- [ ] Enforce windowed cache per config (`offline.cacheDays`, `offline.maxStorageMB`);
      LRU eviction of bodies/attachments beyond budget (never evict outbox/drafts).
- [ ] `navigator.storage.persist()` requested on install; `estimate()`-based usage UI in
      settings with per-category breakdown (FR-OFF-04).
- [ ] "Keep offline" pin per folder (exempt from eviction).
- [ ] Eviction unit tests with fake storage pressure.

Done when: filling the cache beyond budget evicts correctly (test), pinned folders
survive, usage UI matches reality.

### M3.5 — PWA: manifest, service worker, offline shell, updates

Spec: FR-OFF-01, FR-DEP-06, tech-stack §6. Size: M.

- [ ] `vite-plugin-pwa` (Workbox): precache app shell; **`config.json`, `theme.css`,
      `branding/*` network-first and never precached** (tech-stack §6).
- [ ] Manifest: icons (from `assets/logo/`), standalone display, theme/splash colors —
      brandable where feasible, document limits (manifest is baked at build).
- [ ] Offline boot: installed app opens without network, shows cached mail with a clear
      "offline" marker (FR-OFF-01).
- [ ] Update flow: SW updates in background → unobtrusive "reload for update" toast; no
      forced reloads mid-compose.
- [ ] Install guidance UI (per-platform, incl. iOS add-to-home-screen note,
      NFR-COMPAT-01).

Done when: Lighthouse PWA checks pass; offline reopen works on Chromium + WebKit
(Playwright offline mode); update toast demonstrated with a staged second build.

### M3.6 — Web Push notifications + preferences

Spec: FR-NOTIF-02/03, NFR-PRIV-01. Size: M.

- [ ] JMAP `PushSubscription/set`: generate keys via Push API subscription
      (`p256dh`/`auth`), register with server, handle the **`PushVerification`
      round-trip** (verification code arrives through the push channel and must be
      written back).
- [ ] Service-worker push handler: decode `StateChange`, decide notify-worthiness
      (new mail in enabled folders), show notification (sender/subject per privacy
      setting), focus-or-open on click.
- [ ] Expiry/rotation: resubscribe on `pushsubscriptionchange`, on login, and on SW
      update; clean up subscriptions on logout (FR-AUTH-05).
- [ ] Preferences UI: per-folder on/off, quiet hours, preview content on/off, sound
      on/off (FR-NOTIF-03).
- [ ] Document the privacy story (RFC 8291 E2E encryption — payloads unreadable by the
      browser vendor's push service) in-app and in docs (NFR-PRIV-01).

Done when: with the app **closed**, delivering mail to the fixture raises a system
notification (manually verified per platform; automated where Playwright allows).

### M3.7 — Settings area

Spec: FR-SRV-04, FR-VAC-01, FR-QTA-01, plus all toggles accumulated so far. Size: M.

- [ ] Settings shell (lazy route): sections General, Appearance (theme/density/accent),
      Reading, Compose (undo-send delay, signature placement), Notifications (→ M3.6),
      Offline & storage (→ M3.4), Server, About (imprint/support/privacy links from
      config).
- [ ] **Server capabilities panel:** session capabilities/limits rendered readably;
      optional features shown as available/absent — admin diagnostics (FR-SRV-04).
- [ ] **Vacation responder** (`VacationResponse/get|set`): on/off, date range, subject,
      rich body (reuse M2.1 editor), preview (FR-VAC-01).
- [ ] **Quota** (capability-gated, RFC 9425): sidebar/settings usage indicator, ≥ 90 %
      warning, quota-exceeded error UX on send/save (FR-QTA-01).
- [ ] Every setting: sane default, `localPrefs` persistence, instant apply.

Done when: vacation responder round-trips against the fixture; capabilities panel matches
the fixture's session doc; quota bar reflects a filled test account.

### M3.8 — Keyboard shortcuts + command palette

Spec: FR-UI-04. Size: M.

- [ ] Shortcut system: central registry, context-aware (list vs. reading vs. composer),
      no conflicts with editor; Gmail/Fastmail-style defaults: `j/k` next/prev, `e`
      archive, `r` reply, `c` compose, `/` search, `x` select, `#` delete, `u` back/unread,
      `?` cheat-sheet.
- [ ] `?` cheat-sheet overlay, generated from the registry (always accurate).
- [ ] **Command palette (⌘K)**: every registered action + folder jump + label jump,
      fuzzy matching, recent-first ranking (FR-UI-04).
- [ ] All palette/shortcut actions dispatch the same action layer as UI buttons (single
      source of truth).

Done when: full triage session (read, archive, reply, move) is possible without touching
the mouse; palette reaches every folder and action.

### M3.9 — Reading & triage polish

Spec: FR-RD-06/07/08, FR-MBX-03, FR-LST-06. Size: M.

- [ ] Header details on demand: full addresses, date, message-id, authentication results
      where exposed (FR-RD-06).
- [ ] "View source" / download `.eml` via Blob capability when present, else raw blob
      download (FR-RD-06, capability-gated per SP.5 finding).
- [ ] Attached `message/rfc822` opens as nested in-app message view via `Email/parse`
      (or `postal-mime` fallback per SP.5) (FR-RD-07).
- [ ] Phishing friction: display-name vs. address reveal on hover/tap; warn when link
      text host ≠ target host (FR-RD-08).
- [ ] Drag & drop: messages → folders, folder re-parenting (FR-MBX-03) with keyboard
      alternative (a11y).
- [ ] Swipe gestures on touch: configurable archive/delete/read actions (FR-LST-06).

Done when: each item demo-able; DnD and swipe have non-pointer equivalents.

### M3.10 — E2E: offline & push suites

Spec: NFR-QUAL-01. Size: M.

- [ ] Playwright: offline outbox scenarios (compose offline → reconnect → delivered),
      cache/eviction smoke, PWA install + offline boot, push-driven live update, (where
      runnable) notification display.
- [ ] Wire the chaos tests from M3.3 into CI (may be a nightly job if slow).

Done when: suites green in CI; flaky tests quarantined with issues, not ignored.

**Gate G2:** owner reviews M3; **decision D3** (raise server baseline to Stalwart v1.0?)
is made — v1.0 is expected ~Oct 2026, which likely coincides with this phase. Outcome
recorded; CI pins updated if raised.

**Phase 4 exit criteria:** all M3 WPs done; G2 passed; team members can (and do) use
Waxwing as their daily client against a real mailbox.

---

## 10. Phase 5 — M4 "V1 release"

Goal: contacts, polish to spec (theming, i18n, a11y, perf), and shipping.

### M4.1 — `@waxwing/jscontact`

Spec: FR-CON-06, tech-stack §5. Size: M.

- [ ] MIT package: JSContact (RFC 9553) ↔ vCard 4.0 (RFC 6350) conversion, both
      directions; explicit supported-property matrix documented (name components, emails,
      phones, addresses, org/title, birthday, notes, photo, groups).
- [ ] Lossless-where-possible: unknown vCard properties preserved on round-trip where
      JSContact allows, else documented as dropped.
- [ ] Test corpus: vCards from Apple/Google/Outlook exports + RFC examples.

Done when: corpus round-trips within the documented matrix; package builds standalone.

### M4.2 — Contacts area

Spec: FR-CON-01/02/04. Size: L.

- [ ] Extend `@waxwing/jmap` with RFC 9610 types (`AddressBook/*`, `ContactCard/*` incl.
      query/changes) and the sync engine + replica with contact tables (same
      account-scoped, delta-synced pattern as mail).
- [ ] Address book list incl. shared books, rights-aware (FR-CON-01).
- [ ] Contact list: search-as-you-type (local + server query), detail view; photo via
      blob (FR-CON-01).
- [ ] Create/edit/delete with progressive form — common fields visible, rest behind
      "add field" (FR-CON-02).
- [ ] Groups: create/manage; group → recipient expansion hook for the composer
      (FR-CON-04).

Done when: contact CRUD + groups round-trip against the fixture (Stalwart supports RFC
9610 natively); shared book respects read-only rights.

### M4.3 — Contacts ↔ mail integration

Spec: FR-CON-03/05/06. Size: M.

- [ ] Composer autocomplete v2: all address books + recents, ranked by usage, avatars
      from contact photos (FR-CON-03) — plugs into the M2.4 interface.
- [ ] From a message: "add sender to contacts" / "edit contact"; hover-card with contact
      info + recent-conversation link (FR-CON-05).
- [ ] Import/export: vCard 4.0 and JSContact JSON via M4.1 (file picker/download,
      duplicate handling on import) (FR-CON-06). CSV import stays backlog (Could).

Done when: autocomplete prefers a contact over a stale recent; sender-to-contact flow
round-trips.

### M4.4 — Shared accounts

Spec: FR-AUTH-08. Size: M.

- [ ] Surface non-primary accounts from the JMAP session as additional mailbox trees in
      the sidebar (visually grouped by account).
- [ ] Read/write per server-granted rights (`myRights` throughout already handles most);
      identity handling when sending from a shared account (capability-dependent —
      investigate, record findings).
- [ ] Replica/sync already account-scoped (M1.2/M1.3) — this WP is mostly UI + routing
      (`accountId` in context) + tests.

Done when: a fixture delegation setup shows the shared mailbox; actions respect rights;
primary-account UX unchanged.

### M4.5 — Theming & white-label completion

Spec: FR-THEME-01/02/03. Size: M.

- [ ] Audit: every color/radius/spacing/typography value flows from tokens; zero
      hardcoded values (lint or script check).
- [ ] `theme.css` override contract documented with an annotated example theme
      (docs/theming.md); test a full restyle without rebuild (FR-THEME-01).
- [ ] Branding completeness pass: product name, logo, favicon, accent, links everywhere
      (incl. notifications, install UI, about) (FR-THEME-02).
- [ ] Built-in accent palettes selectable by users; hoster can pin/extend via config
      (FR-THEME-03).

Done when: a demo rebrand ("Acme Mail": logo + theme.css + config) shows no Waxwing
remnants and no rebuild.

### M4.6 — i18n completion + RTL readiness

Spec: FR-I18N-01/02. Size: M.

- [ ] String extraction audit: no raw user-visible strings (automate: lint rule or
      scanner in CI).
- [ ] Full `de` translation reviewed by a native speaker (the project owner); pluralized,
      `Intl`-formatted dates/numbers/relative times everywhere.
- [ ] Locale files structured for community translation (Weblate-compatible layout,
      documented in CONTRIBUTING).
- [ ] RTL readiness: logical CSS properties audit (`margin-inline-start` etc.),
      `dir`-flip smoke test — layout must not break (FR-I18N-02; full RTL locale is
      post-V1).

Done when: language switch en↔de shows zero untranslated strings (CI check); `dir="rtl"`
smoke test renders sanely.

### M4.7 — Accessibility audit & fixes

Spec: FR-A11Y-01. Size: M.

- [ ] Automated: axe across all screens/states in CI (component + E2E level), both themes
      contrast-verified.
- [ ] Manual screen-reader passes of the three core flows — list triage, reading,
      composing — with VoiceOver (macOS/iOS) and NVDA (Windows); findings tracked and
      fixed.
- [ ] Keyboard-only walkthrough of every flow incl. DnD alternatives, focus management in
      dialogs/palette/composer.
- [ ] `prefers-reduced-motion` honored in every animation; touch targets ≥ 44 px verified.
- [ ] Record known limitations honestly in docs/accessibility.md.

Done when: WCAG 2.2 AA self-assessment documented; core flows SR-tested with issues fixed.

### M4.8 — Performance hardening

Spec: NFR-PERF-01/02/03. Size: M.

- [ ] Bundle audit: route-level code splitting verified (contacts/settings/composer lazy);
      dependency weight review; initial JS ≤ 300 KB gz **with margin**.
- [ ] Measured on target hardware profiles (mid-range laptop, throttled 4G phone
      emulation): cold interactive < 2 s / < 4 s; SW-cached < 1 s (NFR-PERF-01).
- [ ] 100 k-message list re-verified end-to-end (NFR-PERF-02); memory profile of long
      sessions (leak check: open/close 100 conversations).
- [ ] Lighthouse CI (or equivalent) added as non-blocking trend report.

Done when: numbers recorded in docs; budgets green with ≥ 15 % headroom.

### M4.9 — Release engineering

Spec: FR-DEP-01/02/05, NFR-SEC-03/04, NFR-QUAL-02, tech-stack §6. Size: L.

- [ ] Release workflow (tag-triggered): build → `waxwing-web-vX.Y.Z.tar.gz` (static
      files) + `waxwing-stalwart-vX.Y.Z.zip` (Stalwart Applications bundle, `index.html`
      at zip root, relative paths) → GitHub release with checksums (FR-DEP-01/02).
- [ ] SRI documentation for deployments where files/config could diverge (NFR-SEC-03).
- [ ] Deployment guides in docs/: (1) Stalwart Application (recommended), (2) reverse
      proxy same-origin, (3) CDN cross-origin incl. the `usePermissiveCors` trade-off
      from SP.5 (FR-DEP-05).
- [ ] `SECURITY.md` (reporting process) + threat-model document: malicious mail content,
      malicious network, shared device, hostile CDN (NFR-SEC-04).
- [ ] Compat smoke: Cyrus IMAP (JMAP) E2E smoke job to keep "any JMAP server" honest
      (NFR-QUAL-02); document known deviations.
- [ ] CONTRIBUTING.md, issue templates, `config.json` reference doc finalized against
      spec §9.
- [ ] Publish `@waxwing/jmap` and `@waxwing/jscontact` to npm (after D1 confirmation);
      README + API docs for both.
- [ ] Tag **v1.0.0**; project site/demo on GitHub Pages (decision log #1: no paid
      domains).

Done when: a stranger can deploy Waxwing on their Stalwart from the release assets using
only the guides.

**Gate G3:** release sign-off — a11y (M4.7), performance (M4.8), security docs (M4.9),
and both deployment artifacts verified on a clean Stalwart instance.

**Phase 5 exit criteria = V1 shipped.**

---

## 11. Post-V1 Backlog (V1.x parking lot)

Per spec §10 and the Could/deferred items above — **do not implement pre-V1** without an
explicit owner decision:

- Sieve filter rules UI: visual builder + raw editor (FR-SIEVE-01/02) — the headline V1.x
  feature; `@waxwing/jmap` Sieve types ship whenever first needed, at latest here.
- Saved searches as virtual folders (FR-SRCH-03 remainder).
- Snooze (FR-ORG-03), scheduled send client-side (FR-CMP-11), templates (FR-CMP-12).
- Offline search over cached subset (FR-SRCH-04).
- PWA badging (FR-NOTIF-04), notification actions (FR-NOTIF-05).
- `List-Unsubscribe` one-click (FR-RD-09), sectioned list grouping (FR-LST-08).
- Multi-account UI (FR-AUTH-07 full), unified inbox (FR-MBX-05).
- CSV contact import (FR-CON-06 remainder), auto-collected addresses (FR-CON-07).
- Community theme gallery format (FR-THEME-04).
- V2 per spec §10: Calendar, iTIP invitations, PGP, Files/Tasks integration.

## 12. Cross-cutting Workstreams (no start/end — enforced continuously)

| Workstream | Mechanism |
|---|---|
| **Size budget** | `size-limit` CI gate from P0.5; every new dependency justified in the PR |
| **i18n discipline** | en+de keys land with the feature (§2.4); extraction check automated in M4.6, applied retroactively never |
| **A11y** | component-level axe tests from M1.1; APG patterns; audits in M4.7 |
| **Security** | strict CSP from P0.2; sanitizer corpus grows with every HTML-mail bug; dependency audit (`pnpm audit`) in CI; threat model maintained from M4.9 on |
| **Testing** | levels per tech-stack §7; E2E suites grow at the end of each phase (M1.9, M2.9, M3.10); Stalwart `main` + Cyrus smoke jobs scheduled |
| **Docs & ADRs** | ADR per §2.3; deployment/config docs updated in the same PR as behavior changes |
| **Capability gating** | every optional server feature checks the session capability and degrades to hidden-not-broken (FR-SRV-02) — review in every feature PR |

## 13. Open Decisions & Owner Actions

| ID | Decision | Owner | Due | Status |
|---|---|---|---|---|
| D1 | Confirm MIT license for `@waxwing/jmap` (and `@waxwing/jscontact`) — tech-stack §4.2 "decision to confirm" | Heiko | before first npm publish (M4.9); license files land in P0.1 flagged | open |
| D2 | WebSocket in V1 core vs. post-SSE enhancement — decide on SP.3/SP.5 evidence | Heiko | Gate G1 | open |
| D3 | Raise server baseline to Stalwart v1.0 (expected ~Oct 2026)? | Heiko | Gate G2 | open |
| D4 | Secure free namespaces early: GitHub org, npm `@waxwing` scope / package names (decision log #1 recommends) | Heiko | ASAP, independent of code | open |
| D5 | Design-system sign-off (M1.1 doc: look, tokens, motion) before broad UI build-out | Heiko | during M1.1 | open |

## 14. Appendix — Requirements Coverage Matrix

Every Must/Should FR mapped to its WP (Could items → §11 backlog unless listed):

| Spec area | Requirements | Covered by |
|---|---|---|
| Deployment | FR-DEP-01/02 | P0.2, SP.5, M4.9 |
| | FR-DEP-03/04 | P0.2, M1.4 |
| | FR-DEP-05 | SP.5, M4.9 |
| | FR-DEP-06 | M3.5 |
| Server compat | FR-SRV-01/02/03 | SP.1, workstream "capability gating" |
| | FR-SRV-04 | M3.7 |
| Auth | FR-AUTH-01/02/03 | SP.2, M1.4 |
| | FR-AUTH-04 | SP.1/SP.2 |
| | FR-AUTH-05/06 | SP.2, M1.4, M3.6 (push cleanup) |
| | FR-AUTH-07 (readiness) | M1.2 (full UI → backlog) |
| | FR-AUTH-08 | M4.4 |
| Mailboxes | FR-MBX-01/02/04 | M1.5 |
| | FR-MBX-03 | M3.9 |
| List | FR-LST-01–05, 07 | M1.6, M1.4 (pane layouts) |
| | FR-LST-06 | M3.9 |
| Reading | FR-RD-01/02/03 | M1.7, M1.8 |
| | FR-RD-04/05 | M1.8 |
| | FR-RD-06/07/08 | M3.9 |
| Compose | FR-CMP-01 | M2.1 |
| | FR-CMP-02 | M2.3 |
| | FR-CMP-03 | M2.6 |
| | FR-CMP-04 | M2.7 |
| | FR-CMP-05 | M2.4 + M4.3 |
| | FR-CMP-06 | M2.5 (+M2.3 inference) |
| | FR-CMP-07/08/10 | M2.8 |
| | FR-CMP-09 | M2.2 |
| Search | FR-SRCH-01/02, 03 (part) | M3.1 |
| Organization | FR-ORG-01 | M1.3/M1.6/M1.8 |
| | FR-ORG-02/04 | M3.2 |
| Notifications | FR-NOTIF-01 | SP.3, M1.3, M1.9 |
| | FR-NOTIF-02/03 | M3.6 |
| Offline | FR-OFF-01 | M3.5 |
| | FR-OFF-02 | M1.2/M1.8, M3.4 |
| | FR-OFF-03 | M1.3, M3.3 |
| | FR-OFF-04 | M3.4 |
| Quota | FR-QTA-01 | M3.7 |
| Contacts | FR-CON-01/02/04 | M4.2 |
| | FR-CON-03/05/06 | M4.3 (+M4.1) |
| Self-service | FR-VAC-01 | M3.7 |
| | FR-SIEVE-01/02 | backlog (V1.x) |
| UI | FR-UI-01/02 | M1.1 |
| | FR-UI-03 | M1.4 |
| | FR-UI-04 | M3.8 |
| Theming | FR-THEME-01/02/03 | P0.2, M1.4, M4.5 |
| A11y | FR-A11Y-01 | M1.1, workstream, M4.7 |
| i18n | FR-I18N-01/02 | P0.2, workstream, M4.6 |
| NFR perf | NFR-PERF-01/02/03 | P0.5, M1.6/M1.9, M4.8 |
| NFR security | NFR-SEC-01/02/03/04 | P0.2, SP.2, M1.7, M4.9 |
| NFR privacy | NFR-PRIV-01/02 | M1.7/M1.8, M3.6, M4.9 (docs) |
| NFR compat | NFR-COMPAT-01/02 | P0.4, M3.5, G2 |
| NFR quality | NFR-QUAL-01/02 | P0.3/P0.5, M1.9/M2.9/M3.10, M4.9 |

## 15. Changelog

| Date | Change |
|---|---|
| 2026-07-05 | v0.1 — initial plan created from spec v0.2 + tech-stack v0.2 |
| 2026-07-05 | P0.1 **done** — repo bootstrap: git init, pnpm workspace (apps/web, 3 packages, e2e), TS 6 strict base config, Biome 2.5 (lint+format+assist), AGPL root + MIT package licenses, directory skeleton, README Development section. `install`/`typecheck`/`lint` green. |
| 2026-07-05 | **ADR-001** — adopt Vite 8 (+ @vitejs/plugin-react 6, Rolldown) instead of Vite 7; tech-stack.md updated. |
| 2026-07-05 | P0.2 **done** — app scaffold: Vite 8 + React 19 (`base: './'`), `--waxwing-*` design tokens (light/dark, WCAG AA), runtime `config.json`+`theme.css` boot loader (typed, network-first), i18next en/de lazy locales + Intl helpers, strict production CSP + documented dev delta, Lucide. Booted under a path prefix (Playwright); 80.95 KB gz initial JS. |
