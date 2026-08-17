import type { AuthProvider } from './auth'
import type { BlobData, DownloadOptions, UploadOptions, UploadResult } from './blob'
import { downloadBlob, uploadBlob } from './blob'
import { usingForMethods } from './capabilities'
import type { ChunkLimits } from './chunking'
import { planRequest, reassembleResponses, sanitizeLimits } from './chunking'
import { MethodResponses, RequestBuilder } from './request'
import type { GetSessionOptions } from './session'
import { getCoreCapability, getSession } from './session'
import type { FetchLike, Transport } from './transport'
import { postApi, resolveFetch } from './transport'
import type { CreationId, Id, Invocation, JmapRequest, Session } from './types/core'

// Re-exported from its definition site next to `ChunkLimits`/`sanitizeLimits` — the fallbacks are
// now also what an unusable (0/-1/NaN) advertised limit falls back to, not just a missing one.
export { FALLBACK_LIMITS } from './chunking'

/** Options for constructing a {@link JmapClient}. */
export interface JmapClientOptions {
  /** A parsed Session (from {@link getSession} or {@link connect}). */
  session: Session
  /** Auth provider injected into every request. */
  auth: AuthProvider
  /** Injectable fetch (tests / SSR). Defaults to the global `fetch`. */
  fetch?: FetchLike
  /** The URL the Session was fetched from, enabling {@link JmapClient.refreshSession}. */
  sessionUrl?: string
  /** Override any chunking limit (else taken from the Session core capability). */
  limits?: Partial<ChunkLimits>
  /** Invoked when a response's `sessionState` differs from the cached Session state. */
  onSessionStateChange?: (newState: string, oldState: string) => void
}

/** Per-call options for {@link JmapClient.call}. */
export interface CallOptions {
  /** Seed `createdIds` map (RFC 8620 §5.8). */
  createdIds?: Record<CreationId, Id>
  signal?: AbortSignal
}

/**
 * A typed JMAP client: builds the `{ using, methodCalls }` envelope, POSTs it to the
 * session `apiUrl` with auth, auto-chunks against the session limits (FR-SRV-03) and
 * re-assembles the responses transparently. The `using` set is derived automatically
 * from the invoked methods (FR-SRV-02).
 */
export class JmapClient {
  private currentSession: Session
  private readonly transport: Transport
  private readonly sessionUrl: string | undefined
  private readonly overrides: Partial<ChunkLimits>
  private readonly onSessionStateChange: ((newState: string, oldState: string) => void) | undefined

  constructor(options: JmapClientOptions) {
    this.currentSession = options.session
    this.transport = { auth: options.auth, fetch: resolveFetch(options.fetch) }
    this.sessionUrl = options.sessionUrl
    this.overrides = options.limits ?? {}
    this.onSessionStateChange = options.onSessionStateChange
  }

  /** The current Session. */
  get session(): Session {
    return this.currentSession
  }

  /** Replaces the cached Session (e.g. after a `sessionState` change). */
  setSession(session: Session): void {
    this.currentSession = session
  }

  /** Starts a fluent {@link RequestBuilder} bound to this client; call `.send()` to execute. */
  request(): RequestBuilder {
    return new RequestBuilder((builder) => this.call(builder.invocations))
  }

  /**
   * Executes a batch of already-built invocations, chunking and re-assembling as needed.
   * Method-level errors are surfaced through the returned {@link MethodResponses} (they do
   * not throw here); request-level HTTP errors throw.
   */
  async call(calls: Invocation[], options: CallOptions = {}): Promise<MethodResponses> {
    const names = new Map<string, string>()
    for (const [name, , id] of calls) names.set(id, name)

    if (calls.length === 0) {
      return new MethodResponses([], this.currentSession.state, undefined, names)
    }

    const using = usingForMethods(calls.map((call) => call[0]))
    const plan = planRequest(calls, using, this.resolveLimits(), options.createdIds)

    const physicalResponses: Invocation[] = []
    let sessionState = this.currentSession.state
    let createdIds: Record<CreationId, Id> | undefined

    for (const methodCalls of plan.requests) {
      const body: JmapRequest = { using, methodCalls }
      // Thread accumulated createdIds forward (RFC 8620 §5.8): a creation id assigned in an
      // earlier physical request must be resolvable if a later request references it. The
      // server only echoes createdIds back when the request sends the map, so send it whenever
      // the caller seeded one or an earlier chunk produced ids.
      if (options.createdIds || createdIds) {
        body.createdIds = { ...(options.createdIds ?? {}), ...(createdIds ?? {}) }
      }
      const response = await postApi(
        this.currentSession.apiUrl,
        body,
        this.transport,
        options.signal,
      )
      // Appended one by one, not spread: `push(...array)` passes every element as an argument and
      // a server-sized array (hundreds of thousands of invocations) overflows the call stack with
      // a RangeError. The loop has no such ceiling.
      for (const methodResponse of response.methodResponses) physicalResponses.push(methodResponse)
      sessionState = response.sessionState
      if (response.createdIds) createdIds = { ...(createdIds ?? {}), ...response.createdIds }
    }

    const reassembled = reassembleResponses(plan, physicalResponses)
    if (sessionState !== this.currentSession.state) {
      this.onSessionStateChange?.(sessionState, this.currentSession.state)
    }
    return new MethodResponses(reassembled, sessionState, createdIds, names)
  }

  /** Convenience wrapper around `Core/echo` (RFC 8620 §4): returns the echoed arguments. */
  async echo<T>(args: T): Promise<T> {
    const builder = this.request()
    const handle = builder.call('Core/echo', args)
    const result = await builder.send()
    return result.get<T>(handle)
  }

  /**
   * Uploads a blob to the session `uploadUrl` for `accountId` (RFC 8620 §6.1) and returns
   * the stored blob descriptor. Set `options.type` for the media type (default
   * `application/octet-stream`); `options.onProgress` receives start/completion progress.
   */
  upload(accountId: Id, data: BlobData, options: UploadOptions = {}): Promise<UploadResult> {
    return uploadBlob(this.currentSession.uploadUrl, accountId, data, this.transport, options)
  }

  /**
   * Downloads a blob's bytes from the session `downloadUrl` template (RFC 8620 §6.2). `type`
   * and `name` fill the template's `{type}`/`{name}` vars (media type + suggested filename);
   * pass `options.onProgress` for streamed progress.
   */
  download(
    accountId: Id,
    blobId: Id,
    type: string,
    name: string,
    options: DownloadOptions = {},
  ): Promise<Uint8Array> {
    return downloadBlob(
      this.currentSession.downloadUrl,
      { accountId, blobId, type, name },
      this.transport,
      options,
    )
  }

  /** Re-fetches the Session from its original URL and caches it. Requires `sessionUrl`. */
  async refreshSession(options: GetSessionOptions = {}): Promise<Session> {
    if (this.sessionUrl === undefined) {
      throw new Error('Cannot refresh session: no sessionUrl was provided to the client')
    }
    const merged: GetSessionOptions = { fetch: this.transport.fetch, ...options }
    const session = await getSession(this.sessionUrl, this.transport.auth, merged)
    this.currentSession = session
    return session
  }

  /**
   * Override > session core capability > fallback, then sanitized. `??` alone would not do: it
   * only replaces null/undefined, so a server advertising `maxObjectsInSet: 0` (or -1, or NaN)
   * passed straight through to the chunker — {@link sanitizeLimits} is what turns those into the
   * fallback rather than into a frozen tab.
   */
  private resolveLimits(): ChunkLimits {
    const cap = getCoreCapability(this.currentSession)
    return sanitizeLimits({
      maxObjectsInGet: this.overrides.maxObjectsInGet ?? cap?.maxObjectsInGet,
      maxObjectsInSet: this.overrides.maxObjectsInSet ?? cap?.maxObjectsInSet,
      maxCallsInRequest: this.overrides.maxCallsInRequest ?? cap?.maxCallsInRequest,
      maxSizeRequest: this.overrides.maxSizeRequest ?? cap?.maxSizeRequest,
    })
  }
}

/** Options for {@link connect}. */
export interface ConnectOptions extends GetSessionOptions {
  limits?: Partial<ChunkLimits>
  onSessionStateChange?: (newState: string, oldState: string) => void
}

/**
 * Fetches the Session from `input` (origin or well-known URL) and returns a ready
 * {@link JmapClient}. The connection URL is remembered so {@link JmapClient.refreshSession}
 * works out of the box.
 */
export async function connect(
  input: string,
  auth: AuthProvider,
  options: ConnectOptions = {},
): Promise<JmapClient> {
  const fetchImpl = resolveFetch(options.fetch)
  const sessionOptions: GetSessionOptions = { fetch: fetchImpl }
  if (options.signal) sessionOptions.signal = options.signal
  const session = await getSession(input, auth, sessionOptions)
  const clientOptions: JmapClientOptions = { session, auth, fetch: fetchImpl, sessionUrl: input }
  if (options.limits) clientOptions.limits = options.limits
  if (options.onSessionStateChange)
    clientOptions.onSessionStateChange = options.onSessionStateChange
  return new JmapClient(clientOptions)
}
