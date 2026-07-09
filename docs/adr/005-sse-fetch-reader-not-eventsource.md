# 005 — SSE via a fetch-based reader, not the native EventSource

- **Status:** accepted
- **Date:** 2026-07-09
- **Deciders:** SP.3 implementer; ratified by project owner at Gate G1

## Context

FR-NOTIF-01 requires live updates over JMAP push with **WebSocket (RFC 8887) preferred,
EventSource fallback, polling last resort**. tech-stack §4.2 restates this as
"Transports: `fetch` + WebSocket (RFC 8887, incl. push) + EventSource fallback." Both name
the browser **`EventSource`** API as the SSE transport.

SP.3 probed the pinned fixture (Stalwart v0.16.11-alpine) to settle the SP.3/SP.5 open
question — "EventSource cannot send an `Authorization` header; what auth does Stalwart's SSE
accept?" — and found:

- Stalwart's `eventSourceUrl` (`/jmap/eventsource/`) authenticates **only** via the HTTP
  `Authorization` header (Bearer or Basic). `?access_token=<token>` and `?token=<token>`
  query params → **401**; there is **no** session cookie (neither `/login` nor `/api/auth`
  sets one) → cookie auth is impossible; no auth → 401.
- The native `EventSource` DOM API cannot set request headers, so it can **never**
  authenticate against Stalwart — `?access_token=`, the usual `EventSource` work-around, is
  rejected.
- The RFC 8887 WebSocket endpoint is the same: it accepts only the `Authorization` header on
  the Upgrade; browsers cannot set that header on a `WebSocket`, and Stalwart offers no
  query-param or subprotocol token fallback (all → 401). So **against Stalwart v0.16.11 the
  browser `WebSocket` cannot authenticate at all** either.
- Stalwart emits **no** CORS headers by default (OPTIONS preflight → 204, zero
  `Access-Control-Allow-*`).

The literal transports named in the specs therefore cannot carry authenticated push from a
browser against Stalwart: native `EventSource` cannot send the required header, and browser
`WebSocket` cannot either.

## Decision

- Implement the SSE fallback as a **fetch-based reader** — `fetch()` with a `ReadableStream`
  `getReader()` and a WHATWG-compliant SSE frame parser (`packages/jmap/src/push/sse.ts`,
  `sse-parser.ts`) — sending `Authorization: Bearer <token>` (or `Basic`). This is standards
  SSE on the wire (`text/event-stream`); only the client API differs from `EventSource`. A
  `sseAuth:'query'` mode (`?access_token=`) exists behind an explicit option for servers that
  prefer it; the default is `header`.
- Extend the SP.1 auth-scheme abstraction with an **optional `AuthProvider.token()`**
  (implemented by `bearer()`, not `basic()`) so the reader can obtain the bearer value for
  the header or the query mode. Additive: existing `bearer()`/`basic()` callers are
  unaffected. `JmapRequestError` (RFC 8887 §4.2) is added to the error hierarchy for the WS
  Request/Response path.
- Keep the RFC 8887 **WebSocket** client and the FR-NOTIF-01 WS→SSE→polling auto-select
  order, but treat WS as a **Node/server-side** transport against Stalwart; browser callers
  targeting Stalwart select SSE (`prefer:'sse'`) because WS cannot authenticate there. Whether
  WS becomes a V1-core browser transport is **decision D2**, the owner's call at Gate G1 —
  this ADR records the evidence, it does not decide D2.

## Consequences

- **A fetch-based SSE reader is subject to CORS** exactly like any `fetch` (native
  `EventSource` would be too). With Stalwart's default no-CORS config this means push works
  only **same-origin** (the recommended Applications mount, FR-DEP-02) or with
  `usePermissiveCors` / a CORS-adding reverse proxy — the FR-DEP-05 trade-off, now confirmed.
- **No `Last-Event-ID` resumption:** Stalwart never emits an SSE `id:` and ignores a stale
  `Last-Event-ID`, so after any reconnect the client must re-sync via `*/changes` using the
  per-type states carried in `StateChange.changed`. This shapes M1.3's sync strategy.
- **Browser WS is blocked against Stalwart today.** FR-NOTIF-01's "WebSocket preferred" is
  honored by the capability-based auto-select, but the effective browser transport against
  Stalwart v0.16.11 is SSE. Reaching browser WS needs an upstream Stalwart change
  (a browser-viable WS auth path) — tracked with D2.
- tech-stack §4.2 and FR-NOTIF-01 are updated to note the fetch-based SSE reader and the
  Stalwart WS-auth limitation; the requirement itself (SSE fallback, WS-preferred
  auto-select, reconnect/backoff) is unchanged.
- The push module stays zero-dep and tree-shakable (`sideEffects:false`); it adds nothing to
  the `apps/web` budget until the sync engine imports it (M1.3).
