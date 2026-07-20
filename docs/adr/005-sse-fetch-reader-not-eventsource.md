# 005 — SSE via a fetch-based reader, not the native EventSource

- **Status:** accepted
- **Date:** 2026-07-09
- **Deciders:** SP.3/SP.4 implementer — the technical decision is forced by the live evidence
  below (native `EventSource` and browser `WebSocket` cannot authenticate against Stalwart
  v0.16.11). **Ratified by the owner at Gate G1 (2026-07-10): D2 decided SSE-first** — WebSocket
  is deferred to a post-SSE enhancement, so the fetch-based SSE reader is the V1 push transport.

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
  order, but treat WS as a **Node/server-side** transport against Stalwart. Rather than making
  browser callers know to pass `prefer:'sse'`, `createPushChannel` performs **runtime
  failover** (SP.4): it builds the ordered list of *eligible* transports and connects them in
  turn, and when a transport never reaches `open` after a small attempt budget it degrades to
  the next one on its own. In a browser against Stalwart, WS is eligible (the capability
  advertises `supportsPush:true`) but its handshake 401s and closes abnormally forever, so the
  facade discovers this at runtime and falls over to the fetch-based SSE reader with **no
  caller involvement**. Whether WS becomes a V1-core browser transport is **decision D2**, the
  owner's call at Gate G1 — this ADR records the evidence, it does not decide D2.

### Amendment (2026-07-20, G2 gap B4) — the browser *excludes* WebSocket, it does not merely deprioritise it

D2 was ratified at G1 ("SSE-first") and then **never reached the code**: `engine.ts` called
`createPushChannel` with no preference at all, so every browser login still paid the runtime
failover — measured live, a WS attempt at 85 ms → 401 → close, a second at 584 ms → 401 →
close, and the SSE request only at 586 ms. Two console errors and ~500 ms of delayed push per
login, on every session, for a decision that had been made a milestone earlier.

**The obvious fix is actively harmful, and this is the load-bearing part of the amendment.**
The paragraph struck above recommended `prefer:'sse'`. But `prefer` **reorders and never
restricts** (`packages/jmap/src/push/channel.ts`, `transportOrder`), so it yields
`['sse','websocket','polling']` — and that is strictly worse than doing nothing:

- today SSE is the **last real** transport, `hasRealFailoverTarget()` is false, and a
  transient SSE failure at login retries forever until it heals;
- with `prefer:'sse'`, WebSocket sits *behind* SSE, so SSE acquires a failover target it does
  not have today. Two pre-open SSE errors spend the budget, `advance()` lands on the
  un-authable WebSocket — which is itself terminal, since only the polling stub follows it —
  and push is **permanently dead** for that session instead of self-healing.

This is not reasoned, it is measured: substituting `prefer:'sse'` into the new regression test
yields `expected 'websocket' to be 'sse'`. Worse, `channel.test.ts` carries a test named
*"reorders (does not restrict) for an explicit prefer"* — so the one-line fix the plan
prescribed would have shipped **green**.

**Decision:** add a genuinely restrictive `CreatePushChannelOptions.transports` allowlist to
`@waxwing/jmap`, applied before the eligibility filter so an excluded transport is absent from
the failover chain rather than merely deprioritised, and have the app pass
`BROWSER_PUSH_TRANSPORTS = ['sse','polling']` (`apps/web/src/sync/engine/engine.ts`). `prefer`
orders; `transports` restricts; they are separate concepts and the option's doc-comment says
why. `'polling'` is permitted regardless of the allowlist, so the resulting set is never empty
and an allowlist can never silently produce a dead channel.

The **library default is deliberately unchanged** (WS → SSE → polling). `packages/jmap` is MIT
and published for third-party consumption; the browser's inability to authenticate a WebSocket
is a property of the *browser*, not of the library, so the app states its own constraint
rather than the package narrowing its default for everyone. `push.integration.test.ts` still
exercises the default WS → SSE degradation, untouched.

The exclusion is hardcoded rather than made a hoster config knob, for the same reason: it
follows from the browser API, not from the deployment. D2's revisit trigger — a server shipping
a browser-viable WS auth path — points at `BROWSER_PUSH_TRANSPORTS` as the one place
capability detection would go.

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
  Stalwart v0.16.11 is SSE. The auto-selector reaches it by **runtime failover** (SP.4): the
  doomed WS attempt is detected (it 401s and never opens) and the channel degrades to SSE
  without the caller passing `prefer`. Once a transport *does* open, its own reconnect loop
  owns every subsequent drop and the facade never downgrades; and the last real transport
  (SSE in the browser) is never torn down onto the non-functional polling stub, so a transient
  startup blip self-heals rather than permanently killing push. Reaching *browser WS* still
  needs an upstream Stalwart change (a browser-viable WS auth path) — tracked with D2.
  **Since the 2026-07-20 amendment the doomed attempt is not made at all**: the browser never
  constructs a WebSocket, so the two 401s and the ~500 ms delay are gone rather than merely
  survived. The self-healing property above is now guaranteed **by construction** — with
  `['sse','polling']` SSE is last-real and `hasRealFailoverTarget()` is false — instead of
  depending on the accident that WebSocket happened to sort first. Runtime failover is retained
  underneath as the safety net; it is no longer the discovery mechanism.
- tech-stack §4.2 and FR-NOTIF-01 are updated to note the fetch-based SSE reader and the
  Stalwart WS-auth limitation; the requirement itself (SSE fallback, WS-preferred
  auto-select, reconnect/backoff) is unchanged.
- The push module stays zero-dep and tree-shakable (`sideEffects:false`); it adds nothing to
  the `apps/web` budget until the sync engine imports it (M1.3).
