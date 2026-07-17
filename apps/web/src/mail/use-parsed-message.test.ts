import { renderHook, waitFor } from '@testing-library/react'
import type { Email } from '@waxwing/jmap'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SessionContext } from '../app/session/context'
import type { SessionContextValue } from '../app/session/types'
import { useParsedMessage } from './use-parsed-message'

/** The Email/parse response the fake client hands back for a given blobId. */
interface ParseResult {
  parsed: Record<string, Email>
  notParsable: string[]
  notFound: string[]
}

/** A minimal parsed Email — only the fields the hook forwards. */
function parsedEmail(over: Partial<Email> = {}): Email {
  return {
    subject: 'Nested subject',
    from: [{ name: 'Alice', email: 'alice@x.test' }],
    to: null,
    sentAt: '2026-07-12T14:30:00Z',
    preview: 'nested preview',
    textBody: [],
    htmlBody: [],
    bodyValues: {},
    ...over,
  } as unknown as Email
}

/**
 * A fake JMAP client whose request builder records the invoke() args and returns `result` (or
 * throws `error`). Mirrors the real fluent shape: request() -> {invoke, send}, send() -> {get}.
 */
function fakeClient(options: {
  result?: ParseResult
  error?: unknown
  onInvoke?: (args: unknown) => void
}) {
  return {
    request: () => {
      let token: symbol
      return {
        invoke: (_method: unknown, args: unknown) => {
          options.onInvoke?.(args)
          token = Symbol('parse')
          return token
        },
        send: async () => {
          if (options.error !== undefined) throw options.error
          return { get: (_t: unknown) => options.result }
        },
      }
    },
  }
}

function wrapperFor(client: unknown): (props: { children: ReactNode }) => ReactNode {
  const session = {
    getClient: () => client,
  } as unknown as SessionContextValue
  return ({ children }) => createElement(SessionContext.Provider, { value: session }, children)
}

describe('useParsedMessage', () => {
  it('names bodyValues in properties and fetches all body values (the SP.4 caveat)', async () => {
    const onInvoke = vi.fn()
    const client = fakeClient({
      result: { parsed: { b1: parsedEmail() }, notParsable: [], notFound: [] },
      onInvoke,
    })
    renderHook(() => useParsedMessage('a', 'b1'), { wrapper: wrapperFor(client) })

    await waitFor(() => expect(onInvoke).toHaveBeenCalled())
    const args = onInvoke.mock.calls[0]?.[0] as {
      properties: string[]
      fetchAllBodyValues: boolean
      maxBodyValueBytes: number
      blobIds: string[]
    }
    // Omitting bodyValues makes Stalwart return an empty body with NO error — the one thing that
    // must never regress.
    expect(args.properties).toContain('bodyValues')
    expect(args.properties).toContain('htmlBody')
    expect(args.fetchAllBodyValues).toBe(true)
    expect(args.maxBodyValueBytes).toBeGreaterThan(0)
    expect(args.blobIds).toEqual(['b1'])
  })

  it('starts in loading, never idle (no error flash before the effect runs)', () => {
    const client = fakeClient({
      result: { parsed: { b1: parsedEmail() }, notParsable: [], notFound: [] },
    })
    const { result } = renderHook(() => useParsedMessage('a', 'b1'), {
      wrapper: wrapperFor(client),
    })
    // The synchronous first render — before the passive effect fires — must be loading, not an
    // idle {loading:false, message:null} that the view would paint as a terminal error.
    expect(result.current.loading).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('returns the parsed message on success', async () => {
    const message = parsedEmail({ subject: 'Quarterly report' })
    const client = fakeClient({
      result: { parsed: { b1: message }, notParsable: [], notFound: [] },
    })
    const { result } = renderHook(() => useParsedMessage('a', 'b1'), {
      wrapper: wrapperFor(client),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.message?.subject).toBe('Quarterly report')
    expect(result.current.error).toBeNull()
  })

  it('reports notParsable when the blob is not a message', async () => {
    const client = fakeClient({
      result: { parsed: {}, notParsable: ['b1'], notFound: [] },
    })
    const { result } = renderHook(() => useParsedMessage('a', 'b1'), {
      wrapper: wrapperFor(client),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('notParsable')
    expect(result.current.message).toBeNull()
  })

  it('reports offline when there is no client', async () => {
    const { result } = renderHook(() => useParsedMessage('a', 'b1'), { wrapper: wrapperFor(null) })
    await waitFor(() => expect(result.current.error).toBe('offline'))
    expect(result.current.loading).toBe(false)
  })

  it('reads a transport failure as offline, a method error as failed', async () => {
    const offline = fakeClient({ error: new TypeError('Failed to fetch') })
    const off = renderHook(() => useParsedMessage('a', 'b1'), { wrapper: wrapperFor(offline) })
    await waitFor(() => expect(off.result.current.error).toBe('offline'))

    const failed = fakeClient({ error: new Error('serverFail') })
    const bad = renderHook(() => useParsedMessage('a', 'b1'), { wrapper: wrapperFor(failed) })
    await waitFor(() => expect(bad.result.current.error).toBe('failed'))
  })
})
