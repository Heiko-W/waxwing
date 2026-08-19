/**
 * The JMAP seam for send identities (M5.1, FR-CMP-06, RFC 8621 §6).
 *
 * Two properties carry this file, and both are invisible in a screenshot. The first is the
 * `ifInState` on every write: drop it and an edit made in another tab is overwritten in silence.
 * The second is that no write believes the server's echo — RFC 8620 §5.3 permits
 * `created: { new: { id } }` and `updated: { id: null }`, neither of which is a renderable record —
 * so the write tests assert that the list was RE-READ afterwards rather than reconstructed.
 *
 * The client is a hand-rolled fake of the `call()` seam, not a real `JmapClient` over a fetch mock:
 * `packages/jmap/src/test-support.ts` (`jmapPostMock`) is deliberately outside the package's
 * published surface, so app-side tests fake the seam instead — see `notify/push-subscribe.test.ts`.
 */

import type { Id, Identity, IdentityCreate, IdentityWritable, JmapClient } from '@waxwing/jmap'
import { MethodResponses } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import type { JmapSession } from '../app/session/types'
import { IdentitySetError, makeIdentityClient, serverSupportsIdentities } from './identity-client'

const ACC = 'a'
const SUBMISSION = 'urn:ietf:params:jmap:submission'
/** The id the fake server hands out — deliberately not the `new` creation id the client sends. */
const SERVER_ID = 'srv-7'

const BLANK: Identity = {
  id: '',
  name: '',
  email: '',
  replyTo: null,
  bcc: null,
  textSignature: '',
  htmlSignature: '',
  mayDelete: true,
}

const ALICE: Identity = { ...BLANK, id: 'i1', name: 'Alice', email: 'alice@waxwing.test' }
const WORK: Identity = { ...BLANK, id: 'i2', name: 'Alice (work)', email: 'a@corp.test' }
const DRAFT: IdentityCreate = {
  email: 'new@waxwing.test',
  name: 'New',
  htmlSignature: '<p>Regards</p>',
}

type Call = [name: string, args: Record<string, unknown>, id: string]
type Echo = Record<string, unknown>

/** What a conformant server answers when it accepts the write — see the note on `created` below. */
function defaultEcho(args: Record<string, unknown>): Echo {
  const create = args.create as Record<string, unknown> | undefined
  if (create !== undefined) {
    // RFC 8620 §5.3: `created` only has to carry the properties the SERVER assigned. A server that
    // returns nothing but the id is conformant — and its echo is not something the UI can render.
    return {
      created: Object.fromEntries(Object.keys(create).map((cid) => [cid, { id: SERVER_ID }])),
    }
  }
  const update = args.update as Record<string, unknown> | undefined
  if (update !== undefined) {
    return { updated: Object.fromEntries(Object.keys(update).map((id) => [id, null])) }
  }
  return { destroyed: args.destroy ?? [] }
}

/** Mirrors an accepted write into the list the next `Identity/get` will serve. */
function applyWrite(
  current: readonly Identity[],
  args: Record<string, unknown>,
  echo: Echo,
): Identity[] {
  const create = (args.create ?? {}) as Record<string, IdentityCreate>
  const created = (echo.created ?? {}) as Record<string, { id: Id }>
  const next: Identity[] = [...current]
  for (const [creationId, record] of Object.entries(created)) {
    const body = create[creationId]
    if (body !== undefined) next.push({ ...BLANK, ...body, id: record.id })
  }

  const update = (args.update ?? {}) as Record<Id, IdentityWritable>
  const notUpdated = (echo.notUpdated ?? {}) as Record<Id, unknown>
  const updated = next.map((row) => {
    const patch = update[row.id]
    return patch !== undefined && notUpdated[row.id] === undefined ? { ...row, ...patch } : row
  })

  const destroy = (args.destroy ?? []) as Id[]
  const notDestroyed = (echo.notDestroyed ?? {}) as Record<Id, unknown>
  return updated.filter((row) => !destroy.includes(row.id) || notDestroyed[row.id] !== undefined)
}

/**
 * A JMAP client that serves `Identity/get` from a mutable list and `Identity/set` from a script.
 *
 * Its `/get` state ADVANCES on every write, which is what makes the re-read assertions meaningful:
 * the state a caller ends up holding is the `ifInState` of its next write, so a client that returned
 * the state it was handed would hand the user a stale conflict token that never fires.
 */
function fakeClient(
  options: { list?: Identity[]; onSet?: (args: Record<string, unknown>) => Echo } = {},
): { client: JmapClient; calls: Call[]; callOptions: unknown[] } {
  const calls: Call[] = []
  const callOptions: unknown[] = []
  let list = options.list ?? [ALICE]
  let version = 1

  const client = {
    async call(invocations: Call[], opts?: unknown) {
      callOptions.push(opts)
      const responses: Call[] = []
      for (const [name, args, id] of invocations) {
        calls.push([name, args, id])
        if (name === 'Identity/get') {
          responses.push([name, { accountId: ACC, state: `st-${version}`, list, notFound: [] }, id])
          continue
        }
        const echo: Echo = {
          created: null,
          notCreated: null,
          updated: null,
          notUpdated: null,
          destroyed: null,
          notDestroyed: null,
          ...(options.onSet?.(args) ?? defaultEcho(args)),
        }
        list = applyWrite(list, args, echo)
        version += 1
        responses.push([name, echo, id])
      }
      return new MethodResponses(responses, 'session-1', undefined)
    },
  }
  return { client: client as unknown as JmapClient, calls, callOptions }
}

/** Returns the rejection reason, failing the test if the promise resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    (value) => {
      throw new Error(`Expected a rejection, but it resolved with ${JSON.stringify(value)}`)
    },
    (error: unknown) => error,
  )
}

const names = (calls: readonly Call[]): string[] => calls.map(([name]) => name)

describe('makeIdentityClient — reading', () => {
  it('asks for the whole list in one `Identity/get` with `ids: null`', async () => {
    // `ids: null` is "all of them" (RFC 8620 §5.1). Anything else needs ids the app does not have
    // on a cold start, so the settings list would come up empty on the very first visit.
    const { client, calls } = fakeClient({ list: [ALICE, WORK] })

    const snapshot = await makeIdentityClient(client, ACC).list()

    expect(snapshot).toEqual({ identities: [ALICE, WORK], state: 'st-1' })
    expect(calls).toEqual([['Identity/get', { accountId: ACC, ids: null }, 'i0']])
  })

  it('forwards the caller’s AbortSignal so an unmounted section stops its own request', async () => {
    const controller = new AbortController()
    const { client, callOptions } = fakeClient()

    await makeIdentityClient(client, ACC).list(controller.signal)

    expect(callOptions[0]).toEqual({ signal: controller.signal })
  })
})

describe('makeIdentityClient — writing', () => {
  it('creates via `create: { new: … }` and rides the `ifInState` from the last read', async () => {
    const { client, calls } = fakeClient()

    await makeIdentityClient(client, ACC).create(DRAFT, 'st-1')

    expect(calls[0]).toEqual([
      'Identity/set',
      { accountId: ACC, ifInState: 'st-1', create: { new: DRAFT } },
      'i0',
    ])
  })

  it('resolves with the id the SERVER assigned, not the creation id', async () => {
    // The caller selects the new identity in the composer afterwards; `new` selects nothing.
    const { client } = fakeClient()

    const { id } = await makeIdentityClient(client, ACC).create(DRAFT, 'st-1')

    expect(id).toBe(SERVER_ID)
  })

  it('re-reads the list after a create instead of believing the echo', async () => {
    // The fake echoes nothing but the id, as RFC 8620 §5.3 allows. A client that rendered that echo
    // would show a nameless identity with no address — and hold a state string it can no longer write
    // against, because the server's has already moved on.
    const { client, calls } = fakeClient()

    const { snapshot, id } = await makeIdentityClient(client, ACC).create(DRAFT, 'st-1')

    expect(names(calls)).toEqual(['Identity/set', 'Identity/get'])
    expect(snapshot.identities.find((row) => row.id === id)).toMatchObject({
      email: 'new@waxwing.test',
      name: 'New',
      htmlSignature: '<p>Regards</p>',
    })
    expect(snapshot.state).toBe('st-2')
  })

  it('updates via `update: { <id>: patch }` with `ifInState`, then re-reads', async () => {
    const { client, calls } = fakeClient({ list: [ALICE] })

    const snapshot = await makeIdentityClient(client, ACC).update('i1', { name: 'Ally' }, 'st-1')

    expect(calls[0]).toEqual([
      'Identity/set',
      { accountId: ACC, ifInState: 'st-1', update: { i1: { name: 'Ally' } } },
      'i0',
    ])
    expect(names(calls)).toEqual(['Identity/set', 'Identity/get'])
    expect(snapshot.identities).toEqual([{ ...ALICE, name: 'Ally' }])
    expect(snapshot.state).toBe('st-2')
  })

  it('destroys via `destroy: [id]` with `ifInState`, then re-reads', async () => {
    const { client, calls } = fakeClient({ list: [ALICE, WORK] })

    const snapshot = await makeIdentityClient(client, ACC).destroy('i1', 'st-1')

    expect(calls[0]).toEqual([
      'Identity/set',
      { accountId: ACC, ifInState: 'st-1', destroy: ['i1'] },
      'i0',
    ])
    expect(names(calls)).toEqual(['Identity/set', 'Identity/get'])
    expect(snapshot.identities).toEqual([WORK])
  })
})

describe('makeIdentityClient — per-object refusals', () => {
  it('throws the server’s `forbiddenFrom` out of a refused create, and does not re-read', async () => {
    // The one refusal the UI can explain precisely (RFC 8621 §6.3: "you may not send from that
    // address"), so the type has to survive the trip — a generic "save failed" would send the user
    // hunting for a typo that is not there.
    const { client, calls } = fakeClient({
      onSet: () => ({ notCreated: { new: { type: 'forbiddenFrom', description: 'Not yours' } } }),
    })

    const error = await rejection(makeIdentityClient(client, ACC).create(DRAFT, 'st-1'))

    expect(error).toBeInstanceOf(IdentitySetError)
    expect((error as IdentitySetError).type).toBe('forbiddenFrom')
    expect((error as Error).message).toBe('Not yours')
    expect(names(calls)).toEqual(['Identity/set'])
  })

  it('throws the server’s type out of a refused update', async () => {
    const { client } = fakeClient({
      onSet: () => ({ notUpdated: { i1: { type: 'forbidden', description: 'Read-only' } } }),
    })

    const error = await rejection(makeIdentityClient(client, ACC).update('i1', { name: 'x' }, 's'))

    expect(error).toBeInstanceOf(IdentitySetError)
    expect((error as IdentitySetError).type).toBe('forbidden')
  })

  it('throws the server’s type out of a refused destroy (`mayDelete: false`)', async () => {
    const { client } = fakeClient({
      onSet: () => ({ notDestroyed: { i1: { type: 'forbidden', description: 'Cannot delete' } } }),
    })

    const error = await rejection(makeIdentityClient(client, ACC).destroy('i1', 'st-1'))

    expect(error).toBeInstanceOf(IdentitySetError)
    expect((error as IdentitySetError).type).toBe('forbidden')
  })

  it('refuses to report success when the server names our creation id in NEITHER map', async () => {
    // Silently succeeding here is the worst outcome available: the caller would go on to select an
    // id nobody ever created, and the composer would send from an identity the server does not know.
    const { client } = fakeClient({ onSet: () => ({ created: {}, notCreated: {} }) })

    const error = await rejection(makeIdentityClient(client, ACC).create(DRAFT, 'st-1'))

    expect(error).toBeInstanceOf(IdentitySetError)
  })

  it('survives a SetError with NO `description` — real servers omit the field', async () => {
    // The package's own `SetError` requires `description`; this client deliberately types the wire
    // shape looser. Reading a missing field as a message must not crash the save handler.
    const { client } = fakeClient({
      onSet: () => ({ notCreated: { new: { type: 'invalidProperties', properties: ['email'] } } }),
    })

    const error = await rejection(makeIdentityClient(client, ACC).create(DRAFT, 'st-1'))

    expect(error).toBeInstanceOf(IdentitySetError)
    expect((error as Error).message).toBe('invalidProperties')
    expect((error as IdentitySetError).properties).toEqual(['email'])
  })

  it('defaults `properties` to an empty list when the server sends none', async () => {
    const { client } = fakeClient({
      onSet: () => ({ notCreated: { new: { type: 'forbiddenFrom' } } }),
    })

    const error = await rejection(makeIdentityClient(client, ACC).create(DRAFT, 'st-1'))

    expect((error as IdentitySetError).properties).toEqual([])
  })
})

/**
 * The fixture is Stalwart-shaped: the submission capability lives ONLY in `accountCapabilities`.
 * Putting it at the top level too would make the delegated-account case below pass for free, since
 * a session-wide capability answers for every account.
 */
function session(): JmapSession {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
    accounts: {
      a: {
        name: 'alice@waxwing.test',
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, [SUBMISSION]: {} },
      },
      shared: {
        name: 'team@waxwing.test',
        isPersonal: false,
        isReadOnly: true,
        accountCapabilities: { 'urn:ietf:params:jmap:mail': {} },
      },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': ACC },
    username: 'alice@waxwing.test',
    apiUrl: 'http://localhost:18080/jmap/',
    downloadUrl: '',
    uploadUrl: '',
    eventSourceUrl: '',
    state: 's',
  } as unknown as JmapSession
}

describe('serverSupportsIdentities', () => {
  it('is true for an account that carries the submission capability', () => {
    expect(serverSupportsIdentities(session(), ACC)).toBe(true)
  })

  it('is false for a delegated account that cannot send (ADR-020)', () => {
    // Same URN carries `Identity/*` and `EmailSubmission/*`, so "no submission" means "cannot send
    // from here" — offering to manage the identities of such a mailbox promises a send that fails.
    expect(serverSupportsIdentities(session(), 'shared')).toBe(false)
  })

  it('is false before there is a session or an account, without throwing', () => {
    expect(serverSupportsIdentities(null, ACC)).toBe(false)
    expect(serverSupportsIdentities(session(), null)).toBe(false)
    expect(serverSupportsIdentities(null, null)).toBe(false)
  })
})
