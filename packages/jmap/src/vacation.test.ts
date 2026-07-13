/**
 * RFC 8621 §8 — VacationResponse (M3.7, FR-VAC-01).
 *
 * Two things worth pinning: the `using` set is derived from the method name (a caller who forgets
 * the capability would otherwise have the WHOLE request rejected with `unknownCapability`), and a
 * `/set` on the singleton serializes as an `update` keyed by `"singleton"` — never a `create`.
 */

import { describe, expect, it } from 'vitest'
import { bearer } from './auth'
import { usingForMethods } from './capabilities'
import { JmapClient } from './client'
import { Methods } from './methods'
import { at, autoRespond, jmapPostMock, makeSession } from './test-support'
import type { Invocation } from './types/core'
import { VACATION_SINGLETON_ID } from './types/vacation'

const ACC = 'a'

describe('VacationResponse (RFC 8621 §8)', () => {
  it('binds the RFC method names', () => {
    expect(Methods.vacationResponseGet.name).toBe('VacationResponse/get')
    expect(Methods.vacationResponseSet.name).toBe('VacationResponse/set')
  })

  it('is a SINGLETON whose id is always "singleton"', () => {
    expect(VACATION_SINGLETON_ID).toBe('singleton')
  })

  it('auto-adds the vacation capability to `using` — a missing URN would fail the WHOLE request', () => {
    // RFC 8620 §3.3: an unsupported capability in `using` is a REQUEST-level error, so it takes
    // every other call in the batch down with it. Deriving `using` from the method names is what
    // makes that unreachable.
    const using = usingForMethods(['VacationResponse/get', 'VacationResponse/set'])
    expect(using).toContain('urn:ietf:params:jmap:vacationresponse')
    expect(using).toContain('urn:ietf:params:jmap:core')
  })

  it('sends an `update` keyed by the singleton id with `ifInState`, and no create/destroy', async () => {
    const { fetch, calls } = jmapPostMock((body) => {
      const methodResponses: Invocation[] = body.methodCalls.map(([name, , id]) => [
        name,
        { accountId: ACC, oldState: 'n', newState: 'o', updated: { singleton: null } },
        id,
      ])
      return { methodResponses, sessionState: 's0' }
    })
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })

    const builder = client.request()
    builder.invoke(Methods.vacationResponseSet, {
      accountId: ACC,
      ifInState: 'n',
      update: { [VACATION_SINGLETON_ID]: { isEnabled: true, subject: 'Away' } },
    })
    await builder.send()

    const recorded = at(calls, calls.length - 1)
    expect(recorded.body.using).toContain('urn:ietf:params:jmap:vacationresponse')
    const [name, args] = at(recorded.body.methodCalls, 0)
    expect(name).toBe('VacationResponse/set')
    expect(args).toEqual({
      accountId: ACC,
      ifInState: 'n',
      update: { singleton: { isEnabled: true, subject: 'Away' } },
    })
    expect(args).not.toHaveProperty('create')
    expect(args).not.toHaveProperty('destroy')
  })

  it('fetches the singleton by id', async () => {
    const { fetch, calls } = jmapPostMock((body) => autoRespond(body))
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })

    const builder = client.request()
    builder.invoke(Methods.vacationResponseGet, { accountId: ACC, ids: [VACATION_SINGLETON_ID] })
    await builder.send()

    const [, args] = at(at(calls, 0).body.methodCalls, 0)
    expect(args).toEqual({ accountId: ACC, ids: ['singleton'] })
  })
})
