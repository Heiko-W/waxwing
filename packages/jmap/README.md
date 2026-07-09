# @waxwing/jmap

Typed JMAP client for Waxwing: session handling, batched method calls with
back-references, request chunking, blob transfer, and WebSocket/EventSource push.

**License: MIT** — pending confirmation of decision **D1** (implementation-plan.md §13)
before the first npm publish.

Zero runtime dependencies. Works in the browser and in Node ≥ 22. `fetch`, `WebSocket` and
timers are injectable so units stay hermetic.

## Push transports (SP.3, FR-NOTIF-01)

Live `StateChange` delivery over two transports plus capability-based auto-selection:

```ts
import { connect, createPushChannel, bearer } from '@waxwing/jmap'

const client = await connect('https://mail.example.com', bearer(token))

const channel = createPushChannel(client.session, {
  auth: bearer(token),
  prefer: 'sse', // browsers targeting Stalwart should prefer SSE — see the auth note below
})
channel.subscribe((change) => {
  // change.changed[accountId] === { Email: 'newState', Mailbox: 'newState', … }
  // re-sync the affected types with Foo/changes using those state strings.
})
channel.onStatus((status) => {}) // connecting | open | reconnecting | closed
channel.onError((error) => {})
channel.open()
// …later
channel.close()
```

Or construct a specific transport directly: `new SseChannel({ session, auth })`,
`new WebSocketChannel({ session, auth, dataTypes })`. The `WebSocketChannel` also does a typed
`Request`/`Response` round-trip over the socket via `channel.request()` — the same builder API
as `JmapClient`.

### Auth mechanisms (measured against Stalwart v0.16, SP.3 probe)

- **SSE** uses a **fetch-based reader**, not the native `EventSource`. Stalwart's SSE endpoint
  authenticates *only* via the `Authorization` header, and the native `EventSource` API cannot
  set headers — so it can never authenticate. The reader parses the SSE wire format itself
  (multi-line `data:`, `event:`/`id:`/`retry:`, CR/LF/CRLF, split frames, BOM). A
  `?access_token=` query mode exists behind `sseAuth: 'query'` for *other* servers that support
  it (Stalwart 401s on it).
- **WebSocket (RFC 8887)** authenticates via the `Authorization` header on the Upgrade. Browsers
  cannot set that header on a `WebSocket`, and Stalwart offers no query/subprotocol token
  fallback, so **against Stalwart the WS transport is Node/server-side only** (undici forwards
  the header); browsers use SSE. It works browser-side against any server that accepts an
  unauthenticated or cookie-authenticated WS.
- **Reconnect** is exponential backoff with full jitter (cap 30 s), reset on a healthy
  connection, race-free `close()`. After any reconnect the client must re-sync via `Foo/changes`
  (Stalwart does not support SSE `Last-Event-ID` resumption).
- **CORS:** Stalwart emits no CORS headers by default, so a cross-origin fetch/SSE reader is
  blocked — serve Waxwing same-origin (FR-DEP-02) or add permissive CORS.

### Instrumented demo

`scripts/push-demo.mjs` (repo root, dependency-free Node) opens both transports against a
running fixture, delivers a mail, and prints the per-transport `StateChange` latency:

```sh
pnpm e2e:server              # bring the Stalwart fixture up
node scripts/push-demo.mjs   # → WebSocket ~3 ms, SSE ~3 ms
pnpm e2e:server:down         # tear it down
```

## Tests

- Hermetic units: `pnpm test` (mocked fetch/WebSocket/timers; no network).
- Live integration: `pnpm --filter @waxwing/jmap test:integration` against the fixture
  (`pnpm e2e:server`) — SP.1 session/mail/blob and SP.3 push (both transports deliver
  `StateChange` and reconnect across a container restart). Auto-skips when the fixture is down.
