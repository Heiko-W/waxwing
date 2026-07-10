/**
 * {@link PollingChannel} — the last-resort JMAP push transport (M1.3; realizes the SP.3 stub).
 *
 * When a server advertises neither a push-capable WebSocket nor an `eventSourceUrl`, there is no
 * server-initiated push at all. This transport approximates one by periodically re-fetching the
 * Session (RFC 8620 §2) and watching its opaque `state` string, which the server bumps whenever
 * ANY account data changes. On a change it emits a {@link StateChange} whose `changed` maps every
 * account id to an EMPTY type map — a coarse "something changed, resync" signal: polling the
 * session state cannot reveal WHICH data types changed, so the consuming sync engine responds by
 * running its per-type `changes` delta sweep for all watched types (exactly the reconnect-resync path it
 * already needs, since Stalwart offers no SSE `Last-Event-ID` resumption either).
 *
 * It extends {@link BasePushChannel}, so it inherits the shared status plumbing and reconnect loop:
 * the first successful poll reports `open`, a failed fetch reports the drop and the loop backs off
 * and retries. Deliberately coarse and heavier than SSE/WS — it exists only for servers where
 * neither real transport is available.
 */

import type { AuthProvider } from '../auth'
import { getSession } from '../session'
import { type FetchLike, resolveFetch } from '../transport'
import type { Session } from '../types/core'
import type { StateChange } from '../types/push'
import { type BaseChannelConfig, BasePushChannel } from './base'
import type { ConnectionHandle, ConnectionHandlers } from './reconnect'
import { defaultScheduler, type PushTransport, type SchedulerLike } from './types'
import { toError } from './util'

/** Default interval between session polls (ms). */
export const DEFAULT_POLL_INTERVAL_MS = 30_000

export interface PollingChannelOptions extends BaseChannelConfig {
  /** The current Session — its `state` is the baseline and `accounts` name the resync scope. */
  session: Session
  /** Auth provider supplying the `Authorization` header for the session re-fetch. */
  auth: AuthProvider
  /** Injectable fetch (tests / SSR). Defaults to the global `fetch`. */
  fetch?: FetchLike
  /**
   * The URL to re-fetch the Session from. Defaults to the origin of `session.apiUrl` (getSession
   * appends the well-known path). Pass an explicit session/well-known URL for non-standard mounts.
   */
  sessionUrl?: string
  /** Poll interval in ms. Default {@link DEFAULT_POLL_INTERVAL_MS}. */
  intervalMs?: number
}

export class PollingChannel extends BasePushChannel {
  override readonly transport: PushTransport = 'polling'

  private readonly auth: AuthProvider
  private readonly fetchImpl: FetchLike
  private readonly sessionUrl: string
  private readonly intervalMs: number
  private readonly scheduler: SchedulerLike
  /** The last observed session state; persists across reconnects so an outage is caught up on. */
  private lastState: string

  constructor(options: PollingChannelOptions) {
    super(options)
    this.auth = options.auth
    this.fetchImpl = resolveFetch(options.fetch)
    this.sessionUrl = options.sessionUrl ?? originOf(options.session.apiUrl)
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.scheduler = options.scheduler ?? defaultScheduler
    this.lastState = options.session.state
  }

  protected connect(handlers: ConnectionHandlers): ConnectionHandle {
    const controller = new AbortController()
    let cancelPoll: (() => void) | undefined
    let disposed = false
    let opened = false

    const close = () => {
      if (disposed) return
      disposed = true
      cancelPoll?.()
      cancelPoll = undefined
      controller.abort()
    }

    const scheduleNext = () => {
      if (disposed) return
      cancelPoll = this.scheduler.setTimeout(() => {
        cancelPoll = undefined
        void tick()
      }, this.intervalMs)
    }

    const tick = async () => {
      if (disposed) return
      let session: Session
      try {
        session = await getSession(this.sessionUrl, this.auth, {
          fetch: this.fetchImpl,
          signal: controller.signal,
        })
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        // The reconnect loop backs off and calls connect() again.
        handlers.reportClosed(toError(error))
        return
      }
      if (disposed) return
      if (!opened) {
        opened = true
        handlers.reportOpen()
      }
      if (session.state !== this.lastState) {
        this.lastState = session.state
        this.emitStateChange(resync(session))
      }
      scheduleNext()
    }

    // First poll fires immediately — it doubles as the connectivity check that reports `open`.
    void tick()
    return { close }
  }
}

/** A coarse "resync every account" StateChange: the poller cannot tell which types changed. */
function resync(session: Session): StateChange {
  const changed: Record<string, Record<string, string>> = {}
  for (const accountId of Object.keys(session.accounts)) changed[accountId] = {}
  return { '@type': 'StateChange', changed }
}

function originOf(apiUrl: string): string {
  try {
    return new URL(apiUrl).origin
  } catch {
    return apiUrl
  }
}
