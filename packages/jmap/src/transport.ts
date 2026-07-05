import type { AuthProvider } from './auth'
import { applyAuth } from './auth'
import { errorFromResponse } from './errors'
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
  return (await response.json()) as JmapResponse
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
