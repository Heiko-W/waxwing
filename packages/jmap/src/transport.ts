import type { AuthProvider } from './auth'
import { applyAuth } from './auth'
import { errorFromResponse, JmapError } from './errors'
import type { JmapRequest, JmapResponse } from './types/core'

/**
 * The subset of the WHATWG `fetch` signature this package uses. Injectable so tests can
 * supply a mock and SSR/worker environments can pass a custom implementation.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string | Uint8Array | ArrayBuffer | Blob
    signal?: AbortSignal
  },
) => Promise<Response>

/** Shared transport dependencies threaded through every network call. */
export interface Transport {
  auth: AuthProvider
  fetch: FetchLike
}

/** Resolves the effective fetch implementation, defaulting to the global one. */
export function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis) as FetchLike
  throw new TypeError('No fetch implementation available; pass one via options.fetch')
}

/**
 * POSTs a JMAP {@link JmapRequest} to `apiUrl` and parses the {@link JmapResponse}.
 * Maps HTTP failures to typed errors (RFC 8620 §3.6.1) via {@link errorFromResponse}.
 *
 * The parsed body is narrowed rather than cast: a 200 whose JSON is `null`, a bare array, or
 * `{ methodResponses: null }` used to sail through the `as` and only blow up in the caller, as a
 * `TypeError` from `push(...response.methodResponses)` — which the sync layer classifies as
 * TRANSIENT and therefore RETRIES, hammering a server that will never answer differently. A
 * {@link JmapError} says what is actually wrong, once.
 */
export async function postApi(
  apiUrl: string,
  request: JmapRequest,
  transport: Transport,
  signal?: AbortSignal,
): Promise<JmapResponse> {
  const headers = await applyAuth(
    { 'Content-Type': 'application/json', Accept: 'application/json' },
    transport.auth,
  )
  const init: Parameters<FetchLike>[1] = {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  }
  if (signal) init.signal = signal
  const response = await transport.fetch(apiUrl, init)
  if (!response.ok) throw await errorFromResponse(response)
  const body: unknown = await response.json().catch(() => undefined)
  if (!isJmapResponse(body)) {
    throw new JmapError(
      'Malformed JMAP response: expected { methodResponses: [...], sessionState: "…" } (RFC 8620 §3.4)',
    )
  }
  return body
}

/**
 * Narrows a parsed 200 body to a {@link JmapResponse}. Only the two properties RFC 8620 §3.4
 * makes mandatory are checked — the individual invocations stay unvalidated, because a method
 * response's shape is the method's business and a strict envelope check must not reject a server
 * that returns something newer than this library knows.
 */
function isJmapResponse(value: unknown): value is JmapResponse {
  if (typeof value !== 'object' || value === null) return false
  const body = value as { methodResponses?: unknown; sessionState?: unknown }
  return Array.isArray(body.methodResponses) && typeof body.sessionState === 'string'
}

/** GETs a URL with auth applied; returns the raw Response (used by session + blob fetch). */
export async function getWithAuth(
  url: string,
  transport: Transport,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = await applyAuth({ Accept: 'application/json' }, transport.auth)
  const init: Parameters<FetchLike>[1] = { method: 'GET', headers }
  if (signal) init.signal = signal
  return transport.fetch(url, init)
}
