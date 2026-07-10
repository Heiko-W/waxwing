# 007 — Own hash-free router; React context for app state (no react-router, no Zustand yet)

- **Status:** accepted
- **Date:** 2026-07-10
- **Deciders:** M1.4 implementer. tech-stack.md names Zustand for "ephemeral/view state only"
  but lists **no** router; this ADR fills that gap and records why M1.4 introduces neither
  dependency. Not a deviation from a stated decision — a decision the stack left open.

## Context

M1.4 (app shell) needs client-side routing (`/mail/:mailboxId?/:emailId?`, `/contacts`,
`/settings/*`, hash-free, base-path-safe, lazy route chunks) and a place to hold app-level
state (the connect/onboarding flow and the connected `JmapClient` for M1.5/M1.6). Two library
choices were on the table: **react-router-dom** (~20 KB gz) for routing and **Zustand**
(~3 KB gz, already earmarked in the stack) for state.

Load-bearing constraints:

- The app must resolve links under an arbitrary mount prefix — Stalwart rewrites `<base href>`
  to e.g. `/mail/` (FR-DEP-02). The basename is only known at runtime from `document.baseURI`;
  the rest of the boot path (`config.ts`, `computeRedirectUri` in auth) already keys off it.
- Every dependency "pays rent" against the ≤ 300 KB gz budget (tech-stack §2.2), and the app's
  established ethos is to own its minimal primitives (own JMAP client, own auth, own
  Portal/focus-trap/design-system).
- The route set is closed and tiny (3 patterns); app-level state is low-frequency (a handful of
  transitions per sign-in) and the `JmapClient` is a stable reference.

## Decision

1. **Ship a ~70-line custom History-API router** (`apps/web/src/app/route/`): a pure,
   DOM-free core (`route.ts`: `deriveBase`, `toHref`/`toPath`, `matchRoute`) plus a thin React
   layer (`RouterProvider` + `useRoute`/`useNavigate`, and a `Link` that renders a real
   `<a href>` and only intercepts an unmodified left-click). The base is derived from
   `document.baseURI`, so `Link to="/contacts"` resolves to `/mail/contacts` under a `/mail/`
   mount. `/contacts` and `/settings` are `React.lazy` chunks behind one `<Suspense>` (mail is
   the eager primary), realizing NFR-PERF-03; `.size-limit.js` now measures the entry chunk
   (`index-*.js`) so those on-demand chunks don't count against the initial budget.
   **Not react-router:** its ~20 KB buys nothing here, and its `basename` plumbing is an
   awkward fit for a runtime-derived base that our own `deriveBase` handles in one line.

2. **Use React context + `useReducer` for app state; do NOT add Zustand in M1.4.** The session
   lifecycle lives in a `SessionProvider` (pure transitions in a tested reducer; impure
   orchestration in the provider); routing state lives in the router context. Zustand's slot in
   the stack is for genuinely high-frequency *view* state — the virtualized message list's
   selection/scroll (M1.6) — where context re-renders would bite. Introduce it there, measured,
   not speculatively for the low-frequency session state.

## Consequences

- **+** No new runtime dependency; the entry chunk stays lean and fully under our control,
  including the base-path behavior that is a hard FR-DEP-02 requirement.
- **+** The router core and the session reducer are pure and unit-tested without a DOM.
- **−** We maintain a (small) router ourselves. Mitigation: it is ~70 lines with a focused test
  suite; the route surface is intentionally closed.
- **−** Deep-link refresh (`GET /mail/contacts`) needs a server-side SPA history fallback to
  serve `index.html`. This is a **deployment** requirement, not a client bug: the Vite dev
  server does it by default, and SP.5 verified Stalwart's Applications mount serves an
  unconditional SPA fallback. Documented for the M4.9 deployment guides.
- **−** Manual **cross-origin** OAuth reconnect-after-reload needs the connect URL, which the
  auth `SecretStore` does not persist; M1.4 persists the last `ConnectTarget` to `localStorage`
  (the host is not a secret) so this works. Same-origin (the primary deployment) is unaffected.
- **Revisit** the router if the route set grows materially, and Zustand at M1.6 when the list
  view-state lands.
