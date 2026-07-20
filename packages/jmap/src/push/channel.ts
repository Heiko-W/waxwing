/**
 * Transport auto-selection **with runtime failover** (FR-NOTIF-01): {@link createPushChannel}
 * inspects the Session's advertised capabilities and the available runtime primitives and
 * returns a {@link FailoverPushChannel} — a {@link PushChannel} facade that owns an ordered
 * list of *eligible* transports (WebSocket → SSE → polling by default) and connects them in
 * turn. A transport that never reaches `open` after {@link CreatePushChannelOptions.failoverAfterAttempts}
 * consecutive failed attempts is torn down and the next eligible transport is tried; once a
 * transport opens, its own {@link ReconnectLoop} owns every subsequent drop (it never downgrades).
 *
 * This makes the browser-vs-Stalwart footgun self-healing: WebSocket is *eligible* there
 * (the capability advertises `supportsPush:true` and `globalThis.WebSocket` exists) but the
 * handshake needs an `Authorization` header a browser cannot set, so it 401s and closes
 * abnormally forever. The facade now discovers that at runtime and degrades to SSE on its own,
 * so callers no longer have to pass `prefer:'sse'` to get push in a browser. Callers who want a
 * specific transport still construct {@link SseChannel} / {@link WebSocketChannel} directly (no
 * failover there), pass {@link CreatePushChannelOptions.prefer} to *reorder* the set, or pass
 * {@link CreatePushChannelOptions.transports} to *restrict* it when a transport is not merely
 * slower but structurally unusable in this runtime.
 */

import type { AuthProvider } from '../auth'
import type { FetchLike } from '../transport'
import type { Session } from '../types/core'
import type { StateChange } from '../types/push'
import type { BackoffOptions } from './backoff'
import { PollingChannel } from './polling'
import type { SseAuthMode } from './sse'
import { SseChannel } from './sse'
import type {
  PushChannel,
  PushChannelEvents,
  PushErrorListener,
  PushStatus,
  PushTransport,
  SchedulerLike,
  StateChangeListener,
  StatusListener,
  Unsubscribe,
  WebSocketFactory,
} from './types'
import { getWebSocketCapability, WebSocketChannel } from './websocket'

/** Options for {@link createPushChannel}. */
export interface CreatePushChannelOptions {
  /** Auth provider injected into the chosen transport. */
  auth: AuthProvider
  /** Injectable fetch for the SSE transport (tests / SSR). */
  fetch?: FetchLike
  /** Injectable WebSocket factory (tests / header-capable Node impl). */
  WebSocket?: WebSocketFactory
  /** Preferred transport(s), tried before the default `websocket → sse → polling` order. */
  prefer?: PushTransport | PushTransport[]
  /**
   * The allowlist of transports this *runtime* may use. `prefer` orders the set, `transports`
   * restricts it: an excluded transport is absent from the failover chain entirely, not merely
   * deprioritised. Defaults to "everything" — the library's documented `websocket → sse → polling`
   * behaviour is unchanged for callers who omit this.
   *
   * These are deliberately separate concepts, because reordering is the *wrong* tool for a hard
   * runtime constraint. `prefer:'sse'` yields `['sse','websocket','polling']` — the unusable
   * transport is still in the chain, one failover hop behind the working one. A browser that
   * cannot authenticate a WebSocket at all (no way to set the `Authorization` header on the
   * Upgrade) therefore *gains* a failover target it should not have: a couple of transient SSE
   * blips at startup spend the budget, the facade advances onto the WebSocket, and that transport
   * is itself terminal — push is then permanently dead where the default order self-heals. Pass
   * `transports: ['sse','polling']` instead; SSE stays last-real and keeps retrying forever.
   *
   * `'polling'` is always permitted regardless of this list — it is capability-free, always
   * eligible, and the guaranteed tail that keeps {@link FailoverPushChannel}'s terminal-transport
   * logic meaningful. So the eligible set is never empty: an allowlist naming no real transport
   * (including `[]`) degrades to `['polling']` rather than throwing or yielding a dead channel.
   */
  transports?: readonly PushTransport[]
  /** Types to receive: WS `WebSocketPushEnable.dataTypes` / SSE `{types}`. */
  dataTypes?: string[] | null
  /** SSE auth placement (`header` default; `query` for servers with `?access_token=`). */
  sseAuth?: SseAuthMode
  /** Polling transport only: URL to re-fetch the Session from (default: origin of `session.apiUrl`). */
  sessionUrl?: string
  /** Backoff tuning shared by whichever transport is selected. */
  backoff?: BackoffOptions
  /** Injectable timer source (tests). */
  scheduler?: SchedulerLike
  /** Initial listeners. */
  events?: PushChannelEvents
  /**
   * How many consecutive failed connect attempts a *never-opened* transport is given before
   * the facade tears it down and fails over to the next eligible transport. A transient blip
   * at startup usually clears within a couple of attempts; a hard 401/handshake rejection
   * never does. Defaults to {@link DEFAULT_FAILOVER_AFTER_ATTEMPTS}. Ignored once a transport
   * has opened at least once (from then on its own reconnect loop owns every drop).
   */
  failoverAfterAttempts?: number
}

/** The default transport preference order (FR-NOTIF-01). */
const DEFAULT_ORDER: readonly PushTransport[] = ['websocket', 'sse', 'polling']

/** Default {@link CreatePushChannelOptions.failoverAfterAttempts}. */
export const DEFAULT_FAILOVER_AFTER_ATTEMPTS = 2

/**
 * Chooses a transport for `session`: the first entry of the preference order that is
 * *eligible* (its capability is advertised and its runtime primitive resolves). Retained for
 * callers and tests that only need the name of the first transport the facade would try.
 *
 * Derived from {@link eligibleTransports} rather than re-walking the order itself, so the two
 * cannot drift: the docblock below promises they "always agree on which transports are
 * reachable", and with a second, *narrowing* option that promise only stays true if they share
 * one code path.
 */
export function pickTransport(session: Session, options: CreatePushChannelOptions): PushTransport {
  return eligibleTransports(session, options)[0] ?? 'polling'
}

/**
 * The ordered list of eligible transports the {@link FailoverPushChannel} will try, in order.
 * This is the preference order ({@link CreatePushChannelOptions.prefer} first, then the default
 * `websocket → sse → polling`), narrowed by the {@link CreatePushChannelOptions.transports}
 * allowlist, then intersected with {@link isEligible}.
 *
 * The two options are separate concepts on purpose. `prefer` *reorders* the set (a soft
 * preference, exactly as {@link pickTransport} and the option's contract describe); it never
 * *restricts* it, so an ineligible preferred transport still falls through to the other eligible
 * transports instead of collapsing to the polling stub. `transports` is the hard constraint:
 * anything it excludes is removed from the chain, so it can never be reached by failover either.
 * Reordering deliberately cannot express that — moving an unusable transport to the back still
 * leaves it as a failover target, and the facade would eventually land on it (see the
 * {@link CreatePushChannelOptions.transports} doc-comment for the browser/WebSocket case this
 * exists for). The allowlist is applied BEFORE {@link isEligible} so an excluded transport is
 * absent from the chain rather than merely deprioritised within it.
 *
 * The facade and {@link pickTransport} therefore always agree on which transports are reachable —
 * structurally, since {@link pickTransport} is defined in terms of this function.
 */
export function eligibleTransports(
  session: Session,
  options: CreatePushChannelOptions,
): PushTransport[] {
  return permittedTransports(options).filter((transport) => isEligible(transport, session, options))
}

/**
 * Builds a {@link PushChannel} for `session` that connects the eligible transports in
 * preference order with runtime failover. Does not open it — call {@link PushChannel.open}.
 */
export function createPushChannel(
  session: Session,
  options: CreatePushChannelOptions,
): PushChannel {
  return new FailoverPushChannel(session, options, eligibleTransports(session, options))
}

/**
 * The preference order narrowed by the {@link CreatePushChannelOptions.transports} allowlist.
 * A genuine filter, never a reorder — see {@link eligibleTransports}. `'polling'` survives any
 * allowlist, so the result is never empty and the caller cannot accidentally hand
 * {@link FailoverPushChannel} a set with no transport in it.
 */
function permittedTransports(options: CreatePushChannelOptions): PushTransport[] {
  const order = transportOrder(options.prefer)
  const allowed = options.transports
  if (allowed === undefined) return order
  return order.filter((transport) => transport === 'polling' || allowed.includes(transport))
}

function transportOrder(prefer: CreatePushChannelOptions['prefer']): PushTransport[] {
  if (prefer === undefined) return [...DEFAULT_ORDER]
  const preferred = Array.isArray(prefer) ? prefer : [prefer]
  return [...preferred, ...DEFAULT_ORDER.filter((transport) => !preferred.includes(transport))]
}

function isEligible(
  transport: PushTransport,
  session: Session,
  options: CreatePushChannelOptions,
): boolean {
  switch (transport) {
    case 'websocket':
      // RFC 8887 §3: a WebSocket capability with `supportsPush:false` is usable for
      // Request/Response but the server will NOT push StateChange over it — never auto-select
      // it as a push transport (fall through to SSE), or the channel would report 'open' yet
      // deliver zero events. Callers needing WS for Request/Response build WebSocketChannel
      // directly.
      return (
        getWebSocketCapability(session)?.supportsPush === true &&
        (options.WebSocket !== undefined || hasGlobalWebSocket())
      )
    case 'sse':
      return typeof session.eventSourceUrl === 'string' && session.eventSourceUrl !== ''
    case 'polling':
      return true
  }
}

function hasGlobalWebSocket(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function'
}

/**
 * A {@link PushChannel} facade that connects an ordered list of eligible transports with
 * runtime failover.
 *
 * ### Failover state machine
 * Per transport the facade tracks whether it has ever reached `open` and how many consecutive
 * connect attempts have failed since it was started:
 *
 *  - **trying** (never opened) — each connect *error* increments a counter. Reaching
 *    `failoverAfterAttempts` tears the transport down and advances to the next eligible one,
 *    restarting the counter — but only while a *real* transport remains to fail over to. The
 *    LAST transport (real or the always-last polling transport) is never counted out: it is left
 *    to its own {@link ReconnectLoop}, which retries forever, so a transient blip on the one
 *    transport that works self-heals instead of permanently killing push. Observable only as
 *    `connecting`/`reconnecting`, never a spurious `closed`.
 *  - **open** — the transport reached `open`; failover is disabled for good. Its own
 *    {@link ReconnectLoop} owns every subsequent drop and reconnect (the SP.3 "survives a
 *    server restart" behaviour). The facade never downgrades from here. Polling is now a real
 *    transport that reaches `open` too (M1.3), so it behaves like SSE/WS once selected.
 *  - **exhausted** — a safety terminal reached only if the transport list runs out (every
 *    eligible transport advanced past). In practice polling is always last and, being a real
 *    transport, is left to its own reconnect loop rather than advancing — so this state is not
 *    reached in normal operation.
 *
 * Each eligible transport is tried at most once per channel lifetime. The facade owns the
 * listener sets, so `subscribe`/`onStatus`/`onError` registrations survive a transport swap:
 * every new inner channel is bridged into the same sets. {@link close} at any point — including
 * mid-failover and from inside a status/error listener — stops everything with no leaked timer,
 * socket or reader.
 */
export class FailoverPushChannel implements PushChannel {
  private readonly stateListeners = new Set<StateChangeListener>()
  private readonly statusListeners = new Set<StatusListener>()
  private readonly errorListeners = new Set<PushErrorListener>()
  private facadeStatus: PushStatus = 'closed'

  private readonly transports: readonly PushTransport[]
  private readonly budget: number
  private index = 0

  private inner: PushChannel | undefined
  private innerUnsubs: Unsubscribe[] = []
  /** Bumped on every transport swap; stale bridge callbacks compare against it and bail. */
  private epoch = 0
  /** Has the CURRENT transport ever reached `open`? Once true, failover is disabled for good. */
  private opened = false
  /** Consecutive failed connect attempts on the current, never-opened transport. */
  private failedAttempts = 0
  private started = false
  private terminated = false

  constructor(
    private readonly session: Session,
    private readonly options: CreatePushChannelOptions,
    transports: readonly PushTransport[],
  ) {
    // eligibleTransports always yields at least ['polling'] (polling is always eligible).
    this.transports = transports.length > 0 ? transports : ['polling']
    this.budget = Math.max(1, options.failoverAfterAttempts ?? DEFAULT_FAILOVER_AFTER_ATTEMPTS)
    const events = options.events
    if (events?.onStateChange) this.stateListeners.add(events.onStateChange)
    if (events?.onStatus) this.statusListeners.add(events.onStatus)
    if (events?.onError) this.errorListeners.add(events.onError)
  }

  /** The transport currently active (or the first one that will be tried before {@link open}). */
  get transport(): PushTransport {
    return this.transports[this.index] ?? 'polling'
  }

  get status(): PushStatus {
    return this.facadeStatus
  }

  open(): void {
    if (this.started || this.terminated) return
    this.started = true
    this.startTransport()
  }

  close(): void {
    if (this.terminated) return
    this.terminated = true
    this.started = true // a later open() must stay a no-op
    this.teardownInner()
    this.setStatus('closed')
  }

  subscribe(listener: StateChangeListener): Unsubscribe {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  onStatus(listener: StatusListener): Unsubscribe {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  onError(listener: PushErrorListener): Unsubscribe {
    this.errorListeners.add(listener)
    return () => {
      this.errorListeners.delete(listener)
    }
  }

  /** Builds, bridges and opens the transport at the current index. */
  private startTransport(): void {
    const transport = this.transports[this.index]
    if (transport === undefined) {
      this.settleExhausted()
      return
    }
    this.epoch++
    const epoch = this.epoch
    this.opened = false
    this.failedAttempts = 0
    const inner = this.buildInner(transport)
    this.inner = inner
    // Bridge the inner channel into the facade's own listener sets. Each callback is
    // generation-guarded so a late event from a superseded transport can never leak through.
    this.innerUnsubs = [
      inner.subscribe((change) => {
        if (epoch === this.epoch && !this.terminated) this.emitStateChange(change)
      }),
      inner.onStatus((status) => {
        if (epoch === this.epoch && !this.terminated) this.handleInnerStatus(status)
      }),
      inner.onError((error) => {
        if (epoch === this.epoch && !this.terminated) this.handleInnerError(error)
      }),
    ]
    inner.open()
  }

  private handleInnerStatus(status: PushStatus): void {
    switch (status) {
      case 'open':
        this.opened = true
        this.failedAttempts = 0
        this.setStatus('open')
        return
      case 'closed':
        // The facade owns its own terminal 'closed'; an inner 'closed' only ever comes from a
        // teardown we initiated (bridge already unsubscribed) — never surface it.
        return
      case 'connecting':
        // Only the very first transport's first attempt is 'connecting'; after any failover we
        // are conceptually still reconnecting, so surface further fresh attempts as such.
        this.setStatus(this.index === 0 ? 'connecting' : 'reconnecting')
        return
      case 'reconnecting':
        this.setStatus('reconnecting')
        return
    }
  }

  private handleInnerError(error: Error): void {
    this.emitError(error)
    // An error listener may have synchronously closed us; and a transport that has opened owns
    // its own reconnect loop — in either case do not fail over.
    if (this.terminated || this.opened) return
    // A transport (websocket/sse/polling) that has never opened. Polling is now a real transport
    // (it reaches `open` and owns its own reconnect loop), so it is no longer special-cased as a
    // one-shot terminal stub. Only spend the failover budget if there is another real transport to
    // fall over to; never tear a transport down onto the terminal polling entry. When this is the
    // LAST real transport (or polling itself, always last), leave it to its own ReconnectLoop,
    // which retries forever (SP.3 "survives a server restart"): a transient startup blip then
    // self-heals instead of permanently killing all push.
    if (!this.hasRealFailoverTarget()) return
    this.failedAttempts++
    if (this.failedAttempts >= this.budget) this.advance()
  }

  /** Is there a real (non-polling-stub) transport left after the current index to fail over to? */
  private hasRealFailoverTarget(): boolean {
    for (let i = this.index + 1; i < this.transports.length; i++) {
      if (this.transports[i] !== 'polling') return true
    }
    return false
  }

  /** Tears the current transport down and moves to the next eligible one (or settles). */
  private advance(): void {
    this.teardownInner()
    if (this.terminated) return // a listener closed us during teardown
    this.index++
    if (this.index >= this.transports.length) {
      this.settleExhausted()
      return
    }
    this.startTransport()
  }

  private settleExhausted(): void {
    this.terminated = true
    // The last error was already surfaced by handleInnerError; only the status settles here.
    this.setStatus('closed')
  }

  private teardownInner(): void {
    for (const unsub of this.innerUnsubs) unsub()
    this.innerUnsubs = []
    const inner = this.inner
    this.inner = undefined
    inner?.close()
  }

  private buildInner(transport: PushTransport): PushChannel {
    const shared: { backoff?: BackoffOptions; scheduler?: SchedulerLike } = {}
    if (this.options.backoff !== undefined) shared.backoff = this.options.backoff
    if (this.options.scheduler !== undefined) shared.scheduler = this.options.scheduler
    switch (transport) {
      case 'websocket': {
        const wsOptions: ConstructorParameters<typeof WebSocketChannel>[0] = {
          session: this.session,
          auth: this.options.auth,
          ...shared,
        }
        if (this.options.WebSocket !== undefined) wsOptions.WebSocket = this.options.WebSocket
        if (this.options.dataTypes !== undefined) wsOptions.dataTypes = this.options.dataTypes
        return new WebSocketChannel(wsOptions)
      }
      case 'sse': {
        const sseOptions: ConstructorParameters<typeof SseChannel>[0] = {
          session: this.session,
          auth: this.options.auth,
          ...shared,
        }
        if (this.options.fetch !== undefined) sseOptions.fetch = this.options.fetch
        if (this.options.sseAuth !== undefined) sseOptions.sseAuth = this.options.sseAuth
        if (this.options.dataTypes != null) sseOptions.types = this.options.dataTypes.join(',')
        return new SseChannel(sseOptions)
      }
      default: {
        const pollingOptions: ConstructorParameters<typeof PollingChannel>[0] = {
          session: this.session,
          auth: this.options.auth,
          ...shared,
        }
        if (this.options.fetch !== undefined) pollingOptions.fetch = this.options.fetch
        if (this.options.sessionUrl !== undefined)
          pollingOptions.sessionUrl = this.options.sessionUrl
        return new PollingChannel(pollingOptions)
      }
    }
  }

  private setStatus(status: PushStatus): void {
    if (status === this.facadeStatus) return
    this.facadeStatus = status
    for (const listener of [...this.statusListeners]) listener(status)
  }

  private emitStateChange(change: StateChange): void {
    for (const listener of [...this.stateListeners]) listener(change)
  }

  private emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error)
  }
}

/**
 * The real last-resort polling transport (M1.3). Re-exported here so `index.ts` and existing
 * callers keep importing `PollingChannel` from `./channel`; its implementation lives in
 * `./polling`. It reaches `open` and owns its own reconnect loop like SSE/WS — see {@link PollingChannel}.
 */
export { PollingChannel } from './polling'
