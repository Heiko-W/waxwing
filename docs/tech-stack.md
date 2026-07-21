# Waxwing — Technology Stack & Architecture

| | |
|---|---|
| **Project** | Waxwing — a serverless webmail client for JMAP |
| **Version** | 0.2 |
| **Date** | 2026-07-05 |
| **Companion** | [functional-specification.md](./functional-specification.md) |

---

## 1. Architecture Overview

Waxwing has exactly one moving part: a static single-page application running in the
browser. Everything else is the JMAP server.

```
┌─────────────────────────── Browser ────────────────────────────┐
│                                                                │
│  ┌──────────── Waxwing SPA (static files) ──────────┐          │
│  │                                                  │          │
│  │  UI (React) ── reads ──► Local replica (Dexie /  │          │
│  │     │                    IndexedDB, liveQuery)   │          │
│  │     │ writes                    ▲                │          │
│  │     ▼                           │                │          │
│  │  Action queue ───► Sync engine ─┘                │          │
│  │  (offline outbox)      │                         │          │
│  │                        ▼                         │          │
│  │              @waxwing/jmap client                │          │
│  │   (typed JMAP core • WebSocket/SSE push • blobs) │          │
│  └───────────────────────┬──────────────────────────┘          │
│  Service worker: precache, notifications, badge                 │
└──────────────────────────┼─────────────────────────────────────┘
                           │ HTTPS / WSS (JSON)
                           ▼
                 ┌───────────────────┐
                 │  Stalwart (JMAP)  │  ← also serves the static
                 │  or any RFC 8620/ │    files via "Applications",
                 │  8621 server      │    or files come from a CDN
                 └───────────────────┘
```

**Data flow principle (local-first):** the UI never renders from network responses
directly. The sync engine maintains a partial replica of server state in IndexedDB
(keyed by JMAP state strings); the UI subscribes to the replica via live queries. User
actions write to an outbox queue that the sync engine replays against the server —
online instantly, offline on reconnect. Push events (WebSocket/EventSource) trigger
delta fetches (`Email/changes`, `Mailbox/changes`, `Thread/changes`, …). This one
decision buys offline support, instant UI, crash-safety, and multi-tab consistency
(single sync engine via `Web Locks`/`BroadcastChannel`).

## 2. Constraints That Shape the Stack

1. **Static-only** — no SSR, no Node runtime, no API routes. This rules out Next.js and
   is deliberate: the existing Stalwart webmails (Bulwark, root-fr/jmap-webmail) already
   occupy the full-stack-Next.js niche; Waxwing's reason to exist is that it doesn't need a
   container.
2. **Performance budget** — ≤ 300 KB gzipped initial JS (NFR-PERF-01). Every dependency
   pays rent.
3. **AGPL-3.0** app code; all dependencies must be AGPL-compatible (MIT/Apache/BSD/ISC).
4. **Contributor-friendly** — mainstream tools over exotic ones wherever quality is
   equal; this is a community project.

## 3. Stack Summary

| Layer | Choice | Notes |
|---|---|---|
| Language | **TypeScript** (strict) | end to end |
| UI framework | **React 19** + **Vite 8** (see ADR-001) | see §4.1 |
| JMAP client | **`@waxwing/jmap`** (own package) | see §4.2 — no existing lib suffices |
| Local store / sync | **Dexie 4** (IndexedDB) + own sync engine | liveQuery → UI |
| UI state | **Zustand** | ephemeral/view state only |
| Compose editor | **Squire** (`squire-rte`) | Fastmail's email editor, see §4.4 |
| HTML mail rendering | **DOMPurify** + sandboxed `iframe` | see §4.5 |
| Lists | **TanStack Virtual** | headless virtualization |
| Styling | CSS Modules + **design tokens** (CSS custom properties) | see §4.6 |
| Icons | **Lucide** | MIT, tree-shakable |
| i18n | **i18next** (lazy-loaded JSON locales) | Weblate-friendly |
| Auth | **oauth4webapi** (OAuth 2.0 Code + PKCE) | Basic-auth fallback |
| PWA | **vite-plugin-pwa** (Workbox) | precache + notification SW (Web Push blocked upstream — ADR-010) |
| MIME fallback | **postal-mime** (lazy-loaded) | only if server lacks `Email/parse` |
| Tests | **Vitest**, Testing Library, **Playwright** | E2E vs. real Stalwart (Docker) |
| Lint/format | **Biome** | one fast tool |
| Package/build | **pnpm** workspaces, GitHub Actions | size budgets enforced (size-limit) |

## 4. Key Decisions & Rationale

### 4.1 React 19 + Vite (not Svelte/Solid, not Next.js)

- **Why React:** largest contributor pool by far — decisive for an AGPL community
  project; first-class ecosystem fits our exact needs (TanStack Virtual, Dexie's
  `dexie-react-hooks`, mature a11y tooling); React 19 compiler-era performance is
  sufficient — our hot path (scrolling huge lists) is handled by virtualization, not by
  framework render speed.
- **Why not Svelte 5 / SolidJS:** genuinely smaller/faster baselines, but the bundle
  delta (~35–60 KB gz) fits inside our budget, is paid once (service-worker cached), and
  doesn't outweigh the ecosystem/contributor advantage. Revisit only if budgets break.
- **Why not Next.js et al.:** SSR/server components contradict the product (§2.1). Vite
  builds a plain static bundle, supports `base`-path-relative builds (required for
  Stalwart's `<base href>` rewriting, FR-DEP-02), and is the ecosystem default for SPAs.

### 4.2 Own JMAP client package: `@waxwing/jmap`

Survey result (July 2026): no existing TS library covers our requirements —
`jmap-jam` (active, well-typed, ~2 KB) has SSE but **no WebSocket (RFC 8887)**, bearer
auth only, mail-only; `jmap-client-ts` is stale, no push; `jmap-kit` explicitly excludes
all push; nothing types Contacts (RFC 9610), Sieve (RFC 9661), Quota or
VacationResponse. **No JS library implements JMAP-over-WebSocket at all.**

So Waxwing ships its own thin client as a separate package:

- Typed method calls + batching + back-references (`$ref`) for: Core, Mail, Submission,
  Identity, VacationResponse, Blob (RFC 9404), Quota (RFC 9425), Sieve (RFC 9661),
  Contacts (RFC 9610); capability-gated.
- Transports: `fetch` + **WebSocket (RFC 8887, incl. push)** + SSE fallback, with
  reconnect/backoff. **SSE is a fetch-based reader** (`fetch` + `ReadableStream` sending the
  `Authorization` header), **not** the native `EventSource` API — Stalwart authenticates its
  SSE endpoint only via the `Authorization` header, which `EventSource` cannot set (ADR-005).
  Against Stalwart v0.16.11 the browser `WebSocket` likewise cannot authenticate (no header),
  so WS is a Node/server-side transport there. **Browsers are SSE-first by construction**
  (decision D2, implemented in G2/B4): the app passes a transport **allowlist**
  (`transports: ['sse','polling']`) to `createPushChannel`, so the doomed WS attempt is never
  constructed at all. `prefer` is *not* the mechanism and must not be used for this — it
  reorders without restricting, which would leave WebSocket in the chain *behind* SSE and hand
  a transient SSE failure a path onto the un-authable transport, permanently (ADR-005, amended
  2026-07-20). Runtime failover remains underneath as the safety net, not as the discovery
  mechanism. The library default (WS → SSE → polling) is unchanged for third-party consumers.
- Session handling (`/.well-known/jmap`), upload/download URL templating, request
  chunking against session limits (FR-SRV-03).
- Zero runtime deps; `jmap-rfc-types` and `jmap-jam` (MIT) serve as references.
- **Licensed MIT** (unlike the AGPL app) and published to npm — deliberately, so the
  wider ecosystem adopts it; it would be the first WebSocket-capable JMAP client in JS,
  which is good for Waxwing's visibility. *(Decision to confirm.)*

### 4.3 Sync engine & offline

- One writer: a `Web Locks`-elected leader tab (or the service worker context where
  available) runs sync; other tabs read the same IndexedDB and get change events via
  `BroadcastChannel`.
- Delta sync via `*/changes` + `Email/queryChanges` per watched query; full re-query on
  `cannotCalculateChanges`.
- Outbox entries are idempotent JMAP `set` intents with client-generated creation ids;
  replay uses `ifInState` where appropriate; conflicts → surfaced per FR-OFF-03.
- Cache policy per FR-OFF-02/04 (windowed index + opened bodies, LRU eviction,
  `navigator.storage.persist()` requested on install).

### 4.4 Composer: Squire

Squire is Fastmail's own production editor, purpose-built for email: it keeps **HTML as
the source of truth** instead of a normalizing document schema — which is exactly what
reply/forward needs, because quoted third-party HTML must survive round-trips
unmangled. ProseMirror-family editors (TipTap) and Lexical enforce schemas that strip
or normalize arbitrary quoted markup unless heavily extended; nobody demonstrably runs
them for quoted-reply email at scale, while Squire powers Fastmail, ProtonMail, Tutanota
and Zoho Mail. It's 16 KB min+gz, zero dependencies, actively maintained, MIT. We wrap
it in a thin React component and add: toolbar, inline-image (blob upload → `cid:`),
signature blocks, quote folding, plain-text mode (generated alternative per FR-CMP-01).

### 4.5 Rendering untrusted HTML mail

Defense in depth, in order:

1. **Sanitize** with DOMPurify (hooks additionally rewrite/strip `src`, `srcset`,
   `style` `url()` for remote-content blocking per FR-RD-02; `cid:` URLs rewritten to
   JMAP `downloadUrl` blob links; DOM-clobbering protections on).
2. **Isolate** in `<iframe sandbox="allow-same-origin-less">` via `srcdoc` — hard
   security boundary, own document, no script, no top navigation, `csp` attribute where
   supported; height auto-sizing via ResizeObserver messaging.
3. **App-level strict CSP** (no inline script/eval) as the outer wall; link clicks are
   intercepted and re-dispatched with `noopener` + visible target host (NFR-SEC-01,
   FR-RD-08).

No client-side MIME parsing is needed for display: JMAP servers deliver decoded
`bodyValues`/`htmlBody` (RFC 8621 §4.1.4), and attached `message/rfc822` parts are
parsed server-side via `Email/parse`. `postal-mime` is a lazy-loaded fallback only
(e.g. local `.eml` preview, servers without `Email/parse` — verify Stalwart's support
in the first spike).

### 4.6 Styling & theming

- **Design tokens as CSS custom properties** on `:root` (`--waxwing-accent`, `--waxwing-bg`,
  spacing/radius/typography scales), consumed everywhere; light/dark = two token sets
  behind `prefers-color-scheme` + manual override class.
- **CSS Modules** for component styles — stable, semantic, inspectable class names and
  zero runtime cost. (Tailwind was considered; token-override theming and
  readable-for-theme-authors markup favor semantic CSS here.)
- White-labeling per FR-THEME-01/02: `theme.css` (token overrides) and `config.json`
  branding are fetched at boot from the deployment directory — rebranding without
  rebuild.

### 4.7 Auth

- OAuth 2.0 Authorization Code + PKCE via **oauth4webapi** against Stalwart's built-in
  OIDC provider (RFC 8414 discovery; Stalwart requires no client pre-registration by
  default; when `requireClientRegistration` is on, the client id is deployment config).
- Access token in memory; refresh token in IndexedDB wrapped by a **non-extractable
  WebCrypto key** — raises the bar for exfiltration; the honest primary defense against
  XSS is the strict CSP (documented in the threat model, NFR-SEC-04).
- Basic-auth fallback (FR-AUTH-04) uses the same code path as bearer via an auth-scheme
  abstraction in `@waxwing/jmap`.

## 5. Repository Layout

```
waxwing/
├── apps/
│   └── web/                  # the SPA (AGPL-3.0)
│       ├── public/           # manifest, icons, default config.json, theme.css
│       └── src/
│           ├── app/          # shell, routing, command palette
│           ├── features/     # mail/, contacts/, settings/, sieve/, onboarding/
│           ├── sync/         # sync engine, outbox, replica schema (Dexie)
│           ├── ui/           # design system components + tokens
│           └── sw/           # service worker (push, precache hooks)
├── packages/
│   ├── jmap/                 # @waxwing/jmap — typed JMAP client (MIT)
│   ├── jscontact/            # JSContact ↔ vCard 4 conversion (MIT)
│   └── mail-html/            # sanitizer pipeline + iframe renderer (AGPL)
├── e2e/                      # Playwright suites + Stalwart docker-compose fixture
└── docs/                     # this spec, ADRs, deployment guides
```

## 6. Build, Release & Deployment

- **Artifacts per release (CI):**
  1. `waxwing-web-vX.Y.Z.tar.gz` — plain static files for any web server/CDN.
  2. `waxwing-stalwart-vX.Y.Z.zip` — Stalwart *Applications* bundle (`index.html` at zip
     root, relative asset paths so Stalwart's `<base href>` rewrite works). Hosters
     point Stalwart's application `resourceUrl` at the GitHub release asset and mount
     it at e.g. `/mail` — Stalwart then serves and auto-updates the webmail itself.
- **App updates:** service worker updates in the background; unobtrusive "reload for
  update" toast. `config.json`/`theme.css` are fetched network-first (never baked into
  the precache) so hoster changes apply without a release.
- **Deployment guides** (docs/): Stalwart Application (recommended, same-origin, zero
  CORS), reverse proxy same-origin, CDN cross-origin (requires Stalwart
  `usePermissiveCors: true` — all-or-nothing today; guide explains the trade-off and
  the reverse-proxy alternative for per-origin CORS).
- **CI (GitHub Actions):** typecheck, Biome, unit/component tests, Playwright E2E
  against the pinned Stalwart Docker image, bundle-size budget gate, release packaging.

## 7. Testing Strategy

| Level | Tooling | Focus |
|---|---|---|
| Unit | Vitest | sync engine (state strings, conflict/replay), JMAP client (chunking, back-refs), sanitizer pipeline, JSContact↔vCard |
| Component | Vitest + Testing Library | composer, list virtualization, a11y (axe) |
| E2E | Playwright + Stalwart in Docker | login (OAuth + Basic), send/receive round-trip, push updates, offline outbox (network throttling), PWA install/manifest |
| Compat | scheduled CI matrix | latest Stalwart release + `main`; smoke tests vs. Cyrus (keeps the "any JMAP server" promise honest) |
| CSS (static) | Vitest, Node project | token references resolve, theme blocks agree, focus outlines are never suppressed without a replacement or a reasoned exemption (ADR-015) |

**Stylesheet tests read from disk, so they run in the Node project, not jsdom.**
`apps/web/src/ui/**/*.css.test.ts` (and the older `*.contrast.test.ts`) are collected by the
root `vitest.config.ts`, because vitest stubs `.css` imports to empty under jsdom and jsdom
computes no CSS at all. Both `vitest.config.ts` files must be edited together — the include
*and* the exclude — or these files are collected twice. jsdom's CSS blindness is the reason
this whole row exists: it is why `expectNoA11yViolations` cannot see a missing focus ring, and
why every defect in that class so far was found by a person reading a stylesheet (ADR-015).

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Stalwart pre-1.0 config/schema churn (v1.0 expected ~Oct 2026) | deploy docs break | **baseline is v0.16** (the only line testable today, NFR-COMPAT-02); pin the tested version in CI, additionally smoke-test against Stalwart `main`; raise the baseline to v1.0 only if it ships changes Waxwing needs |
| JMAP Calendars still an IETF draft | V2 calendar rework | V1 ships without calendar (by design); Contacts is a published RFC (9610) — safe |
| No prior art for JS JMAP-over-WebSocket | unknown edge cases | build on SSE first (proven), add RFC 8887 as enhancement; it's a small framed protocol |
| Safari/iOS PWA limits (push only when installed, storage eviction) | degraded iOS UX | `storage.persist()`, in-app install guidance, EventSource fallback while open |
| **Web Push (RFC 9749/VAPID) support is sparse** — no JMAP server signed one at all until Stalwart v0.16.14 (2026-07-20), which also fixed its base64-wrapped aes128gcm body | background push impossible on every browser wherever the server lacks RFC 9749; where the server has it, Waxwing's client half is still unbuilt | notifications sourced from the live SSE channel while the app runs (all browsers); capability probe + honest in-app statement, which now distinguishes "this server cannot" from "this server can, we do not yet"; upstream bug reports (acted on). **ADR-010 + amendment** — reversing it is an open owner decision |
| Stalwart CORS is all-or-nothing | cross-origin deployments weaken posture | recommend same-origin (Applications); document proxy pattern; upstream feature request for per-origin CORS |
| Official Stalwart webmail (Rust/Dioxus) planned post-1.0 | competition | different lane: web-native TS, community-owned, any-JMAP-server; our MIT `@waxwing/jmap` package builds goodwill either way |
| Squire is contenteditable-based (quirks) | composer bugs | it's the most battle-tested email editor in existence (Fastmail/Proton/Tutanota/Zoho); wrap behind our own component API so it stays swappable |

## 9. First Implementation Milestones (proposal)

> Elaborated in detail in **[implementation-plan.md](./implementation-plan.md)** — the
> authoritative, work-package-level roadmap (phases, dependencies, status board).

1. **Spike (1–2 weeks):** `@waxwing/jmap` core + login (OAuth PKCE vs. local Stalwart
   Docker) + raw mailbox/message list. Validates auth, CORS, `Email/parse`, WebSocket.
2. **M1 "read":** replica + sync engine, folder tree, virtualized list, safe HTML
   reading, push live-updates.
3. **M2 "write":** composer (Squire), drafts, send, attachments, identities.
4. **M3 "daily driver":** search, keywords, offline outbox, PWA install + Web Push,
   settings, vacation responder.
5. **M4 "V1":** contacts (RFC 9610) + autocomplete, theming/white-label, i18n (en/de),
   a11y pass, docs — release. (Sieve rules UI follows in V1.x per the spec's decision
   log; `@waxwing/jmap` ships the Sieve types from day one.)
