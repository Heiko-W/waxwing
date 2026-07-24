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

  it('asks for Authentication-Results with :asText:all, never the singular form (M3.9)', async () => {
    // RFC 8621 §4.1.2: the singular `:asText` is "the value of the LAST instance of the header
    // field" — and the receiving MTA PREPENDS its report (RFC 8601 §5), so the last instance is the
    // one the SENDER forged. If this ever narrows to `:asText`, Waxwing renders the forgery.
    const { client, calls } = fakeClient((method) =>
      method === Methods.emailGet ? { accountId: ACC, state: 'b1', list: [], notFound: [] } : {},
    )
    await createJmapPort(client, ACC).getEmailBodies(['e1'])

    const properties = calls[0]?.args.properties as string[]
    expect(properties).toContain('header:Authentication-Results:asText:all')
    expect(properties).not.toContain('header:Authentication-Results:asText')
    // The raw `headers` array is Raw-form (RFC 2047-encoded, folded) and would bloat every body row;
    // the .eml source view covers the raw truth instead.
    expect(properties).not.toContain('headers')
    expect(properties).toContain('bcc')
    expect(properties).toContain('sender')
  })

  it('renames the header:… key to authResults, so the awkward key never escapes the port (M3.9)', async () => {
    const { client } = fakeClient((method) =>
      method === Methods.emailGet
        ? {
            accountId: ACC,
            state: 'b1',
            list: [
              {
                id: 'e1',
                bodyValues: {},
                bcc: null,
                sender: null,
                'header:Authentication-Results:asText:all': ['mx.test; spf=pass', 'evil; spf=pass'],
              },
              // A server that omits the property entirely (no such header) → [], not undefined.
              { id: 'e2', bodyValues: {}, bcc: null, sender: null },
            ],
            notFound: [],
          }
        : {},
    )
    const { list } = await createJmapPort(client, ACC).getEmailBodies(['e1', 'e2'])

    expect(list[0]?.authResults).toEqual(['mx.test; spf=pass', 'evil; spf=pass'])
    expect(list[0]).not.toHaveProperty('header:Authentication-Results:asText:all')
    expect(list[1]?.authResults).toEqual([])
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

  it('getSearchSnippets builds SearchSnippet/get and maps the response (M3.1)', async () => {
    const { client, calls } = fakeClient((method) =>
      method === Methods.searchSnippetGet
        ? {
            accountId: ACC,
            list: [{ emailId: 'e1', subject: '<mark>tax</mark> memo', preview: null }],
            notFound: ['e2'],
          }
        : {},
    )
    const result = await createJmapPort(client, ACC).getSearchSnippets(['e1', 'e2'], {
      text: 'tax',
    })
    expect(calls[0]?.args).toEqual({
      accountId: ACC,
      filter: { text: 'tax' },
      emailIds: ['e1', 'e2'],
    })
    expect(result.list[0]?.subject).toBe('<mark>tax</mark> memo')
    expect(result.notFound).toEqual(['e2'])
  })

  it('submitEmail batches Email/set create+destroy+source-update and EmailSubmission/set (M2.8)', async () => {
    const okSet = (created: Record<string, unknown>) => ({
      accountId: ACC,
      oldState: '0',
      newState: '1',
      created,
      updated: null,
      destroyed: null,
      notCreated: null,
      notUpdated: null,
      notDestroyed: null,
    })
    const { client, calls } = fakeClient((method) => {
      if (method === Methods.emailSet) return okSet({ 'send-1': { id: 'srv-e' } })
      if (method === Methods.emailSubmissionSet) return okSet({ 'sub-1': { id: 'srv-sub' } })
      return {}
    })
    const email = { mailboxIds: { 'mb-d': true }, keywords: { $draft: true } } as never
    const result = await createJmapPort(client, ACC).submitEmail({
      emailCreationId: 'send-1',
      email,
      destroyServerDraftId: 'old-draft',
      submissionCreationId: 'sub-1',
      identityId: 'id1',
      envelope: { mailFrom: { email: 'me@x.test' }, rcptTo: [{ email: 'a@x.test' }] },
      onSuccessUpdateEmail: { 'keywords/$draft': null },
      sourceUpdate: { id: 'src-9', patch: { 'keywords/$answered': true } },
    })

    const emailCall = calls.find((c) => c.methodDef === Methods.emailSet)
    expect(emailCall?.args.create).toEqual({ 'send-1': email })
    expect(emailCall?.args.destroy).toEqual(['old-draft'])
    expect(emailCall?.args.update).toEqual({ 'src-9': { 'keywords/$answered': true } })

    const subCall = calls.find((c) => c.methodDef === Methods.emailSubmissionSet)
    const create = subCall?.args.create as Record<string, { emailId: string; identityId: string }>
    expect(create['sub-1']?.emailId).toBe('#send-1') // back-reference to the created Email
    expect(create['sub-1']?.identityId).toBe('id1')
    expect(subCall?.args.onSuccessUpdateEmail).toEqual({ '#sub-1': { 'keywords/$draft': null } })

    expect(result.created).toEqual({ 'sub-1': { id: 'srv-sub' } }) // returns the submission result
  })

  // ── Contacts (M4.2, RFC 9610) ────────────────────────────────────────────────────────────────

  it('fetches all address books with ids: null and maps the response', async () => {
    const { client, calls } = fakeClient((method) =>
      method === Methods.addressBookGet
        ? {
            accountId: ACC,
            state: 'abk-1',
            list: [{ id: 'book1', name: 'Personal' }],
            notFound: [],
          }
        : {},
    )
    const result = await createJmapPort(client, ACC).getAddressBooks(null)

    expect(result).toEqual({
      list: [{ id: 'book1', name: 'Personal' }],
      notFound: [],
      state: 'abk-1',
    })
    expect(calls[0]?.args).toEqual({ accountId: ACC, ids: null })
  })

  it('maps AddressBook/changes (no updatedProperties on this type)', async () => {
    const { client, calls } = fakeClient(() => ({
      accountId: ACC,
      oldState: '0',
      newState: '2',
      hasMoreChanges: false,
      created: ['book2'],
      updated: [],
      destroyed: ['book0'],
    }))
    const result = await createJmapPort(client, ACC).addressBookChanges('0')

    expect(result).toEqual({
      newState: '2',
      hasMoreChanges: false,
      created: ['book2'],
      updated: [],
      destroyed: ['book0'],
    })
    expect(result).not.toHaveProperty('updatedProperties')
    expect(calls[0]?.args).toEqual({ accountId: ACC, sinceState: '0' })
  })

  it('fetches contact cards with the full card property set (incl. vCardProps, for losslessness)', async () => {
    const { client, calls } = fakeClient((method) =>
      method === Methods.contactCardGet
        ? { accountId: ACC, state: 'cc-1', list: [{ id: 'c1' }], notFound: ['gone'] }
        : {},
    )
    const result = await createJmapPort(client, ACC).getContactCards(['c1', 'gone'])

    expect(result.state).toBe('cc-1')
    expect(result.list).toEqual([{ id: 'c1' }])
    expect(result.notFound).toEqual(['gone'])
    const properties = calls[0]?.args.properties as string[]
    expect(properties).toContain('addressBookIds')
    expect(properties).toContain('emails')
    expect(properties).toContain('vCardProps')
  })

  it('maps ContactCard/query results', async () => {
    const { client, calls } = fakeClient(() => ({
      accountId: ACC,
      queryState: 'cq1',
      canCalculateChanges: true,
      position: 0,
      ids: ['c1', 'c2'],
      total: 2,
    }))
    const result = await createJmapPort(client, ACC).queryContactCards({
      filter: { inAddressBook: 'book1' },
      sort: [{ property: 'name/surname' }],
    })

    expect(result).toEqual({
      ids: ['c1', 'c2'],
      queryState: 'cq1',
      canCalculateChanges: true,
      position: 0,
      total: 2,
    })
    expect(calls[0]?.args).toMatchObject({
      accountId: ACC,
      filter: { inAddressBook: 'book1' },
      sort: [{ property: 'name/surname' }],
    })
  })

  it('maps ContactCard/queryChanges (removed then added)', async () => {
    const { client } = fakeClient(() => ({
      accountId: ACC,
      oldQueryState: 'cq1',
      newQueryState: 'cq2',
      removed: ['c9'],
      added: [{ id: 'c1', index: 0 }],
    }))
    const result = await createJmapPort(client, ACC).queryContactCardChanges({
      sinceQueryState: 'cq1',
    })

    expect(result).toEqual({
      oldQueryState: 'cq1',
      newQueryState: 'cq2',
      removed: ['c9'],
      added: [{ id: 'c1', index: 0 }],
    })
  })

  it('rethrows a contact-card cannotCalculateChanges as CannotCalculateChangesError', async () => {
    const { client } = fakeClient(
      () =>
        new JmapMethodError(
          { type: MethodErrorTypes.cannotCalculateChanges },
          'c0',
          'ContactCard/queryChanges',
        ),
    )
    await expect(
      createJmapPort(client, ACC).queryContactCardChanges({ sinceQueryState: 'stale' }),
    ).rejects.toBeInstanceOf(CannotCalculateChangesError)
  })

  it('normalizes ContactCard/set nullable maps', async () => {
    const { client } = fakeClient(() => ({
      accountId: ACC,
      oldState: '0',
      newState: '1',
      created: { '#new': { id: 'c-srv' } },
      updated: null,
      destroyed: null,
      notCreated: null,
      notUpdated: null,
      notDestroyed: { c2: { type: 'notFound' } },
    }))
    const result = await createJmapPort(client, ACC).setContactCards({ destroy: ['c2'] })

    expect(result).toEqual({
      oldState: '0',
      newState: '1',
      created: { '#new': { id: 'c-srv' } },
      updated: [],
      destroyed: [],
      notCreated: {},
      notUpdated: {},
      notDestroyed: { c2: { type: 'notFound' } },
    })
  })
})
