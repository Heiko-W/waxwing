/**
 * RFC 9425 — Quota (M3.7, FR-QTA-01). Read-only; the client only ever asks for all of them.
 */

import { describe, expect, it } from 'vitest'
import { bearer } from './auth'
import { usingForMethods } from './capabilities'
import { JmapClient } from './client'
import { Methods } from './methods'
import { at, jmapPostMock, makeSession } from './test-support'
import type { Invocation } from './types/core'
import type { Quota } from './types/quota'

const ACC = 'a'

const QUOTA: Quota = {
  id: 'q1',
  resourceType: 'octets',
  used: 1_000,
  hardLimit: 10_000,
  scope: 'account',
  name: 'alice@waxwing.test',
  types: ['Email'],
  warnLimit: null,
  softLimit: null,
  description: null,
}

describe('Quota (RFC 9425)', () => {
  it('binds the RFC method name', () => {
    expect(Methods.quotaGet.name).toBe('Quota/get')
  })

  it('auto-adds the quota capability to `using`', () => {
    expect(usingForMethods(['Quota/get'])).toContain('urn:ietf:params:jmap:quota')
  })

  it('passes `ids: null` straight through — "all quotas", never chunked into nothing', async () => {
    // `ids: null` means "every record" (RFC 8620 §5.1). The auto-chunker splits an ID LIST against
    // maxObjectsInGet; a null must survive it untouched or the request would ask for no quotas.
    const { fetch, calls } = jmapPostMock((body) => {
      const methodResponses: Invocation[] = body.methodCalls.map(([name, , id]) => [
        name,
        { accountId: ACC, state: 'n', list: [QUOTA], notFound: [] },
        id,
      ])
      return { methodResponses, sessionState: 's0' }
    })
    const client = new JmapClient({
      session: makeSession({ maxObjectsInGet: 1 }),
      auth: bearer('t'),
      fetch,
    })

    const builder = client.request()
    const handle = builder.invoke(Methods.quotaGet, { accountId: ACC, ids: null })
    const result = (await builder.send()).get(handle)

    expect(at(calls, 0).body.methodCalls).toHaveLength(1)
    const [, args] = at(at(calls, 0).body.methodCalls, 0)
    expect(args).toEqual({ accountId: ACC, ids: null })
    expect(result.list).toEqual([QUOTA])
  })
})
