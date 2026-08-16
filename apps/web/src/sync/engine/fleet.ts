/**
 * The per-account engine FLEET (M4.4 Etappe 2). One {@link SyncEngine} runs per mail account — the
 * user's own PRIMARY plus every delegated/shared account the session grants — so their mailbox trees
 * land in the (already account-scoped) replica for the sidebar (Etappe 3) to render.
 *
 * This module is the pure orchestration: it decides HOW MANY engines to run, WHICH leader lock each
 * holds, and WHERE their status goes — all through injected factories so it is testable without React
 * or a browser. {@link SyncEngineHost} (`react.tsx`) is the thin wrapper that fills the browser
 * factories and re-runs the whole thing on any account-set change (React's effect cleanup guarantees
 * a clean teardown before every rebuild — the 0→1→0 lifecycle).
 *
 * Two invariants shape every decision here:
 *  - **The primary is byte-for-byte the pre-M4.4 engine when NO account is shared.** With zero shared
 *    accounts nothing new happens: no push mux, no registry write, the bare {@link SYNC_LOCK}, the
 *    global status badge, the active-engine handle. The single-account path is exactly today's.
 *  - **Secondary engines never touch the primary's UX.** They hold their own `${SYNC_LOCK}:${id}`
 *    lock, a no-op status sink (no badge flicker) and a no-op bus (no cross-tab status/foreground
 *    crosstalk), and carry no notifier. That isolation is untouched — but every engine IS published
 *    under its own account id ({@link FleetDeps.publish}), because the UI dispatches through the
 *    engine matching the acting subtree's `useReplica().accountId`, not through one global pointer.
 *    Only the PRIMARY additionally becomes the `activeEngine` handle, which now means exactly "the
 *    user's own account" for the few account-global consumers.
 *
 * That last point is Etappe 4, and it closes the defect Etappe 3 made reachable: the grouped sidebar
 * put shared mailboxes on screen while every write still went to the single `activeEngine`. Because
 * JMAP mailbox ids are per-account and SHORT (`a`, `b`, …), an archive/move/empty performed in a
 * shared folder carried that account's id to the PRIMARY's engine — where it names a real but
 * DIFFERENT mailbox. Silent, and destructive in `emptyMailbox`'s case.
 */

import type {
  Id,
  PushChannel,
  PushErrorListener,
  PushStatus,
  PushTransport,
  Session,
  StateChangeListener,
  StatusListener,
  Unsubscribe,
} from '@waxwing/jmap'
import type { BroadcastChannelLike } from './bus'
import type { SyncEngine, SyncEngineDeps } from './engine'
import { SYNC_LOCK } from './leader'
import type { EngineStatus } from './types'

/** A mail account the fleet runs an engine for; `isPrimary` marks the user's own account. */
export interface FleetAccount {
  readonly id: Id
  readonly name: string
  readonly isPrimary: boolean
}

/**
 * The account-varying wiring for ONE engine, resolved by {@link startEngineFleet} and handed to
 * {@link FleetDeps.createEngine}. Every field is `undefined` for the primary so its engine falls back
 * to the historical single-account defaults (see the module header's byte-for-byte invariant).
 */
export interface EngineSpec {
  readonly account: FleetAccount
  readonly isPrimary: boolean
  /** `${SYNC_LOCK}:${id}` for a shared account; `undefined` (⇒ bare {@link SYNC_LOCK}) for the primary. */
  readonly lockName: string | undefined
  /** A shared-push-mux handle when ≥1 account is shared; `undefined` (⇒ own SSE channel) otherwise. */
  readonly createPush: SyncEngineDeps['createPush'] | undefined
  /** A no-op channel for a shared account; `undefined` (⇒ real BroadcastChannel) for the primary. */
  readonly createBus: (() => BroadcastChannelLike) | undefined
  /** A discarding sink for a shared account; `undefined` (⇒ global badge store) for the primary. */
  readonly publishStatus: ((status: EngineStatus) => void) | undefined
}

export interface FleetDeps {
  /** Build (but do not start) the engine for one account from its resolved {@link EngineSpec}. */
  readonly createEngine: (spec: EngineSpec) => SyncEngine
  /** Create the ONE shared push channel that fans a single StateChange out to every engine. */
  readonly createPushMux: () => PushMux
  /** Publish/clear the PRIMARY handle, for the account-global consumers (primary only). */
  readonly setActive: (engine: SyncEngine | null) => void
  /**
   * Publish (or, with `null`, withdraw) the per-account engine the acting UI dispatches through —
   * EVERY account, the primary included (M4.4 Etappe 4).
   */
  readonly publish: (accountId: Id, engine: SyncEngine | null) => void
  /** Record an account in the replica registry so Etappe 3 can enumerate it offline. */
  readonly register: (account: FleetAccount) => void
}

/** Bus + status sinks a shared-account engine uses so it stays invisible to the primary's chrome. */
const NOOP_BUS = (): BroadcastChannelLike => ({ postMessage() {}, close() {}, onmessage: null })
const NOOP_STATUS = (_status: EngineStatus): void => {}

/**
 * Start one engine per account and return a teardown that stops them all. The primary comes first in
 * `accounts` (as the connected session's `accounts` list guarantees); order otherwise does not matter.
 *
 * Push: with ≥1 shared account, ALL engines (primary included) share ONE mux'd SSE channel — the push
 * payload is ignored anyway, so one StateChange waking every engine's `sync()` costs a single
 * connection against the per-USER blob/request quota instead of N. With zero shared accounts the mux
 * is never built and the primary opens its own channel exactly as before.
 */
export function startEngineFleet(accounts: readonly FleetAccount[], deps: FleetDeps): () => void {
  const hasShared = accounts.some((account) => !account.isPrimary)
  // Built ONLY when it will be shared: the single-account primary keeps its own direct SSE channel.
  const mux = hasShared ? deps.createPushMux() : undefined
  const engines: SyncEngine[] = []

  for (const account of accounts) {
    const spec: EngineSpec = {
      account,
      isPrimary: account.isPrimary,
      lockName: account.isPrimary ? undefined : `${SYNC_LOCK}:${account.id}`,
      createPush: mux ? mux.handle : undefined,
      createBus: account.isPrimary ? undefined : NOOP_BUS,
      publishStatus: account.isPrimary ? undefined : NOOP_STATUS,
    }
    const engine = deps.createEngine(spec)
    engines.push(engine)
    // Published BEFORE start(): a tree can be clicked the instant it renders, and an engine that is
    // starting still enqueues correctly (the outbox is durable) — whereas an unpublished one resolves
    // to `null` and the click is silently dropped.
    deps.publish(account.id, engine)
    if (account.isPrimary) {
      deps.setActive(engine)
    } else {
      // Register shared accounts always; the primary only in multi-account mode (below), so the
      // single-account path writes NOTHING new to the registry — keeping it byte-for-byte.
      deps.register(account)
    }
    engine.start()
  }
  if (hasShared) {
    const primary = accounts.find((account) => account.isPrimary)
    if (primary) deps.register(primary)
  }

  return () => {
    // Withdraw every handle BEFORE stopping anything: an engine that is releasing its lock must no
    // longer be reachable, or a click landing in this window enqueues onto a dying engine.
    deps.setActive(null)
    for (const account of accounts) deps.publish(account.id, null)
    for (const engine of engines) void engine.stop()
    // Belt-and-braces: each leader engine's stop() already released its mux ref (closing the real
    // channel at ref 0). This force-closes anything a never-elected follower or a mid-election
    // teardown left behind, so no SSE connection can outlive the fleet.
    mux?.closeAll()
  }
}

/**
 * A shared push channel: ONE real {@link PushChannel} multiplexed to N engines. Each engine calls
 * {@link PushMux.handle} in its own `openPush` and receives a lightweight {@link PushChannel} facade;
 * the real channel is opened lazily on the FIRST handle's `open()` (so an all-follower tab, whose
 * engines never open push, opens no connection — exactly as before) and closed when the last handle
 * closes. A StateChange on the real channel fans out to every engine's `subscribe` listener, waking
 * all of their `sync()` passes.
 */
export interface PushMux {
  /** A per-engine facade over the shared channel (matches {@link SyncEngineDeps.createPush}). */
  readonly handle: SyncEngineDeps['createPush']
  /** Force-close the real channel and drop every listener (host teardown). */
  closeAll(): void
}

export function createPushMux(create: SyncEngineDeps['createPush']): PushMux {
  let real: PushChannel | undefined
  /** Open handles holding the real channel; it closes when this returns to 0. */
  let openRefs = 0
  const stateSubs = new Set<StateChangeListener>()
  const statusSubs = new Set<StatusListener>()
  const errorSubs = new Set<PushErrorListener>()
  let realUnsubs: Unsubscribe[] = []

  const ensureReal = (
    session: Session,
    options: Parameters<SyncEngineDeps['createPush']>[1],
  ): void => {
    openRefs += 1
    if (real) return
    const channel = create(session, options)
    realUnsubs = [
      channel.subscribe((change) => {
        for (const listener of [...stateSubs]) listener(change)
      }),
      channel.onStatus((status) => {
        for (const listener of [...statusSubs]) listener(status)
      }),
      channel.onError((error) => {
        for (const listener of [...errorSubs]) listener(error)
      }),
    ]
    real = channel
    channel.open()
  }

  const closeReal = (): void => {
    for (const unsub of realUnsubs) unsub()
    realUnsubs = []
    real?.close()
    real = undefined
  }

  const releaseRef = (): void => {
    if (openRefs > 0) openRefs -= 1
    if (openRefs === 0) closeReal()
  }

  const handle: SyncEngineDeps['createPush'] = (session, options) => {
    let opened = false
    // This engine's own listeners, so close() can detach exactly them from the shared sets.
    const mineState = new Set<StateChangeListener>()
    const mineStatus = new Set<StatusListener>()
    const mineError = new Set<PushErrorListener>()
    const facade: PushChannel = {
      get transport(): PushTransport {
        return real?.transport ?? 'sse'
      },
      get status(): PushStatus {
        return real?.status ?? 'closed'
      },
      open(): void {
        if (opened) return
        opened = true
        ensureReal(session, options)
      },
      close(): void {
        for (const listener of mineState) stateSubs.delete(listener)
        for (const listener of mineStatus) statusSubs.delete(listener)
        for (const listener of mineError) errorSubs.delete(listener)
        mineState.clear()
        mineStatus.clear()
        mineError.clear()
        if (!opened) return
        opened = false
        releaseRef()
      },
      subscribe(listener): Unsubscribe {
        stateSubs.add(listener)
        mineState.add(listener)
        return () => {
          stateSubs.delete(listener)
          mineState.delete(listener)
        }
      },
      onStatus(listener): Unsubscribe {
        statusSubs.add(listener)
        mineStatus.add(listener)
        return () => {
          statusSubs.delete(listener)
          mineStatus.delete(listener)
        }
      },
      onError(listener): Unsubscribe {
        errorSubs.add(listener)
        mineError.add(listener)
        return () => {
          errorSubs.delete(listener)
          mineError.delete(listener)
        }
      },
    }
    return facade
  }

  return {
    handle,
    closeAll(): void {
      openRefs = 0
      closeReal()
      stateSubs.clear()
      statusSubs.clear()
      errorSubs.clear()
    },
  }
}
