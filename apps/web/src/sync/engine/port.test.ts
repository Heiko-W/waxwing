import type { JmapClient } from '@waxwing/jmap'
import { JmapMethodError, MethodErrorTypes, Methods } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { createJmapPort } from './port'
import { CannotCalculateChangesError } from './types'

type RecordedCall = { methodDef: unknown; args: Record<string, unknown> }
type Script = (methodDef: unknown, args: Record<string, unknown>) => unknown

/** A minimal fake JmapClient: records invocations and resolves scripted responses per methodDef. */
function fakeClient(script: Script): { client: JmapClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const client = {
    request() {
      const pending: { handle: object; methodDef: unknown; args: Record<string, unknown> }[] = []
      return {
        invoke(methodDef: unknown, args: Record<string, unknown>) {
          const handle = {}
          pending.push({ handle, methodDef, args })
          return handle
        },
        async send() {
          const results = new Map<object, unknown>()
          for (const call of pending) {
            calls.push({ methodDef: call.methodDef, args: call.args })
            results.set(call.handle, script(call.methodDef, call.args))
          }
          return {
            get(handle: object) {
              const result = results.get(handle)
              if (result instanceof Error) throw result
              return result
            },
          }
        },
      }
    },
  }
  return { client: client as unknown as JmapClient, calls }
}

const ACC = 'acc'

describe('createJmapPort', () => {
  it('maps Mailbox/changes including updatedProperties, and omits maxChanges when unset', async () => {
    const { client, calls } = fakeClient((method) =>
      method === Methods.mailboxChanges
        ? {
            accountId: ACC,
            oldState: '0',
            newState: '1',
            hasMoreChanges: false,
            created: ['m1'],
            updated: ['m2'],
            destroyed: [],
            updatedProperties: ['totalEmails', 'unreadEmails'],
          }
        : {},
    )
    const result = await createJmapPort(client, ACC).mailboxChanges('0')

    expect(result).toEqual({
      newState: '1',
      hasMoreChanges: false,
      created: ['m1'],
      updated: ['m2'],
      destroyed: [],
      updatedProperties: ['totalEmails', 'unreadEmails'],
    })
    expect(calls[0]?.args).toEqual({ accountId: ACC, sinceState: '0' })
  })

  it('maps Email/changes without updatedProperties and passes maxChanges through', async () => {
    const { client, calls } = fakeClient(() => ({
      accountId: ACC,
      oldState: '0',
      newState: '9',
      hasMoreChanges: true,
      created: ['e1'],
      updated: [],
      destroyed: ['e0'],
    }))
    const result = await createJmapPort(client, ACC).emailChanges('0', 50)

    expect(result).toEqual({
      newState: '9',
      hasMoreChanges: true,
      created: ['e1'],
      updated: [],
      destroyed: ['e0'],
    })
    expect(result).not.toHaveProperty('updatedProperties')
    expect(calls[0]?.args).toEqual({ accountId: ACC, sinceState: '0', maxChanges: 50 })
  })

  it('fetches email envelopes with the envelope property set', async () => {
    const { client, calls } = fakeClient((method) =>
      method === Methods.emailGet
        ? { accountId: ACC, state: 'e-state', list: [{ id: 'e1' }], notFound: ['gone'] }
        : {},
    )
    const result = await createJmapPort(client, ACC).getEmailEnvelopes(['e1', 'gone'])

    expect(result.state).toBe('e-state')
    expect(result.list).toEqual([{ id: 'e1' }])
    expect(result.notFound).toEqual(['gone'])
    const properties = calls[0]?.args.properties as string[]
    expect(properties).toContain('mailboxIds')
    expect(properties).toContain('keywords')
    expect(properties).toContain('receivedAt')
  })

  it('maps Email/query results', async () => {
    const { client } = fakeClient(() => ({
      accountId: ACC,
      queryState: 'q1',
      canCalculateChanges: true,
      position: 0,
      ids: ['e1', 'e2'],
      total: 2,
    }))
    const result = await createJmapPort(client, ACC).queryEmails({ collapseThreads: true })

    expect(result).toEqual({
      ids: ['e1', 'e2'],
      queryState: 'q1',
      canCalculateChanges: true,
      position: 0,
      total: 2,
    })
  })

  it('maps Email/queryChanges (removed then added)', async () => {
    const { client } = fakeClient(() => ({
      accountId: ACC,
      oldQueryState: 'q1',
      newQueryState: 'q2',
      removed: ['e9'],
      added: [{ id: 'e1', index: 0 }],
    }))
    const result = await createJmapPort(client, ACC).queryEmailChanges({ sinceQueryState: 'q1' })

    expect(result).toEqual({
      oldQueryState: 'q1',
      newQueryState: 'q2',
      removed: ['e9'],
      added: [{ id: 'e1', index: 0 }],
    })
  })

  it('rethrows a cannotCalculateChanges method error as CannotCalculateChangesError', async () => {
    const { client } = fakeClient(
      () =>
        new JmapMethodError(
          { type: MethodErrorTypes.cannotCalculateChanges },
          'c0',
          'Email/queryChanges',
        ),
    )
    await expect(
      createJmapPort(client, ACC).queryEmailChanges({ sinceQueryState: 'stale' }),
    ).rejects.toBeInstanceOf(CannotCalculateChangesError)
  })

  it('normalizes Email/set nullable maps', async () => {
    const { client } = fakeClient(() => ({
      accountId: ACC,
      oldState: '0',
      newState: '1',
      created: null,
      updated: { e1: null },
      destroyed: null,
      notCreated: null,
      notUpdated: { e2: { type: 'stateMismatch', description: 'conflict' } },
      notDestroyed: null,
    }))
    const result = await createJmapPort(client, ACC).setEmails({
      update: { e1: { 'keywords/$seen': true } },
    })

    expect(result).toEqual({
      oldState: '0',
      newState: '1',
      created: {},
      updated: ['e1'],
      destroyed: [],
      notCreated: {},
      notUpdated: { e2: { type: 'stateMismatch', description: 'conflict' } },
      notDestroyed: {},
    })
  })
})
