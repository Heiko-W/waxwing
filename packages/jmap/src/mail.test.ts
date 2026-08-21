import { describe, expect, it } from 'vitest'
import { bearer } from './auth'
import { JmapClient } from './client'
import { isMethodErrorType, JmapMethodError, MethodErrorTypes } from './errors'
import { Methods } from './methods'
import { at, jmapPostMock, makeSession } from './test-support'
import type { Invocation } from './types/core'
import { type EmailSetRequest, MailboxRoles } from './types/mail'

const fullRights = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: false,
  mayDelete: false,
  maySubmit: true,
  mayShare: false,
}

describe('Email/query → Email/get back-reference (typed invoke)', () => {
  it('chains in a single round-trip, sends a correct ResultReference and infers Email[]', async () => {
    const inbox = 'mb-inbox'
    // Runtime-only records; the client narrows the handle's response to Email[] on the way out.
    const emails = [
      {
        id: 'e1',
        threadId: 'th-1',
        mailboxIds: { [inbox]: true },
        keywords: { $seen: true },
        subject: 'Hello',
        from: [{ name: 'Alice', email: 'alice@waxwing.test' }],
        receivedAt: '2026-07-05T10:00:00Z',
      },
      {
        id: 'e2',
        threadId: 'th-1',
        mailboxIds: { [inbox]: true },
        keywords: {},
        subject: 'Re: Hello',
        from: [{ name: 'Bob', email: 'bob@waxwing.test' }],
        receivedAt: '2026-07-05T11:00:00Z',
      },
    ]

    const { fetch, calls } = jmapPostMock((body) => ({
      sessionState: 's0',
      methodResponses: body.methodCalls.map(([name, rawArgs, id]): Invocation => {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        if (name === 'Email/query') {
          return [
            name,
            {
              accountId: args.accountId,
              queryState: 'q1',
              canCalculateChanges: true,
              position: 0,
              ids: ['e1', 'e2'],
              total: 2,
            },
            id,
          ]
        }
        if (name === 'Email/get') {
          return [name, { accountId: args.accountId, state: 'g1', list: emails, notFound: [] }, id]
        }
        return [name, args, id]
      }),
    }))

    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    const builder = client.request()
    const query = builder.invoke(Methods.emailQuery, {
      accountId: 'a',
      filter: { inMailbox: inbox },
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: true,
    })
    const get = builder.invoke(Methods.emailGet, {
      accountId: 'a',
      '#ids': query.ref('/ids'),
      properties: ['id', 'threadId', 'subject', 'from', 'receivedAt'],
    })
    const result = await builder.send()

    // Exactly one HTTP request (the two calls are kept together by the back-reference).
    expect(calls).toHaveLength(1)
    const sent = at(calls, 0).body.methodCalls
    expect(at(sent, 0)[0]).toBe('Email/query')
    expect(at(sent, 1)[0]).toBe('Email/get')
    expect(at(sent, 1)[1]).toMatchObject({
      '#ids': { resultOf: query.callId, name: 'Email/query', path: '/ids' },
    })
    // The back-reference replaces `ids`; no literal `ids` leaks onto the wire.
    expect(at(sent, 1)[1]).not.toHaveProperty('ids')
    // Mail capability was auto-added to `using`.
    expect(at(calls, 0).body.using).toContain('urn:ietf:params:jmap:mail')

    // Typed inference: no explicit type args needed.
    const queryResult = result.get(query)
    expect(queryResult.ids).toEqual(['e1', 'e2'])
    expect(queryResult.total).toBe(2)

    const getResult = result.get(get)
    expect(getResult.list.map((email) => email.id)).toEqual(['e1', 'e2'])
    expect(at(getResult.list, 0).subject).toBe('Hello')
    expect(at(getResult.list, 0).from).toEqual([{ name: 'Alice', email: 'alice@waxwing.test' }])
    expect(at(getResult.list, 1).keywords).toEqual({})
    expect(getResult.notFound).toEqual([])
  })

  it('SearchSnippet/get invokes the method with the query filter + ids (M3.1)', async () => {
    const { fetch, calls } = jmapPostMock((body) => ({
      sessionState: 's',
      methodResponses: body.methodCalls.map(([name, args, id]) => [
        name,
        {
          accountId: (args as { accountId: string }).accountId,
          list: [{ emailId: 'e1', subject: 'the <mark>tax</mark> memo', preview: null }],
          notFound: [],
        },
        id,
      ]),
    }))
    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    const builder = client.request()
    const handle = builder.invoke(Methods.searchSnippetGet, {
      accountId: 'a',
      filter: { text: 'tax' },
      emailIds: ['e1', 'e2'],
    })
    const result = await builder.send()
    expect(at(at(calls, 0).body.methodCalls, 0)[0]).toBe('SearchSnippet/get')
    expect(at(calls, 0).body.using).toContain('urn:ietf:params:jmap:mail')
    expect(result.get(handle).list[0]?.subject).toBe('the <mark>tax</mark> memo')
  })
})

describe('Mailbox/get (typed invoke)', () => {
  it('parses mailboxes with role, rights and counts', async () => {
    const mailboxes = [
      {
        id: 'mb-inbox',
        name: 'Inbox',
        parentId: null,
        role: 'inbox',
        sortOrder: 0,
        totalEmails: 42,
        unreadEmails: 3,
        totalThreads: 40,
        unreadThreads: 3,
        isSubscribed: true,
        myRights: fullRights,
      },
      {
        id: 'mb-child',
        name: 'Project',
        parentId: 'mb-inbox',
        role: null,
        sortOrder: 5,
        totalEmails: 7,
        unreadEmails: 0,
        totalThreads: 7,
        unreadThreads: 0,
        isSubscribed: false,
        myRights: { ...fullRights, mayReadItems: false },
      },
    ]

    const { fetch, calls } = jmapPostMock((body) => ({
      sessionState: 's0',
      methodResponses: body.methodCalls.map(([name, rawArgs, id]): Invocation => {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        if (name === 'Mailbox/get') {
          return [
            name,
            { accountId: args.accountId, state: 'm1', list: mailboxes, notFound: [] },
            id,
          ]
        }
        return [name, args, id]
      }),
    }))

    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    const builder = client.request()
    const handle = builder.invoke(Methods.mailboxGet, { accountId: 'a', ids: null })
    const response = (await builder.send()).get(handle)

    expect(at(calls, 0).body.using).toContain('urn:ietf:params:jmap:mail')
    expect(response.state).toBe('m1')
    expect(response.list).toHaveLength(2)

    const inbox = at(response.list, 0)
    expect(inbox.role).toBe(MailboxRoles.inbox)
    expect(inbox.parentId).toBeNull()
    expect(inbox.unreadEmails).toBe(3)
    expect(inbox.myRights.mayReadItems).toBe(true)
    expect(inbox.myRights.mayDelete).toBe(false)

    const child = at(response.list, 1)
    expect(child.parentId).toBe('mb-inbox')
    expect(child.role).toBeNull()
    expect(child.isSubscribed).toBe(false)
    expect(child.myRights.mayReadItems).toBe(false)
  })
})

describe('Email/set (typed create + keyword/mailbox member patch)', () => {
  it('serialises the create object and JSON-Pointer patch, and reads the created id', async () => {
    const { fetch, calls } = jmapPostMock((body) => ({
      sessionState: 's1',
      methodResponses: body.methodCalls.map(([name, rawArgs, id]): Invocation => {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        if (name === 'Email/set') {
          const create = (args.create ?? {}) as Record<string, unknown>
          const created: Record<string, unknown> = {}
          for (const creationId of Object.keys(create)) {
            created[creationId] = {
              id: `srv-${creationId}`,
              blobId: 'blob-1',
              threadId: 'th-new',
              size: 120,
            }
          }
          const update = (args.update ?? {}) as Record<string, unknown>
          const updated: Record<string, unknown> = {}
          for (const updateId of Object.keys(update)) updated[updateId] = null
          return [
            name,
            {
              accountId: args.accountId,
              oldState: 's0',
              newState: 's1',
              created,
              updated,
              destroyed: null,
              notCreated: null,
              notUpdated: null,
              notDestroyed: null,
            },
            id,
          ]
        }
        return [name, args, id]
      }),
    }))

    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    const request: EmailSetRequest = {
      accountId: 'a',
      create: {
        draft1: {
          mailboxIds: { 'mb-drafts': true },
          keywords: { $draft: true, $seen: true },
          from: [{ name: 'Alice', email: 'alice@waxwing.test' }],
          to: [{ name: 'Bob', email: 'bob@waxwing.test' }],
          subject: 'Hi Bob',
          textBody: [{ partId: 'body', type: 'text/plain' }],
          bodyValues: {
            body: { value: 'Hello Bob', isEncodingProblem: false, isTruncated: false },
          },
        },
      },
      update: {
        'e-existing': {
          'keywords/$seen': true,
          'mailboxIds/mb-archive': true,
          'mailboxIds/mb-inbox': null,
        },
      },
    }

    const builder = client.request()
    const handle = builder.invoke(Methods.emailSet, request)
    const response = (await builder.send()).get(handle)

    // Create object shape on the wire.
    const setCall = at(at(calls, 0).body.methodCalls, 0)
    expect(setCall[0]).toBe('Email/set')
    const sent = setCall[1] as EmailSetRequest
    expect(sent.create?.draft1?.mailboxIds).toEqual({ 'mb-drafts': true })
    expect(sent.create?.draft1?.keywords).toEqual({ $draft: true, $seen: true })
    expect(sent.create?.draft1?.subject).toBe('Hi Bob')
    expect(sent.create?.draft1?.bodyValues?.body?.value).toBe('Hello Bob')
    // Member patch: JSON-Pointer keys, `true` to add, `null` to remove.
    expect(sent.update?.['e-existing']).toEqual({
      'keywords/$seen': true,
      'mailboxIds/mb-archive': true,
      'mailboxIds/mb-inbox': null,
    })

    // Typed response: server-assigned id echoed under the creation id.
    expect(response.newState).toBe('s1')
    expect(response.created?.draft1?.id).toBe('srv-draft1')
    expect(response.updated).toHaveProperty('e-existing')
  })
})

describe('cannotCalculateChanges surface (Email/queryChanges)', () => {
  it('surfaces as a JmapMethodError whose type matches MethodErrorTypes.cannotCalculateChanges', async () => {
    const { fetch } = jmapPostMock((body) => ({
      sessionState: 's0',
      methodResponses: body.methodCalls.map(
        ([, , id]): Invocation => [
          'error',
          { type: 'cannotCalculateChanges', description: 'client must resync' },
          id,
        ],
      ),
    }))

    const client = new JmapClient({ session: makeSession(), auth: bearer('t'), fetch })
    const builder = client.request()
    const handle = builder.invoke(Methods.emailQueryChanges, {
      accountId: 'a',
      sinceQueryState: 'q0',
    })
    const result = await builder.send()

    expect(() => result.get(handle)).toThrow(JmapMethodError)
    try {
      result.get(handle)
      expect.unreachable('expected a JmapMethodError')
    } catch (error) {
      expect(error).toBeInstanceOf(JmapMethodError)
      expect(
        isMethodErrorType(error as JmapMethodError, MethodErrorTypes.cannotCalculateChanges),
      ).toBe(true)
    }
  })
})
