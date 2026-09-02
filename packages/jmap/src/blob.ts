/**
 * Blob upload / download (RFC 8620 §6), routed through the same {@link Transport} (auth +
 * injectable fetch) as the API. Uploads POST raw bytes to the session `uploadUrl`
 * (`{accountId}`); downloads GET the session `downloadUrl` URI template
 * (`{accountId}` `{blobId}` `{type}` `{name}`). URLs are expanded strictly from the
 * server-provided template — never constructed by hand.
 */

import { applyAuth } from './auth'
import { errorFromResponse, JmapError } from './errors'
import type { Transport } from './transport'
import type { Id, UnsignedInt } from './types/core'

/** Bytes acceptable as an upload body. */
export type BlobData = Uint8Array | ArrayBuffer | Blob | string

/** Media type used when a caller does not specify one for an upload. */
export const DEFAULT_BLOB_TYPE = 'application/octet-stream'

/** The JSON body returned from a successful blob upload (RFC 8620 §6.1). */
export interface UploadResult {
  accountId: Id
  /** Id of the newly stored blob; reference it from `Email/set`, `Email/parse`, etc. */
  blobId: Id
  /** Media type the server recorded (echoes the request `Content-Type`). */
  type: string
  /** Size of the stored blob in octets. */
  size: UnsignedInt
}

/** Progress of a transfer. `total` is `undefined` when the length is not known ahead of time. */
export interface BlobProgress {
  loaded: number
  total: number | undefined
}

/** Options for {@link uploadBlob}. */
export interface UploadOptions {
  /** Media type sent as `Content-Type` (default {@link DEFAULT_BLOB_TYPE}). */
  type?: string
  signal?: AbortSignal
  /**
   * Progress callback. `fetch` cannot stream upload progress portably, so this fires once at
   * the start (`loaded: 0`) and once on completion (`loaded: total`) — enough to drive a
   * determinate bar, but not incremental.
   */
  onProgress?: (progress: BlobProgress) => void
}

/** The URI-template variables for a download (RFC 8620 §6.2). */
export interface DownloadVars {
  accountId: Id
  blobId: Id
  /** Media type to request; placed wherever the template's `{type}` var sits. */
  type: string
  /** Suggested filename for the `Content-Disposition` header. */
  name: string
}

/** Options for {@link downloadBlob}. */
export interface DownloadOptions {
  signal?: AbortSignal
  /** Progress callback, fired per streamed chunk (true incremental progress). */
  onProgress?: (progress: BlobProgress) => void
  /**
   * Refuse a body larger than this, in bytes. Defaults to {@link DEFAULT_MAX_DOWNLOAD_BYTES};
   * pass `0` to disable the ceiling entirely.
   *
   * A caller that already knows the size — `EmailBodyPart.size` is in the envelope the app
   * downloaded the blob from — should pass it plus a small tolerance, which turns the ceiling
   * from a backstop into an assertion about THIS blob.
   */
  maxBytes?: number
}

/**
 * The ceiling on one download, and the reason there has to be one.
 *
 * Every byte of a blob download is buffered in the heap before the caller sees any of it — the
 * streaming branch accumulates chunks, the other calls `arrayBuffer()`. Nothing checked a length:
 * not `content-length`, not the size the envelope already stated, not a cap. A server answering an
 * ordinary attachment click with an endless byte stream needed one click to OOM the tab, and no
 * hostility is required for the milder version — a very large legitimate file from the Files area
 * did the same thing more slowly.
 *
 * `MAX_CACHED_BLOB_BYTES` in the app is not this: it decides what goes in IndexedDB, after the
 * whole thing has already been read into memory.
 *
 * 256 MB is far above any attachment a JMAP server will accept (`maxSizeUpload` is typically two
 * orders of magnitude smaller) and far below what kills a tab.
 */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

/**
 * Expands an RFC 6570 Level 1 URI template — replacing each `{var}` with the
 * percent-encoded value of `vars[var]`. Throws {@link JmapError} if the template references
 * a variable not supplied. Used for the session upload / download templates.
 *
 * RFC 6570 §3.2.2 percent-encodes everything outside the unreserved set (ALPHA/DIGIT/`-._~`);
 * `encodeURIComponent` additionally leaves `!*'()` intact, so those are escaped afterwards to
 * stay strictly conformant (matters for arbitrary `{name}` filenames like `photo (1).jpg`).
 */
export function expandUriTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new JmapError(`URI template references unknown variable {${name}}: ${template}`)
    }
    return encodeURIComponent(value).replace(
      /[!*'()]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    )
  })
}

/**
 * Uploads `data` to the expanded `uploadTemplate` for `accountId` and returns the stored
 * blob descriptor (RFC 8620 §6.1). Auth is applied via `transport`.
 */
export async function uploadBlob(
  uploadTemplate: string,
  accountId: Id,
  data: BlobData,
  transport: Transport,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const url = expandUriTemplate(uploadTemplate, { accountId })
  const type = options.type ?? DEFAULT_BLOB_TYPE
  const total = byteLengthOf(data)
  const headers = await applyAuth(
    { 'Content-Type': type, Accept: 'application/json' },
    transport.auth,
  )
  // Two calls, at the ends, and that is all `fetch` can give: it has no upload-progress event, and
  // the API that does (`XMLHttpRequest`) is on the wrong side of this package's `Transport` seam.
  // See ADR-034 — the callback stays because it is where a future upload channel would report.
  options.onProgress?.({ loaded: 0, total })
  const init: Parameters<Transport['fetch']>[1] = { method: 'POST', headers, body: data }
  if (options.signal) init.signal = options.signal
  const response = await transport.fetch(url, init)
  if (!response.ok) throw await errorFromResponse(response)
  const result = (await response.json()) as UploadResult
  options.onProgress?.({ loaded: total, total })
  return result
}

/**
 * Downloads the blob addressed by `vars` from the expanded `downloadTemplate` and returns
 * its bytes (RFC 8620 §6.2). When `onProgress` is supplied the body is streamed and progress
 * reported per chunk; otherwise the whole body is buffered. Auth is applied via `transport`.
 */
export async function downloadBlob(
  downloadTemplate: string,
  vars: DownloadVars,
  transport: Transport,
  options: DownloadOptions = {},
): Promise<Uint8Array> {
  const url = expandUriTemplate(downloadTemplate, {
    accountId: vars.accountId,
    blobId: vars.blobId,
    type: vars.type,
    name: vars.name,
  })
  const headers = await applyAuth({}, transport.auth)
  const init: Parameters<Transport['fetch']>[1] = { method: 'GET', headers }
  if (options.signal) init.signal = options.signal
  const response = await transport.fetch(url, init)
  if (!response.ok) throw await errorFromResponse(response)
  return readBody(response, options.onProgress, options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES)
}

/**
 * The error a download that exceeded its ceiling reports — see {@link DEFAULT_MAX_DOWNLOAD_BYTES}.
 *
 * A CLASS rather than a bare {@link JmapError} with a recognisable message, because the app has to
 * tell this refusal apart from a network failure and a 404 in order to say something useful about
 * it, and matching on message text is not a contract. It stays a `JmapError`, so every existing
 * `catch` keeps working.
 */
export class BlobTooLargeError extends JmapError {
  override name = 'BlobTooLargeError'
  constructor(
    /** The ceiling that was in force, in bytes. */
    readonly limit: number,
    /** Bytes seen when the read was abandoned — the declared `content-length` when it was refused
        before a single byte was read. */
    readonly seen: number,
  ) {
    super(`Blob download exceeds the ${String(limit)}-byte limit (stopped at ${String(seen)})`)
  }
}

function tooLarge(limit: number, seen: number): JmapError {
  return new BlobTooLargeError(limit, seen)
}

/** Reads a Response body to a single `Uint8Array`, streaming with progress when a callback is given. */
async function readBody(
  response: Response,
  onProgress: ((progress: BlobProgress) => void) | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  const header = response.headers.get('content-length')
  const total = header !== null && header !== '' ? Number(header) : undefined
  const body = response.body
  const limited = maxBytes > 0

  // The cheap refusal first: a server that declares an oversized body is turned away before a
  // single byte is read. It is only a hint — `content-length` may be absent or a lie — which is
  // why the loop below still counts.
  if (limited && total !== undefined && Number.isFinite(total) && total > maxBytes) {
    throw tooLarge(maxBytes, total)
  }

  // Stream whenever the runtime gives us a body, not only when someone asked for progress. The
  // `arrayBuffer()` branch cannot enforce a ceiling at all: by the time it resolves, the whole
  // thing — endless or not — is already in the heap. In practice this WAS the branch every app
  // download took, because no caller passes `onProgress` to a download.
  if (!body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (limited && bytes.byteLength > maxBytes) throw tooLarge(maxBytes, bytes.byteLength)
    onProgress?.({ loaded: bytes.byteLength, total: total ?? bytes.byteLength })
    return bytes
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    if (limited && loaded > maxBytes) {
      // Cancel rather than merely stop: an abandoned reader leaves the socket draining, which is
      // most of the cost of the attack this refuses.
      await reader.cancel().catch(() => undefined)
      throw tooLarge(maxBytes, loaded)
    }
    onProgress?.({ loaded, total })
  }
  return concatChunks(chunks, loaded)
}

/** Concatenates decoded chunks into one `Uint8Array` of length `total`. */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Octet length of an upload body across the supported {@link BlobData} shapes. */
function byteLengthOf(data: BlobData): number {
  if (typeof data === 'string') return new TextEncoder().encode(data).length
  if (data instanceof Uint8Array) return data.byteLength
  if (data instanceof ArrayBuffer) return data.byteLength
  return data.size
}
