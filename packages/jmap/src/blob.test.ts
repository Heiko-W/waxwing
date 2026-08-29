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

/**
 * Every byte of a download is buffered before the caller sees any of it, and nothing checked a
 * length: not `content-length`, not the size the envelope already stated, not a cap. One click on
 * an attachment served by a hostile server was enough to OOM the tab.
 */
describe('downloadBlob — the size ceiling (W-11)', () => {
  const session = makeSession()

  function client(fetch: FetchLike): JmapClient {
    return new JmapClient({ session, auth: bearer('tok'), fetch })
  }

  /** A body that never ends — the shape the ceiling exists for. */
  function endlessStream(): { response: Response; cancelled: () => boolean } {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    return {
      response: new Response(body, { status: 200 }),
      cancelled: () => cancelled,
    }
  }

  it('stops an endless body instead of buffering it to death', async () => {
    const endless = endlessStream()
    const jmap = client(async () => endless.response)

    await expect(
      jmap.download('a', 'b1', 'application/octet-stream', 'x.bin', { maxBytes: 256 * 1024 }),
    ).rejects.toBeInstanceOf(JmapError)
    // Cancelled, not merely abandoned: a reader left open keeps the socket draining, which is most
    // of the cost of the thing being refused.
    expect(endless.cancelled()).toBe(true)
  })

  it('refuses on the declared length, before reading the body', async () => {
    let pulls = 0
    const fetch: FetchLike = async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1
          controller.enqueue(new Uint8Array(8))
        },
      })
      return new Response(body, { status: 200, headers: { 'content-length': '999999999' } })
    }

    await expect(
      client(fetch).download('a', 'b1', 'application/octet-stream', 'x.bin', { maxBytes: 1024 }),
    ).rejects.toThrowError(/limit/)
    // The stream itself pre-pulls one chunk; what matters is that the READER never ran. Without
    // the declared-length check this would be 128 pulls (1024 / 8) before the loop gave up.
    expect(pulls).toBeLessThanOrEqual(1)
  })

  it('lets an ordinary blob through untouched — the counter-test', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const jmap = client(async () => new Response(payload, { status: 200 }))

    const bytes = await jmap.download('a', 'b1', 'text/plain', 'x.txt')
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5])
  })

  it('honours maxBytes: 0 as "no ceiling", for a caller that means it', async () => {
    const payload = new Uint8Array(4096)
    const jmap = client(async () => new Response(payload, { status: 200 }))

    const bytes = await jmap.download('a', 'b1', 'text/plain', 'x.bin', { maxBytes: 0 })
    expect(bytes.byteLength).toBe(4096)
  })

  it('still reports progress per chunk while counting — the two are the same loop', async () => {
    const seen: BlobProgress[] = []
    const fetch: FetchLike = async () => {
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 3) {
            controller.close()
            return
          }
          sent += 1
          controller.enqueue(new Uint8Array(10))
        },
      })
      return new Response(body, { status: 200, headers: { 'content-length': '30' } })
    }

    const bytes = await client(fetch).download('a', 'b1', 'text/plain', 'x.bin', {
      onProgress: (progress) => seen.push(progress),
    })
    expect(bytes.byteLength).toBe(30)
    expect(seen.map((p) => p.loaded)).toEqual([10, 20, 30])
  })
})
