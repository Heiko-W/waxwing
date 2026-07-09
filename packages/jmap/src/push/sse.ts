/**
 * {@link SseChannel} — a **fetch-based** Server-Sent Events push transport.
 *
 * Why fetch and not the native `EventSource`? The SP.3 live probe proved Stalwart's
 * `eventSourceUrl` authenticates *only* via the `Authorization` header (Bearer/Basic);
 * `?access_token=`/`?token=` query params return 401 and there is no auth cookie. The native
 * `EventSource` API cannot set request headers, so it can never authenticate against Stalwart.
 * Waxwing therefore reads the stream with `fetch` + `ReadableStream` and parses the SSE wire
 * format itself ({@link SseParser}), sending the header the server requires.
 *
 * A `?access_token=` query mode is provided behind an explicit `sseAuth: 'query'` option for
 * *other* JMAP servers that support it — Stalwart does not (it 401s), so the default is header.
 *
 * CORS caveat (SP.3): Stalwart emits no CORS headers by default, so a cross-origin fetch-based
 * reader is blocked; serve Waxwing same-origin (FR-DEP-02) or add permissive CORS.
 */

import type { AuthProvider } from '../auth'
import { expandUriTemplate } from '../blob'
import { errorFromResponse, JmapError } from '../errors'
import type { FetchLike } from '../transport'
import { resolveFetch } from '../transport'
import type { Session } from '../types/core'
import type { BaseChannelConfig } from './base'
import { BasePushChannel } from './base'
import type { ConnectionHandle, ConnectionHandlers } from './reconnect'
import { SseParser } from './sse-parser'
import type { PushTransport } from './types'
import { isStateChange, toError } from './util'

/** Where the SSE transport carries its credential. */
export type SseAuthMode = 'header' | 'query'

/** Options for {@link SseChannel}. */
export interface SseChannelOptions extends BaseChannelConfig {
  /** Session providing `eventSourceUrl` (RFC 8620 §7.3 URI template). */
  session: Pick<Session, 'eventSourceUrl'>
  /** Auth provider; supplies the `Authorization` header (or the query token in query mode). */
  auth: AuthProvider
  /** Injectable fetch (tests / SSR). Defaults to the global `fetch`. */
  fetch?: FetchLike
  /** `{types}` template var — the data types to receive; default `*` (all). */
  types?: string
  /** `{closeafter}` template var — `no` (persistent, default) or `state` (one-shot). */
  closeafter?: string
  /**
   * `{ping}` template var — server keep-alive interval hint in SECONDS (RFC 8620 §7.3, a
   * non-negative integer count of seconds), default `30`. Note: Stalwart clamps this to a 30s
   * minimum (SP.3 probe).
   */
  ping?: string
  /** Auth placement: `header` (default, Stalwart) or `query` (`?access_token=`, other servers). */
  sseAuth?: SseAuthMode
  /** Query param name used in `sseAuth: 'query'` mode. Default `access_token`. */
  queryParam?: string
}

export class SseChannel extends BasePushChannel {
  override readonly transport: PushTransport = 'sse'

  private readonly eventSourceUrl: string
  private readonly auth: AuthProvider
  private readonly fetchImpl: FetchLike
  private readonly types: string
  private readonly closeafter: string
  private readonly ping: string
  private readonly sseAuth: SseAuthMode
  private readonly queryParam: string

  /** Persisted so a reconnect can send `Last-Event-ID` where the server supports resumption. */
  private lastEventId = ''
  /** A server-supplied `retry:` floor (ms) applied to the reconnect delay. */
  private serverRetryMs: number | undefined

  constructor(options: SseChannelOptions) {
    super(options)
    this.eventSourceUrl = options.session.eventSourceUrl
    this.auth = options.auth
    this.fetchImpl = resolveFetch(options.fetch)
    this.types = options.types ?? '*'
    this.closeafter = options.closeafter ?? 'no'
    this.ping = options.ping ?? '30'
    this.sseAuth = options.sseAuth ?? 'header'
    this.queryParam = options.queryParam ?? 'access_token'
  }

  protected override retryHint(): number | undefined {
    return this.serverRetryMs
  }

  protected connect(handlers: ConnectionHandlers): ConnectionHandle {
    const controller = new AbortController()
    let disposed = false
    const close = () => {
      if (disposed) return
      disposed = true
      controller.abort()
    }
    void this.run(handlers, controller.signal, () => disposed).catch((error: unknown) => {
      if (disposed || controller.signal.aborted) return
      handlers.reportClosed(toError(error))
    })
    return { close }
  }

  private async run(
    handlers: ConnectionHandlers,
    signal: AbortSignal,
    isDisposed: () => boolean,
  ): Promise<void> {
    const url = await this.buildUrl()
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    if (this.sseAuth === 'header') headers.Authorization = await this.auth.authorization()
    if (this.lastEventId !== '') headers['Last-Event-ID'] = this.lastEventId
    if (isDisposed()) return

    const response = await this.fetchImpl(url, { method: 'GET', headers, signal })
    if (!response.ok) throw await errorFromResponse(response)
    const body = response.body
    if (!body) throw new JmapError('SSE response has no readable body')
    handlers.reportOpen()

    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
        this.handleEvent(event.data)
      }
      const { lastEventId, retry } = parser.streamState
      this.lastEventId = lastEventId
      if (retry !== undefined) this.serverRetryMs = retry
    }
    if (isDisposed() || signal.aborted) return
    // The stream ended without our asking (server closed / restarted): reconnect, no error.
    handlers.reportClosed()
  }

  /** Expands the eventSource URI template and, in query mode, appends the credential. */
  private async buildUrl(): Promise<string> {
    const expanded = expandUriTemplate(this.eventSourceUrl, {
      types: this.types,
      closeafter: this.closeafter,
      ping: this.ping,
    })
    if (this.sseAuth !== 'query') return expanded
    const token = await this.auth.token?.()
    if (token === undefined) {
      throw new JmapError(`Auth scheme "${this.auth.scheme}" has no query-param token form`)
    }
    const url = new URL(expanded)
    url.searchParams.set(this.queryParam, token)
    return url.href
  }

  /** Parses one SSE event payload as JSON and, if it is a StateChange, fans it out. */
  private handleEvent(data: string): void {
    if (data === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return // non-JSON keep-alive / comment payload
    }
    if (isStateChange(parsed)) this.emitStateChange(parsed)
  }
}
