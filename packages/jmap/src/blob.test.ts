import { describe, expect, it } from 'vitest'
import { bearer } from './auth'
import { type BlobProgress, expandUriTemplate } from './blob'
import { JmapClient } from './client'
import { JmapError } from './errors'
import { at, makeSession } from './test-support'
import type { FetchLike } from './transport'

describe('expandUriTemplate (RFC 6570 Level 1)', () => {
  it('substitutes each {var} with its percent-encoded value', () => {
    expect(expandUriTemplate('/u/{accountId}', { accountId: 'a b' })).toBe('/u/a%20b')
    expect(
      expandUriTemplate('/d/{accountId}/{blobId}?type={type}', {
        accountId: 'a',
        blobId: 'B/1',
        type: 'image/png',
      }),
    ).toBe('/d/a/B%2F1?type=image%2Fpng')
  })

  it('throws when a template variable is not supplied', () => {
    expect(() => expandUriTemplate('/u/{accountId}/{missing}', { accountId: 'a' })).toThrow()
  })

  it("percent-encodes RFC 6570 chars that encodeURIComponent leaves raw (!*'())", () => {
    // A suggested {name} filename with spaces + parentheses must be fully escaped per RFC 6570 §3.2.2.
    expect(expandUriTemplate('/d/{name}', { name: 'photo (1).jpg' })).toBe('/d/photo%20%281%29.jpg')
    expect(expandUriTemplate('/d/{name}', { name: "a!b*c'd" })).toBe('/d/a%21b%2Ac%27d')
  })
})

describe('JmapClient.upload', () => {
  it('POSTs raw bytes to the templated uploadUrl with auth + Content-Type and returns the descriptor', async () => {
    let seenUrl = ''
    let seenMethod = ''
    let seenHeaders: Record<string, string> = {}
    let seenBody: unknown
    const fetch: FetchLike = async (url, init) => {
      seenUrl = url
      seenMethod = init?.method ?? ''
      seenHeaders = { ...(init?.headers ?? {}) }
      seenBody = init?.body
      return new Response(
        JSON.stringify({ accountId: 'a', blobId: 'G-123', type: 'text/plain', size: 5 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const progress: BlobProgress[] = []
    const client = new JmapClient({ session: makeSession(), auth: bearer('tok'), fetch })
    const data = new TextEncoder().encode('hello')
    const result = await client.upload('a', data, {
      type: 'text/plain',
      onProgress: (p) => progress.push(p),
    })

    // {accountId} filled in the upload template.
    expect(seenUrl).toBe('https://mail.waxwing.test/jmap/upload/a')
    expect(seenMethod).toBe('POST')
    expect(seenHeaders['Content-Type']).toBe('text/plain')
    expect(seenHeaders.Authorization).toBe('Bearer tok')
    // Body forwarded unchanged (no copy).
    expect(seenBody).toBe(data)
    // Parsed descriptor.
    expect(result).toEqual({ accountId: 'a', blobId: 'G-123', type: 'text/plain', size: 5 })
    // Progress brackets the transfer with the known total (5 octets of "hello").
    expect(at(progress, 0)).toEqual({ loaded: 0, total: 5 })
    expect(at(progress, progress.length - 1)).toEqual({ loaded: 5, total: 5 })
  })

  it('defaults the Content-Type to application/octet-stream', async () => {
    let seenType = ''
    const fetch: FetchLike = async (_url, init) => {
      seenType = init?.headers?.['Content-Type'] ?? ''
      return new Response(
        JSON.stringify({ accountId: 'a', blobId: 'b', type: seenType, size: 1 }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    await client.upload('a', new Uint8Array([1]))
    expect(seenType).toBe('application/octet-stream')
  })
})

describe('JmapClient.download', () => {
  it('GETs the templated downloadUrl ({accountId}/{blobId}/{name} + encoded {type}) and streams bytes with progress', async () => {
    const payload = new TextEncoder().encode('PNG-BYTES')
    let seenUrl = ''
    let seenAuth = ''
    const fetch: FetchLike = async (url, init) => {
      seenUrl = url
      seenAuth = init?.headers?.Authorization ?? ''
      return new Response(payload, {
        status: 200,
        headers: {
          'content-length': String(payload.byteLength),
          'content-type': 'image/png',
        },
      })
    }

    const progress: BlobProgress[] = []
    const client = new JmapClient({ session: makeSession(), auth: bearer('tok'), fetch })
    const bytes = await client.download('a', 'blob-9', 'image/png', 'pic.png', {
      onProgress: (p) => progress.push(p),
    })

    // Template: .../download/{accountId}/{blobId}/{name}?type={type}
    // {type} carries a slash → percent-encoded by Level 1 expansion.
    expect(seenUrl).toBe(
      'https://mail.waxwing.test/jmap/download/a/blob-9/pic.png?type=image%2Fpng',
    )
    expect(seenAuth).toBe('Bearer tok')
    // Bytes round-trip exactly.
    expect(new TextDecoder().decode(bytes)).toBe('PNG-BYTES')
    expect(bytes).toEqual(payload)
    // Streamed progress reaches the total.
    const last = at(progress, progress.length - 1)
    expect(last.loaded).toBe(payload.byteLength)
    expect(last.total).toBe(payload.byteLength)
  })

  it('buffers the body (no streaming) when no progress callback is given', async () => {
    const payload = new TextEncoder().encode('data')
    const fetch: FetchLike = async () =>
      new Response(payload, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    const bytes = await client.download('a', 'b', 'application/octet-stream', 'f.bin')
    expect(bytes).toEqual(payload)
  })

  it('reports total: undefined while streaming a body with no content-length', async () => {
    const payload = new TextEncoder().encode('streamed-bytes')
    // A streamed (chunked) body carries no content-length header, so the total is unknown.
    const fetch: FetchLike = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload)
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    }
    const progress: BlobProgress[] = []
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    const bytes = await client.download('a', 'b', 'application/octet-stream', 'f.bin', {
      onProgress: (p) => progress.push(p),
    })
    expect(new TextDecoder().decode(bytes)).toBe('streamed-bytes')
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((p) => p.total === undefined)).toBe(true)
  })
})

describe('blob transfer — error responses', () => {
  it('throws a JmapError when the upload response is not ok', async () => {
    const fetch: FetchLike = async () =>
      new Response('too large', { status: 413, headers: { 'content-type': 'text/plain' } })
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    await expect(client.upload('a', new Uint8Array([1, 2, 3]))).rejects.toThrow(JmapError)
  })

  it('throws a JmapError when the download response is not ok', async () => {
    const fetch: FetchLike = async () => new Response('gone', { status: 404 })
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    await expect(client.download('a', 'b', 'application/octet-stream', 'f.bin')).rejects.toThrow(
      JmapError,
    )
  })
})
