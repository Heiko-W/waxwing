import { describe, expect, it } from 'vitest'
import { bearer } from '../auth'
import { makeSession } from '../test-support'
import type { FetchLike } from '../transport'
import type { Session } from '../types/core'
import type { StateChange } from '../types/push'
import {
  createPushChannel,
  eligibleTransports,
  FailoverPushChannel,
  pickTransport,
} from './channel'
import type { SseConnection } from './test-support'
import {
  FakeScheduler,
  failingWebSocketFactory,
  fakeWebSocketFactory,
  sessionFetchMock,
  sseFetchMock,
  tick,
} from './test-support'
import type { PushStatus } from './types'

/** A session with the RFC 8887 WebSocket capability added (WS + SSE both eligible). */
function withWebSocket(): Session {
  const session = makeSession()
  return {
    ...session,
    capabilities: {
      ...session.capabilities,
      'urn:ietf:params:jmap:websocket': { url: 'ws://mail.test/jmap/ws', supportsPush: true },
    },
  }
}

/** A session advertising the WebSocket capability but with push disabled (RFC 8887 §3). */
function withWebSocketNoPush(): Session {
  const session = makeSession()
  return {
    ...session,
    capabilities: {
      ...session.capabilities,
      'urn:ietf:params:jmap:websocket': { url: 'ws://mail.test/jmap/ws', supportsPush: false },
    },
  }
}

/** A session with neither a WebSocket capability nor an eventSource URL. */
function pollingOnly(): Session {
  return { ...makeSession(), eventSourceUrl: '' }
}

const auth = bearer('tok')

/**
 * An SSE fetch mock whose first `failures` connects reject outright, after which it behaves like
 * {@link sseFetchMock}. Models a transient blip at startup (the server restarting mid-login, a
 * CORS hiccup, a flaky network at boot) — the scenario in which a *reordering* transport fix
 * strands push on the un-authable WebSocket instead of letting SSE retry itself back to health.
 */
function flakySseFetchMock(failures: number): {
  fetch: FetchLike
  connections: SseConnection[]
  attempts: { count: number }
} {
  const healthy = sseFetchMock()
  const attempts = { count: 0 }
  const fetch: FetchLike = (url, init) => {
    attempts.count++
    if (attempts.count <= failures) return Promise.reject(new Error('SSE connect failed'))
    return healthy.fetch(url, init)
  }
  return { fetch, connections: healthy.connections, attempts }
}

/** The SSE wire frame the fetch mock hands back once a subscriber is attached. */
const STATE_FRAME =
  'event: state\ndata: {"@type":"StateChange","changed":{"b":{"Email":"s1","Mailbox":"s1"}}}\n\n'

describe('pickTransport', () => {
  it('prefers WebSocket when advertised and a factory is available', () => {
    const { factory } = fakeWebSocketFactory()
    expect(pickTransport(withWebSocket(), { auth, WebSocket: factory })).toBe('websocket')
  })

  it('falls back to SSE when there is no WebSocket capability', () => {
    // makeSession() advertises core+mail (no websocket) but has an eventSourceUrl.
    expect(pickTransport(makeSession(), { auth })).toBe('sse')
  })

  it('falls back to polling when neither transport is eligible', () => {
    const { factory } = fakeWebSocketFactory()
    expect(pickTransport(pollingOnly(), { auth, WebSocket: factory })).toBe('polling')
  })

  it('honours an explicit prefer over the default order', () => {
    const { factory } = fakeWebSocketFactory()
    expect(pickTransport(withWebSocket(), { auth, WebSocket: factory, prefer: 'sse' })).toBe('sse')
  })

  it('does not auto-select WebSocket when the server advertises supportsPush:false', () => {
    // RFC 8887 §3: a WS capability with supportsPush:false pushes no StateChange ⇒ must fall
    // through to SSE (makeSession has an eventSourceUrl), not silently pick a dead push channel.
    const { factory } = fakeWebSocketFactory()
    expect(pickTransport(withWebSocketNoPush(), { auth, WebSocket: factory })).toBe('sse')
  })

  it('skips a supportsPush:false WebSocket even when explicitly preferred', () => {
    const { factory } = fakeWebSocketFactory()
    expect(
      pickTransport(withWebSocketNoPush(), { auth, WebSocket: factory, prefer: 'websocket' }),
    ).toBe('sse')
  })

  it('accepts a prefer list and skips ineligible entries', () => {
    // Prefer websocket then sse, but this session has no ws capability ⇒ sse.
    expect(pickTransport(makeSession(), { auth, prefer: ['websocket', 'sse'] })).toBe('sse')
  })
})

describe('eligibleTransports', () => {
  it('returns the full failover order when nothing is preferred', () => {
    const { factory } = fakeWebSocketFactory()
    expect(eligibleTransports(withWebSocket(), { auth, WebSocket: factory })).toEqual([
      'websocket',
      'sse',
      'polling',
    ])
  })

  it('reorders (does not restrict) for an explicit prefer, keeping the others as fallbacks', () => {
    // prefer:'sse' must move SSE first but keep WebSocket in the set as a later fallback — the
    // list must agree with pickTransport's reorder semantics, never collapse to ['sse','polling'].
    const { factory } = fakeWebSocketFactory()
    expect(
      eligibleTransports(withWebSocket(), { auth, WebSocket: factory, prefer: 'sse' }),
    ).toEqual(['sse', 'websocket', 'polling'])
  })

  it('keeps an eligible real fallback when the preferred transport is ineligible', () => {
    // supportsPush:false ⇒ WebSocket filtered out, but SSE must remain (NOT collapse to polling):
    // a `prefer` that names an ineligible transport must never kill push. Regresses findings 1/3.
    const { factory } = fakeWebSocketFactory()
    expect(
      eligibleTransports(withWebSocketNoPush(), { auth, WebSocket: factory, prefer: 'websocket' }),
    ).toEqual(['sse', 'polling'])
  })

  it('RESTRICTS (does not reorder) for an explicit transports allowlist', () => {
    // The counterpart to the `prefer` test above, and the whole reason the option exists. This
    // session is FULLY WebSocket-eligible (capability advertised + a factory injected), so the
    // default order would be ['websocket','sse','polling'] and `prefer:'sse'` would only demote WS
    // to ['sse','websocket','polling'] — still a failover target. The allowlist must remove it
    // from the chain outright, so no amount of SSE failure can ever reach a WebSocket.
    const { factory } = fakeWebSocketFactory()
    expect(
      eligibleTransports(withWebSocket(), {
        auth,
        WebSocket: factory,
        transports: ['sse', 'polling'],
      }),
    ).toEqual(['sse', 'polling'])
  })

  it('always permits polling, so no allowlist can produce an empty set', () => {
    // Polling is capability-free and always eligible; it is the guaranteed tail that keeps the
    // facade's terminal-transport logic meaningful. An allowlist naming no real transport (here
    // the degenerate empty one) must degrade to ['polling'], not to [] — a caller must not be
    // able to hand FailoverPushChannel a set with nothing in it. Documented in the option's
    // doc-comment, and pinned here because a documented-but-untested contract is precisely how
    // the SSE-first decision drifted out of the code in the first place.
    const { factory } = fakeWebSocketFactory()
    expect(
      eligibleTransports(withWebSocket(), { auth, WebSocket: factory, transports: [] }),
    ).toEqual(['polling'])
  })
})

describe('createPushChannel', () => {
  it('returns a failover facade whose first transport is the WebSocket when selected', () => {
    const { factory } = fakeWebSocketFactory()
    const channel = createPushChannel(withWebSocket(), { auth, WebSocket: factory })
    expect(channel).toBeInstanceOf(FailoverPushChannel)
    expect(channel.transport).toBe('websocket')
  })

  it('starts on SSE when SSE is the first eligible transport', () => {
    const channel = createPushChannel(makeSession(), { auth, prefer: 'sse' })
    expect(channel).toBeInstanceOf(FailoverPushChannel)
    expect(channel.transport).toBe('sse')
  })

  it('starts on polling when nothing else is eligible', () => {
    const channel = createPushChannel(pollingOnly(), { auth })
    expect(channel).toBeInstanceOf(FailoverPushChannel)
    expect(channel.transport).toBe('polling')
  })

  it('starts on SSE (not WebSocket) when the WS capability has supportsPush:false', () => {
    const { factory } = fakeWebSocketFactory()
    const channel = createPushChannel(withWebSocketNoPush(), { auth, WebSocket: factory })
    expect(channel.transport).toBe('sse')
  })

  it('maps dataTypes onto the SSE {types} template var', async () => {
    const { fetch, connections } = sseFetchMock()
    const channel = createPushChannel(makeSession(), {
      auth,
      prefer: 'sse',
      fetch,
      scheduler: new FakeScheduler(),
      dataTypes: ['Email', 'Mailbox'],
    })
    channel.open()
    await tick()
    expect(connections[0]?.url).toContain('types=Email%2CMailbox')
    channel.close()
  })
})

describe('createPushChannel · runtime transport failover', () => {
  it('fails over to SSE after the WebSocket budget is exhausted (Stalwart-in-a-browser)', async () => {
    // The exact real-world footgun: WS is eligible but its handshake always 401s in a browser,
    // so it closes abnormally and never opens. After the attempt budget the facade degrades to
    // SSE on its own, and a subscriber registered BEFORE open() still receives StateChange.
    const ws = failingWebSocketFactory()
    const sse = sseFetchMock()
    const scheduler = new FakeScheduler()
    const changes: StateChange[] = []
    const channel = createPushChannel(withWebSocket(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      backoff: { random: () => 1, initialDelay: 100 },
    })
    channel.subscribe((change) => changes.push(change))
    channel.open()

    await tick() // WS attempt 1 fails — budget is 2, so no failover yet
    expect(ws.sockets).toHaveLength(1)
    expect(channel.transport).toBe('websocket')
    scheduler.runNext() // WS attempt 2
    await tick() // WS attempt 2 fails ⇒ budget reached ⇒ fail over to SSE, which opens

    expect(ws.sockets).toHaveLength(2)
    expect(channel.transport).toBe('sse')
    expect(channel.status).toBe('open')
    expect(sse.connections).toHaveLength(1)

    sse.connections[0]?.push(STATE_FRAME)
    await tick()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.changed).toEqual({ b: { Email: 's1', Mailbox: 's1' } })
    channel.close()
  })

  it('does not downgrade once WebSocket has opened — its own loop reconnects as WebSocket', async () => {
    const ws = fakeWebSocketFactory()
    const sse = sseFetchMock()
    const scheduler = new FakeScheduler()
    const channel = createPushChannel(withWebSocket(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      backoff: { random: () => 1, initialDelay: 100 },
    })
    channel.open()
    await tick()
    ws.sockets[0]?.simulateOpen()
    expect(channel.status).toBe('open')
    expect(channel.transport).toBe('websocket')

    ws.sockets[0]?.simulateClose(1006) // drop AFTER opening ⇒ no downgrade, inner loop owns it
    expect(channel.status).toBe('reconnecting')
    expect(scheduler.pending).toBe(1)
    scheduler.runNext()
    await tick()
    expect(ws.sockets).toHaveLength(2) // reconnected as WS
    ws.sockets[1]?.simulateOpen()
    expect(channel.transport).toBe('websocket')
    expect(sse.connections).toHaveLength(0) // SSE was never touched
    channel.close()
  })

  it('never downgrades after open even across repeated post-open drops (budget 1 lock)', async () => {
    // Finding 4 regression: lock the "once open, failover is disabled for good" invariant with a
    // budget of 1, so a SINGLE post-open drop WOULD trip failover if post-open failures counted.
    // The facade's `opened` guard must stop them. A mutant that drops the guard fails this test;
    // the pre-existing single-drop test (budget 2) could not catch that mutant.
    const ws = fakeWebSocketFactory()
    const sse = sseFetchMock()
    const scheduler = new FakeScheduler()
    const channel = createPushChannel(withWebSocket(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      failoverAfterAttempts: 1, // a single failure trips failover — for a NEVER-OPENED transport
      backoff: { random: () => 1, initialDelay: 100 },
    })
    channel.open()
    await tick()
    ws.sockets[0]?.simulateOpen()
    expect(channel.status).toBe('open')
    expect(channel.transport).toBe('websocket')

    // First post-open drop: with budget 1 this would immediately fail over to SSE if post-open
    // failures were counted. The guard must keep us on WebSocket.
    ws.sockets[0]?.simulateClose(1006)
    expect(channel.transport).toBe('websocket')
    expect(channel.status).toBe('reconnecting')
    expect(scheduler.pending).toBe(1)
    scheduler.runNext()
    await tick()
    expect(ws.sockets).toHaveLength(2) // reconnected as WS, not SSE

    // Second consecutive post-open drop with NO intervening open: still must not downgrade.
    ws.sockets[1]?.simulateClose(1006)
    expect(channel.transport).toBe('websocket')
    expect(scheduler.pending).toBe(1)
    scheduler.runNext()
    await tick()
    expect(ws.sockets).toHaveLength(3)
    expect(sse.connections).toHaveLength(0) // SSE never touched across repeated post-open drops
    channel.close()
  })

  it('does not downgrade on a single transient failure below the budget', async () => {
    const ws = fakeWebSocketFactory()
    const sse = sseFetchMock()
    const scheduler = new FakeScheduler()
    const channel = createPushChannel(withWebSocket(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      backoff: { random: () => 1, initialDelay: 100 },
    })
    channel.open()
    await tick()
    ws.sockets[0]?.simulateClose(1006) // attempt 1 fails (count 1 < budget 2)
    expect(channel.transport).toBe('websocket')
    expect(scheduler.pending).toBe(1)
    scheduler.runNext()
    await tick()
    ws.sockets[1]?.simulateOpen() // attempt 2 succeeds
    expect(channel.status).toBe('open')
    expect(channel.transport).toBe('websocket')
    expect(sse.connections).toHaveLength(0)
    channel.close()
  })

  it('close() during the failover window stops all connect attempts and pending timers', async () => {
    const ws = failingWebSocketFactory()
    const sse = sseFetchMock()
    const scheduler = new FakeScheduler()
    const channel = createPushChannel(withWebSocket(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      backoff: { random: () => 1, initialDelay: 100 },
    })
    channel.open()
    await tick() // WS attempt 1 failed; a reconnect timer is armed
    expect(ws.sockets).toHaveLength(1)
    expect(scheduler.pending).toBe(1)

    channel.close()
    expect(channel.status).toBe('closed')
    expect(scheduler.pending).toBe(0) // the reconnect timer was cancelled

    scheduler.flush()
    await tick()
    expect(ws.sockets).toHaveLength(1) // no further WS attempt
    expect(sse.connections).toHaveLength(0) // never fell over to SSE
  })

  it('close() from inside an onStatus listener during failover leaves no zombie connection', async () => {
    const ws = failingWebSocketFactory()
    const sse = sseFetchMock()
    const scheduler = new FakeScheduler()
    const statuses: PushStatus[] = []
    const channel = createPushChannel(withWebSocket(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      failoverAfterAttempts: 1, // fail over on the very first WS failure
      backoff: { random: () => 1, initialDelay: 100 },
    })
    channel.onStatus((status) => {
      statuses.push(status)
      if (status === 'reconnecting') channel.close() // close AT the WS→SSE swap
    })
    channel.open()
    await tick() // WS fails ⇒ fail over to SSE ⇒ 'reconnecting' ⇒ listener closes mid-swap

    expect(statuses).toContain('reconnecting')
    expect(channel.status).toBe('closed')
    expect(scheduler.pending).toBe(0)

    scheduler.flush()
    await tick()
    // The SSE attempt started during the swap must have been aborted before issuing a fetch.
    expect(sse.connections).toHaveLength(0)
    expect(ws.sockets).toHaveLength(1)
  })

  it('keeps retrying the last real transport (SSE) forever instead of dying on the polling stub', async () => {
    // Finding 2 regression: WS fails over to SSE, the terminal real transport. Repeated SSE
    // connect failures must NOT count toward a budget that tears SSE down onto the non-functional
    // polling stub and permanently closes the channel. Its own ReconnectLoop must keep retrying
    // forever (SP.3 "survives a server restart"), so a transient blip self-heals rather than
    // silently killing all push. Before the fix this failed over to polling and settled 'closed'.
    const ws = failingWebSocketFactory()
    const sse = sseFetchMock(401) // every SSE connect fails (non-ok response)
    const scheduler = new FakeScheduler()
    const errors: Error[] = []
    const channel = createPushChannel(withWebSocket(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      backoff: { random: () => 1, initialDelay: 100 },
      events: { onError: (error) => errors.push(error) },
    })
    channel.open()
    await tick() // WS attempt 1 fails
    scheduler.runNext() // WS attempt 2
    await tick() // WS attempt 2 fails ⇒ fail over to SSE ⇒ SSE attempt 1 (401) fails
    expect(channel.transport).toBe('sse')
    expect(sse.connections).toHaveLength(1)

    // Drive many more SSE failures: the facade must never advance to polling nor settle closed.
    for (let i = 0; i < 5; i++) {
      expect(scheduler.pending).toBe(1) // the inner ReconnectLoop always has a retry armed
      scheduler.runNext()
      await tick()
    }
    expect(channel.transport).toBe('sse') // still SSE, never advanced onto polling
    expect(channel.status).not.toBe('closed') // never permanently died
    expect(sse.connections.length).toBeGreaterThan(1) // kept retrying SSE
    channel.close()
    expect(channel.status).toBe('closed')
  })

  it('a browser allowlist keeps SSE self-healing — transient failures never reach the WebSocket', async () => {
    // THE regression this option exists for (gap B4, decision D2). The session is fully
    // WebSocket-eligible, exactly as a real browser's is: Stalwart advertises the RFC 8887
    // capability, `globalThis.WebSocket` exists — and the handshake still 401s forever, because a
    // browser cannot set the `Authorization` header on the upgrade.
    //
    // The tempting "SSE-first" fix is `prefer:'sse'`. It ships GREEN against the whole existing
    // suite and it is actively harmful: `prefer` reorders to ['sse','websocket','polling'], which
    // hands SSE a real failover target it does not have today. With the budget spent on the
    // transient failures below, the facade advances onto the WebSocket — which is itself terminal
    // (only 'polling' follows) — and push is dead until reload. Substituting `prefer:'sse'` for
    // the allowlist here is the empirical proof: this test then fails with 'websocket' to be 'sse'.
    //
    // With the allowlist, SSE is the last *real* transport, `hasRealFailoverTarget()` is false, and
    // it is left to its own ReconnectLoop — which retries forever until the blip clears.
    const ws = fakeWebSocketFactory()
    const sse = flakySseFetchMock(3) // three consecutive pre-open failures…
    const scheduler = new FakeScheduler()
    const statuses: PushStatus[] = []
    const channel = createPushChannel(withWebSocket(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      transports: ['sse', 'polling'],
      failoverAfterAttempts: 1, // …against a budget of ONE: every failure would trip a failover
      backoff: { random: () => 1, initialDelay: 100 },
      events: { onStatus: (status) => statuses.push(status) },
    })
    expect(channel.transport).toBe('sse') // WS was excluded from the chain, not merely demoted
    channel.open()
    await tick() // SSE attempt 1 rejects

    for (let i = 0; i < 3; i++) {
      expect(channel.transport).toBe('sse') // never advanced, despite exceeding the budget
      expect(ws.sockets).toHaveLength(0) // and never built the WebSocket it cannot authenticate
      expect(scheduler.pending).toBe(1) // its own ReconnectLoop always has a retry armed
      scheduler.runNext()
      await tick()
    }

    // The blip cleared on attempt 4: SSE reconnected itself and opened, with no failover at all.
    expect(sse.attempts.count).toBe(4)
    expect(channel.transport).toBe('sse')
    expect(channel.status).toBe('open')
    expect(sse.connections).toHaveLength(1)
    expect(ws.sockets).toHaveLength(0)
    expect(statuses).not.toContain('closed')
    channel.close()
  })

  it('opens the real polling transport when it is the sole eligible transport', async () => {
    // Nothing but polling is eligible (no WS, no eventSourceUrl). Polling is a REAL transport now
    // (M1.3): it re-fetches the Session, reaches `open`, and owns its own reconnect loop — it does
    // NOT error-once-and-settle-closed like the old stub. Full lifecycle is covered in polling.test.ts.
    const scheduler = new FakeScheduler()
    const { fetch } = sessionFetchMock(['s0'])
    const channel = createPushChannel(pollingOnly(), { auth, scheduler, fetch })
    expect(channel.transport).toBe('polling')
    channel.open()
    await tick() // the initial session poll resolves
    expect(channel.status).toBe('open')
    channel.close()
    expect(channel.status).toBe('closed')
  })

  it('prefer:"sse" tries SSE first, so the WebSocket fallback is never constructed', async () => {
    // prefer:'sse' reorders SSE ahead of WebSocket. SSE opens on the first attempt, so the
    // facade never advances to the (later) WebSocket fallback — its factory stays untouched.
    const ws = fakeWebSocketFactory()
    const sse = sseFetchMock()
    const scheduler = new FakeScheduler()
    const channel = createPushChannel(withWebSocket(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      prefer: 'sse',
    })
    channel.open()
    await tick()
    expect(channel.transport).toBe('sse')
    expect(sse.connections).toHaveLength(1)
    expect(ws.sockets).toHaveLength(0) // SSE opened first ⇒ the WS fallback is never reached
    channel.close()
  })

  it('preferring an ineligible transport still falls over to an eligible one, not polling', async () => {
    // Findings 1/3 regression: `prefer` is a soft reorder, not a hard restriction. Preferring
    // WebSocket on a server that advertises it with supportsPush:false (WS ineligible) must still
    // reach the eligible SSE transport and deliver push — NOT collapse to the polling stub. Before
    // the fix the failover set was ['polling'] only and the channel delivered zero StateChange.
    const ws = fakeWebSocketFactory()
    const sse = sseFetchMock()
    const scheduler = new FakeScheduler()
    const changes: StateChange[] = []
    const channel = createPushChannel(withWebSocketNoPush(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      prefer: 'websocket',
    })
    expect(channel.transport).toBe('sse') // reordered; the ineligible WS was filtered out
    channel.subscribe((change) => changes.push(change))
    channel.open()
    await tick()
    expect(sse.connections).toHaveLength(1)
    expect(ws.sockets).toHaveLength(0) // the ineligible WS is never constructed
    sse.connections[0]?.push(STATE_FRAME)
    await tick()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.changed).toEqual({ b: { Email: 's1', Mailbox: 's1' } })
    channel.close()
  })

  it('reports a sane status sequence across a failover (no spurious closed)', async () => {
    const ws = failingWebSocketFactory()
    const sse = sseFetchMock()
    const scheduler = new FakeScheduler()
    const statuses: PushStatus[] = []
    const channel = createPushChannel(withWebSocket(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      backoff: { random: () => 1, initialDelay: 100 },
      events: { onStatus: (status) => statuses.push(status) },
    })
    channel.open()
    await tick() // WS attempt 1 fails ⇒ 'reconnecting'
    scheduler.runNext()
    await tick() // WS attempt 2 fails ⇒ fail over ⇒ SSE opens ⇒ 'open'
    expect(statuses).toEqual(['connecting', 'reconnecting', 'open'])
    expect(statuses).not.toContain('closed')
    channel.close()
    expect(statuses.at(-1)).toBe('closed')
  })

  it("subscribe()'s unsubscribe still works after a failover", async () => {
    const ws = failingWebSocketFactory()
    const sse = sseFetchMock()
    const scheduler = new FakeScheduler()
    const received: StateChange[] = []
    const channel = createPushChannel(withWebSocket(), {
      auth,
      WebSocket: ws.factory,
      fetch: sse.fetch,
      scheduler,
      backoff: { random: () => 1, initialDelay: 100 },
    })
    const unsubscribe = channel.subscribe((change) => received.push(change))
    channel.open()
    await tick()
    scheduler.runNext()
    await tick() // now failed over to SSE and open
    expect(channel.transport).toBe('sse')

    sse.connections[0]?.push(STATE_FRAME)
    await tick()
    expect(received).toHaveLength(1)

    unsubscribe() // the pre-open subscription must still be revocable post-failover
    sse.connections[0]?.push(STATE_FRAME)
    await tick()
    expect(received).toHaveLength(1)
    channel.close()
  })
})

// The real PollingChannel transport is covered in ./polling.test.ts; the facade↔polling wiring is
// covered by "opens the real polling transport when it is the sole eligible transport" above.
