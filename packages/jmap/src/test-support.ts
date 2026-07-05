import type { ChunkLimits } from './chunking'
import type { FetchLike } from './transport'
import type { Invocation, JmapRequest, JmapResponse, Session } from './types/core'

/**
 * Shared helpers for the `@waxwing/jmap` unit tests. Not part of the published surface
 * (only `index.ts` is bundled into `dist`).
 */

/** Returns `arr[i]`, throwing if it is absent — keeps tests terse under `noUncheckedIndexedAccess`. */
export function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index]
  if (value === undefined) throw new Error(`Expected element at index ${index}`)
  return value
}

/** Builds a minimal but conformant Session with the given core-capability limits. */
export function makeSession(limits: Partial<ChunkLimits> = {}): Session {
  const core: ChunkLimits = {
    maxObjectsInGet: 256,
    maxObjectsInSet: 256,
    maxCallsInRequest: 32,
    maxSizeRequest: 10_000_000,
    ...limits,
  }
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': {
        maxSizeUpload: 50_000_000,
        maxConcurrentUpload: 4,
        maxSizeRequest: core.maxSizeRequest,
        maxConcurrentRequests: 4,
        maxCallsInRequest: core.maxCallsInRequest,
        maxObjectsInGet: core.maxObjectsInGet,
        maxObjectsInSet: core.maxObjectsInSet,
        collationAlgorithms: ['i;ascii-numeric'],
      },
      'urn:ietf:params:jmap:mail': {},
    },
    accounts: {
      a: {
        name: 'alice@waxwing.test',
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {},
      },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' },
    username: 'alice@waxwing.test',
    apiUrl: 'https://mail.waxwing.test/jmap/api',
    downloadUrl: 'https://mail.waxwing.test/jmap/download/{accountId}/{blobId}/{name}?type={type}',
    uploadUrl: 'https://mail.waxwing.test/jmap/upload/{accountId}',
    eventSourceUrl:
      'https://mail.waxwing.test/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}',
    state: 's0',
  }
}

/** A recorded HTTP POST made to the mock. */
export interface RecordedCall {
  url: string
  headers: Record<string, string>
  body: JmapRequest
}

/**
 * A fetch mock that records every JMAP POST and returns whatever the `respond` callback
 * produces. Use {@link autoRespond} for a sensible default responder.
 */
export function jmapPostMock(respond: (body: JmapRequest, callIndex: number) => JmapResponse): {
  fetch: FetchLike
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JmapRequest
    calls.push({ url, headers: { ...(init?.headers ?? {}) }, body })
    const payload = respond(body, calls.length - 1)
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, calls }
}

/**
 * Default responder: echoes `Core/echo`, resolves `/get` to `{ id }` objects for each
 * requested id (or two placeholders when the ids came via a `#ids` back-reference), and
 * returns a fixed `Email/query` result. Good enough to exercise the client plumbing.
 */
export function autoRespond(body: JmapRequest, sessionState = 's0'): JmapResponse {
  const methodResponses: Invocation[] = body.methodCalls.map(([name, rawArgs, id]): Invocation => {
    const args = (rawArgs ?? {}) as Record<string, unknown>
    if (name === 'Core/echo') return [name, args, id]
    if (name === 'Email/query') {
      return [
        name,
        {
          accountId: args.accountId,
          queryState: 'q1',
          canCalculateChanges: true,
          position: 0,
          ids: ['e1', 'e2'],
        },
        id,
      ]
    }
    if (name.endsWith('/get')) {
      const ids = Array.isArray(args.ids)
        ? (args.ids as string[])
        : '#ids' in args
          ? ['e1', 'e2']
          : []
      return [
        name,
        { accountId: args.accountId, state: 'g1', list: ids.map((v) => ({ id: v })), notFound: [] },
        id,
      ]
    }
    return [name, args, id]
  })
  return { methodResponses, sessionState }
}
