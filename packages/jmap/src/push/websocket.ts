/**
 * {@link WebSocketChannel} — a JMAP-over-WebSocket transport (RFC 8887).
 *
 * Detects the `urn:ietf:params:jmap:websocket` capability, negotiates the `jmap` subprotocol,
 * frames `Request`/`Response`/`WebSocketPushEnable`/`StateChange` messages, correlates
 * request/response pairs by `id`, and maps a `RequestError` frame onto {@link JmapRequestError}.
 *
 * Browser caveat (SP.3 probe): Stalwart's WS handshake accepts *only* the `Authorization`
 * header, which browsers cannot set on a `WebSocket` — there is no query-param or subprotocol
 * token fallback. So against Stalwart this transport is usable from Node/undici (which *can*
 * set the header) and future server-side contexts, but **not** from a browser; browsers use
 * {@link SseChannel}. The channel still works browser-side against any server that accepts an
 * unauthenticated or cookie-authenticated WS.
 */

import type { AuthProvider } from '../auth'
import { usingForMethods } from '../capabilities'
import { JmapError, JmapRequestError } from '../errors'
import { MethodResponses, RequestBuilder } from '../request'
import type { Invocation, Session } from '../types/core'
import type { WebSocketPushEnable, WsRequest, WsRequestError, WsResponse } from '../types/push'
import type { BaseChannelConfig } from './base'
import { BasePushChannel } from './base'
import type { ConnectionHandle, ConnectionHandlers } from './reconnect'
import {
  type PushTransport,
  type WebSocketConnectInfo,
  type WebSocketFactory,
  type WebSocketLike,
  WS_OPEN,
} from './types'
import { isStateChange, toError } from './util'

/** The value under `session.capabilities['urn:ietf:params:jmap:websocket']` (RFC 8887 §3). */
export interface WebSocketCapability {
  /** `ws:`/`wss:` URL of the JMAP WebSocket endpoint. */
  url: string
  /** Whether the server pushes `StateChange` over this socket. */
  supportsPush: boolean
}

const WEBSOCKET_CAPABILITY = 'urn:ietf:params:jmap:websocket'
const JMAP_SUBPROTOCOL = 'jmap'

/** Reads the RFC 8887 WebSocket capability from a Session, or `null` if unadvertised. */
export function getWebSocketCapability(
  session: Pick<Session, 'capabilities'>,
): WebSocketCapability | null {
  const value = session.capabilities[WEBSOCKET_CAPABILITY]
  if (typeof value !== 'object' || value === null) return null
  const cap = value as { url?: unknown; supportsPush?: unknown }
  if (typeof cap.url !== 'string') return null
  return { url: cap.url, supportsPush: cap.supportsPush === true }
}

/** Options for {@link WebSocketChannel}. */
export interface WebSocketChannelOptions extends BaseChannelConfig {
  /** Session advertising the `urn:ietf:params:jmap:websocket` capability. */
  session: Pick<Session, 'capabilities'>
  /** Auth provider; supplies the `Authorization` header for the handshake. */
  auth: AuthProvider
  /** Override the WS URL (else taken from the session capability). */
  url?: string
  /** Injectable WebSocket factory (tests / header-capable Node impl). */
  WebSocket?: WebSocketFactory
  /** Types to receive via `WebSocketPushEnable`; `null`/omitted ⇒ all types. */
  dataTypes?: string[] | null
  /** Optional `pushState` to resume from where the server supports it. */
  pushState?: string
}

/** A request awaiting its correlated {@link WsResponse}. */
interface PendingRequest {
  resolve: (responses: MethodResponses) => void
  reject: (error: Error) => void
  names: Map<string, string>
}

export class WebSocketChannel extends BasePushChannel {
  override readonly transport: PushTransport = 'websocket'

  private readonly wsUrl: string
  private readonly auth: AuthProvider
  private readonly factory: WebSocketFactory
  private readonly dataTypes: string[] | null | undefined
  private readonly pushState: string | undefined

  private socket: WebSocketLike | undefined
  private seq = 0
  private readonly pending = new Map<string, PendingRequest>()

  constructor(options: WebSocketChannelOptions) {
    super(options)
    const url = options.url ?? getWebSocketCapability(options.session)?.url
    if (url === undefined) {
      throw new JmapError(
        'Session does not advertise urn:ietf:params:jmap:websocket; pass options.url to override',
      )
    }
    this.wsUrl = url
    this.auth = options.auth
    this.factory = options.WebSocket ?? defaultWebSocketFactory
    this.dataTypes = options.dataTypes
    this.pushState = options.pushState
  }

  /**
   * Starts a {@link RequestBuilder} that dispatches its batch over this socket (RFC 8887 §4)
   * and resolves to a {@link MethodResponses} view — the same typed surface as `JmapClient`.
   * Rejects if the socket is not open.
   */
  request(): RequestBuilder {
    return new RequestBuilder((builder) => this.dispatch(builder.invocations, builder.names))
  }

  protected connect(handlers: ConnectionHandlers): ConnectionHandle {
    let disposed = false
    let socket: WebSocketLike | undefined
    const close = () => {
      if (disposed) return
      disposed = true
      this.failPending(new JmapError('WebSocket channel closed'))
      this.socket = undefined
      try {
        socket?.close(1000)
      } catch {
        // best-effort close
      }
    }

    void (async () => {
      let info: WebSocketConnectInfo
      try {
        info = {
          protocols: [JMAP_SUBPROTOCOL],
          headers: { Authorization: await this.auth.authorization() },
        }
      } catch (error) {
        if (!disposed) handlers.reportClosed(toError(error))
        return
      }
      if (disposed) return
      try {
        socket = this.factory(this.wsUrl, info)
      } catch (error) {
        handlers.reportClosed(toError(error))
        return
      }
      this.socket = socket
      socket.onopen = () => {
        if (disposed) return
        this.sendPushEnable(socket as WebSocketLike)
        handlers.reportOpen()
      }
      socket.onmessage = (event) => {
        if (!disposed) this.handleMessage(event.data)
      }
      socket.onclose = (event) => {
        if (disposed) return
        this.socket = undefined
        this.failPending(new JmapError('WebSocket closed before response'))
        // Clean close (1000/1005) ⇒ reconnect without an error; anything else is abnormal.
        const code = event.code
        const abnormal = code !== undefined && code !== 1000 && code !== 1005
        handlers.reportClosed(
          abnormal ? new JmapError(`WebSocket closed (code ${code})`) : undefined,
        )
      }
      socket.onerror = () => {
        // undici/browsers fire `error` immediately before `close`; let `close` drive the
        // reconnect so a drop is reported exactly once.
      }
    })()

    return { close }
  }

  private sendPushEnable(socket: WebSocketLike): void {
    const frame: WebSocketPushEnable = { '@type': 'WebSocketPushEnable' }
    if (this.dataTypes !== undefined) frame.dataTypes = this.dataTypes
    if (this.pushState !== undefined) frame.pushState = this.pushState
    socket.send(JSON.stringify(frame))
  }

  private dispatch(calls: Invocation[], names: Map<string, string>): Promise<MethodResponses> {
    const socket = this.socket
    if (!socket || socket.readyState !== WS_OPEN) {
      return Promise.reject(new JmapError('WebSocket is not open'))
    }
    const id = `w${this.seq++}`
    const frame: WsRequest = {
      '@type': 'Request',
      id,
      using: usingForMethods(calls.map((call) => call[0])),
      methodCalls: calls,
    }
    return new Promise<MethodResponses>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, names })
      try {
        socket.send(JSON.stringify(frame))
      } catch (error) {
        this.pending.delete(id)
        reject(toError(error))
      }
    })
  }

  private handleMessage(data: unknown): void {
    const text = toText(data)
    if (text === null) return
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (isStateChange(frame)) {
      this.emitStateChange(frame)
      return
    }
    const typed = frame as { '@type'?: unknown }
    if (typed['@type'] === 'Response') {
      this.resolveResponse(frame as WsResponse)
    } else if (typed['@type'] === 'RequestError') {
      this.rejectRequestError(frame as WsRequestError)
    }
  }

  private resolveResponse(response: WsResponse): void {
    const id = response.requestId
    const pending = id !== undefined ? this.pending.get(id) : undefined
    if (!pending || id === undefined) return
    this.pending.delete(id)
    pending.resolve(
      new MethodResponses(
        response.methodResponses,
        response.sessionState,
        response.createdIds,
        pending.names,
      ),
    )
  }

  private rejectRequestError(frame: WsRequestError): void {
    const error = new JmapRequestError(frame)
    const id = frame.requestId
    const pending = id !== undefined ? this.pending.get(id) : undefined
    if (pending && id !== undefined) {
      this.pending.delete(id)
      pending.reject(error)
    } else {
      this.emitError(error)
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

/** Decodes a WebSocket text-frame payload to a string; returns null for unusable binary. */
function toText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as ArrayBufferView)
  return null
}

/**
 * Default WebSocket factory. In Node/undici it forwards the `Authorization` header via the
 * non-standard options object (which is exactly how Stalwart's handshake is authenticated);
 * in a browser it falls back to the standard `(url, protocols)` form, which cannot carry the
 * header — see the class-level browser caveat.
 */
function defaultWebSocketFactory(url: string, info: WebSocketConnectInfo): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
  if (typeof Ctor !== 'function') {
    throw new JmapError('No WebSocket implementation available; pass one via options.WebSocket')
  }
  const nodeVersions = (globalThis as { process?: { versions?: { node?: string } } }).process
    ?.versions?.node
  if (nodeVersions !== undefined && Object.keys(info.headers).length > 0) {
    return new Ctor(url, {
      protocols: info.protocols,
      headers: info.headers,
    }) as unknown as WebSocketLike
  }
  return new Ctor(url, info.protocols) as unknown as WebSocketLike
}

/** Loose WebSocket constructor type covering both the DOM and undici (options object) forms. */
type WebSocketCtor = new (url: string, protocolsOrOptions?: unknown) => unknown
