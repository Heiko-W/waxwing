/**
 * The JMAP seam for Stalwart's self-service registry.
 *
 * Four properties carry this file, and none of them is visible in a screenshot:
 *
 *  1. **The proprietary URN rides in `using`.** Without it Stalwart answers every `x:` call with
 *     `unknownMethod`; with it on a server that does not know the URN, RFC 8620 §3.3 obliges the
 *     server to reject the WHOLE request. So it must be present, per call, and never anywhere else.
 *  2. **`forbidden` on ONE method is not a failed screen.** The registry has a permission per object
 *     type and withholds them individually — an external directory takes the password away and
 *     leaves everything else. That has to arrive as "this block is absent", not as an exception.
 *  3. **The created secret is returned, not stored.** It exists once.
 *  4. **A settings patch carries ONE property.** Measured on v0.16.18: a patch with a valid and an
 *     invalid field answers `notUpdated` and writes the valid field anyway.
 *
 * The client is a hand-rolled fake of the `call()` seam, as `identity-client.test.ts` explains:
 * `packages/jmap/src/test-support.ts` is outside the package's published surface.
 */

import type { JmapClient } from '@waxwing/jmap'
import { MethodResponses } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import type { JmapSession } from '../app/session/types'
import {
  makeSelfServiceClient,
  STALWART_CAPABILITY,
  StalwartSetError,
  serverSupportsSelfService,
} from './stalwart-client'

const ACC = 'b'

type Call = [name: string, args: Record<string, unknown>, id: string]
type Echo = Record<string, unknown>

/** The five `/get` answers the fixture server really returns for a fresh account. */
const EMPTY_READS: Readonly<Record<string, Echo>> = {
  'x:AppPassword/get': { accountId: ACC, list: [], notFound: ['a'] },
  'x:AccountPassword/get': {
    accountId: ACC,
    list: [{ secret: '****', otpAuth: {}, id: 'singleton' }],
    notFound: [],
  },
  'x:AccountSettings/get': {
    accountId: ACC,
    list: [
      {
        description: 'Alice Anderson',
        locale: 'en_US',
        timeZone: null,
        encryptionAtRest: { '@type': 'Disabled' },
        id: 'singleton',
      },
    ],
    notFound: [],
  },
  'x:PublicKey/get': { accountId: ACC, list: [], notFound: [] },
  'x:SpamTrainingSample/get': { accountId: ACC, list: [], notFound: [] },
}

interface Fake {
  readonly client: JmapClient
  readonly calls: Call[]
  readonly using: (readonly string[] | undefined)[]
}

/**
 * A JMAP client that answers the five reads from a table and every `/set` from a script.
 *
 * `reads` overrides one answer; the value `'forbidden'` makes that ONE method a method-level error,
 * which is how the registry declines a permission the account does not hold.
 */
function fakeClient(
  options: {
    reads?: Record<string, Echo | 'forbidden'>
    onSet?: (name: string, args: Record<string, unknown>) => Echo
  } = {},
): Fake {
  const calls: Call[] = []
  const using: (readonly string[] | undefined)[] = []

  const client = {
    async call(invocations: Call[], opts?: { using?: readonly string[] }) {
      using.push(opts?.using)
      const responses: Call[] = []
      for (const [name, args, id] of invocations) {
        calls.push([name, args, id])
        const override = options.reads?.[name]
        if (override === 'forbidden') {
          responses.push([
            'error',
            { type: 'forbidden', description: 'You are not authorized to perform this action' },
            id,
          ])
          continue
        }
        if (name.endsWith('/get')) {
          responses.push([name, override ?? EMPTY_READS[name] ?? { list: [] }, id])
          continue
        }
        responses.push([name, options.onSet?.(name, args) ?? { accountId: ACC }, id])
      }
      return new MethodResponses(responses, 'session-1', undefined)
    },
  }
  return { client: client as unknown as JmapClient, calls, using }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    (value) => {
      throw new Error(`Expected a rejection, got ${JSON.stringify(value)}`)
    },
    (error: unknown) => error,
  )
}

describe('serverSupportsSelfService', () => {
  /** A session shaped like the pinned fixture: the URN on the ACCOUNT, not on the session. */
  function session(over: Partial<JmapSession> = {}): JmapSession {
    return {
      capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
      accounts: {
        [ACC]: {
          name: 'alice@waxwing.test',
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: {
            'urn:ietf:params:jmap:mail': {},
            [STALWART_CAPABILITY]: {},
          },
        },
      },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': ACC },
      ...over,
    } as unknown as JmapSession
  }

  it('finds the capability where Stalwart actually puts it — on the ACCOUNT', () => {
    // Measured on the pinned fixture (v0.16.18): 17 top-level URNs, `urn:stalwart:jmap` in none of
    // them, and present in `accounts.b.accountCapabilities`. A probe of `session.capabilities`
    // alone returns false here and hides the section on the only server that has it.
    const it_ = session()
    expect(Object.keys((it_ as { capabilities: object }).capabilities)).not.toContain(
      STALWART_CAPABILITY,
    )
    expect(serverSupportsSelfService(it_, ACC)).toBe(true)
  })

  it('is false on a server that does not advertise it at all', () => {
    const plain = session({
      accounts: {
        [ACC]: {
          name: 'alice@waxwing.test',
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: { 'urn:ietf:params:jmap:mail': {} },
        },
      },
    } as unknown as Partial<JmapSession>)
    expect(serverSupportsSelfService(plain, ACC)).toBe(false)
  })

  it('is false before there is a session or an account to ask about', () => {
    expect(serverSupportsSelfService(null, ACC)).toBe(false)
    expect(serverSupportsSelfService(session(), null)).toBe(false)
  })
})

describe('makeSelfServiceClient — reading', () => {
  it('opts the proprietary URN into `using`, on every request', async () => {
    // The method-name→capability derivation cannot see `x:` prefixes (they fall back to core), so
    // without this the server answers `unknownMethod` to all five reads.
    const fake = fakeClient()
    await makeSelfServiceClient(fake.client, ACC).load()
    expect(fake.using).toEqual([[STALWART_CAPABILITY]])
  })

  it('takes all five reads in ONE round trip', async () => {
    const fake = fakeClient()
    await makeSelfServiceClient(fake.client, ACC).load()

    expect(fake.using).toHaveLength(1)
    expect(fake.calls.map(([name]) => name)).toEqual([
      'x:AppPassword/get',
      'x:AccountPassword/get',
      'x:AccountSettings/get',
      'x:PublicKey/get',
      'x:SpamTrainingSample/get',
    ])
  })

  it('addresses the singletons by the literal id `singleton`', async () => {
    // Stalwart's registry singletons are not "the first record": they answer to that exact id, and
    // they have no `/query` to discover it with.
    const fake = fakeClient()
    await makeSelfServiceClient(fake.client, ACC).load()
    const settings = fake.calls.find(([name]) => name === 'x:AccountSettings/get')
    expect(settings?.[1]).toEqual({ accountId: ACC, ids: ['singleton'] })
  })

  it('reads the fixture server’s answers into the view the section renders', async () => {
    const fake = fakeClient({
      reads: {
        'x:AppPassword/get': {
          accountId: ACC,
          list: [
            {
              description: 'iPhone Mail',
              secret: '****',
              createdAt: '2026-08-21T17:53:43Z',
              expiresAt: null,
              permissions: { '@type': 'Inherit' },
              allowedIps: {},
              id: 'b',
            },
          ],
          // The account's OWN credential id comes back as not-found on a `get` with no `ids`.
          notFound: ['a'],
        },
      },
    })

    const snapshot = await makeSelfServiceClient(fake.client, ACC).load()

    expect(snapshot.appPasswords).toHaveLength(1)
    expect(snapshot.appPasswords?.[0]?.description).toBe('iPhone Mail')
    expect(snapshot.passwordReadable).toBe(true)
    expect(snapshot.language).toBe('en_US')
    expect(snapshot.encryption).toEqual({ kind: 'off' })
    expect(snapshot.spamSamples).toEqual([])
  })

  it('turns a per-method `forbidden` into an ABSENT block, not a broken screen', async () => {
    // An external LDAP/SQL directory strips `sysAccountPassword*` and leaves the rest. A load that
    // threw would take the whole section down over a permission the reader was never going to use.
    const fake = fakeClient({ reads: { 'x:AccountPassword/get': 'forbidden' } })

    const snapshot = await makeSelfServiceClient(fake.client, ACC).load()

    expect(snapshot.passwordReadable).toBe(false)
    expect(snapshot.appPasswords).toEqual([])
    expect(snapshot.language).toBe('en_US')
  })

  it('re-throws anything that is NOT a permission — a broken server must not look restricted', async () => {
    const client = {
      async call() {
        throw new Error('network down')
      },
    } as unknown as JmapClient

    await expect(makeSelfServiceClient(client, ACC).load()).rejects.toThrow('network down')
  })

  it('forwards the caller’s AbortSignal so an unmounted section stops its request', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const client = {
      async call(_calls: Call[], opts?: { signal?: AbortSignal }) {
        seen = opts?.signal
        return new MethodResponses(
          Object.entries(EMPTY_READS).map(
            ([name, echo], index) => [name, echo, 'aps kt'.split(' ')[index] ?? 'x'] as Call,
          ),
          's',
          undefined,
        )
      },
    } as unknown as JmapClient

    await makeSelfServiceClient(client, ACC)
      .load(controller.signal)
      .catch(() => {})
    expect(seen).toBe(controller.signal)
  })
})

describe('makeSelfServiceClient — app passwords', () => {
  it('returns the one-and-only secret and asks for nothing else', async () => {
    const fake = fakeClient({
      onSet: () => ({
        accountId: ACC,
        created: { new: { id: 'b', secret: 'app_aaaaaakdgrsdybtl9rwtd3ya2kzttbbot70a' } },
      }),
    })

    const created = await makeSelfServiceClient(fake.client, ACC).createAppPassword({
      description: 'iPhone Mail',
      expiresAt: null,
    })

    expect(created).toEqual({ id: 'b', secret: 'app_aaaaaakdgrsdybtl9rwtd3ya2kzttbbot70a' })
    // No `expiresAt` key at all for "never" — `null` is a value the registry would have to parse.
    expect(fake.calls[0]?.[1]).toEqual({
      accountId: ACC,
      create: { new: { description: 'iPhone Mail' } },
    })
  })

  it('sends the expiry when there is one', async () => {
    const fake = fakeClient({
      onSet: () => ({ created: { new: { id: 'c', secret: 'app_x' } } }),
    })

    await makeSelfServiceClient(fake.client, ACC).createAppPassword({
      description: 'Old laptop',
      expiresAt: '2027-01-01T00:00:00Z',
    })

    expect(fake.calls[0]?.[1]).toEqual({
      accountId: ACC,
      create: { new: { description: 'Old laptop', expiresAt: '2027-01-01T00:00:00Z' } },
    })
  })

  it('refuses to report success without a secret', async () => {
    // A "created" app password whose secret never arrived is a credential nobody can ever enter.
    const fake = fakeClient({ onSet: () => ({ created: { new: { id: 'b' } } }) })

    const error = await rejection(
      makeSelfServiceClient(fake.client, ACC).createAppPassword({
        description: 'x',
        expiresAt: null,
      }),
    )

    expect(error).toBeInstanceOf(StalwartSetError)
    expect((error as StalwartSetError).type).toBe('serverFail')
  })

  it('reads Stalwart’s `validationErrors` shape, which is not the RFC’s `properties`', async () => {
    // Measured: a create with no description answers
    // `{"type":"validationFailed","validationErrors":[{"type":"Required","property":"description"}]}`
    // — there is no `properties` array, so a client that only reads that one loses the field name.
    const fake = fakeClient({
      onSet: () => ({
        notCreated: {
          new: {
            type: 'validationFailed',
            validationErrors: [{ type: 'Required', property: 'description' }],
          },
        },
      }),
    })

    const error = (await rejection(
      makeSelfServiceClient(fake.client, ACC).createAppPassword({
        description: '',
        expiresAt: null,
      }),
    )) as StalwartSetError

    expect(error.type).toBe('validationFailed')
    expect(error.properties).toEqual(['description'])
  })

  it('revokes by id and reports a refusal rather than swallowing it', async () => {
    const ok = fakeClient({ onSet: () => ({ destroyed: ['b'] }) })
    await makeSelfServiceClient(ok.client, ACC).destroyAppPassword('b')
    expect(ok.calls[0]).toEqual(['x:AppPassword/set', { accountId: ACC, destroy: ['b'] }, 's0'])

    const refused = fakeClient({
      onSet: () => ({ notDestroyed: { b: { type: 'forbidden', description: 'no' } } }),
    })
    await expect(
      makeSelfServiceClient(refused.client, ACC).destroyAppPassword('b'),
    ).rejects.toBeInstanceOf(StalwartSetError)
  })
})

describe('makeSelfServiceClient — the account password', () => {
  it('always sends `currentSecret`, because the server always requires it', async () => {
    const fake = fakeClient({ onSet: () => ({ updated: { singleton: null } }) })

    await makeSelfServiceClient(fake.client, ACC).changePassword('old-Pw1!', 'new-Pw1!')

    expect(fake.calls[0]).toEqual([
      'x:AccountPassword/set',
      { accountId: ACC, update: { singleton: { currentSecret: 'old-Pw1!', secret: 'new-Pw1!' } } },
      's0',
    ])
  })

  it('carries the server’s own words out with the refusal', async () => {
    // `forbidden` means BOTH "current secret is incorrect" and "an external directory owns this
    // password". They are one `type`, so the sentence the server sent is the only thing that tells
    // the reader which of the two happened.
    const fake = fakeClient({
      onSet: () => ({
        notUpdated: {
          singleton: { type: 'forbidden', description: 'Current secret is incorrect.' },
        },
      }),
    })

    const error = (await rejection(
      makeSelfServiceClient(fake.client, ACC).changePassword('wrong', 'new-Pw1!'),
    )) as StalwartSetError

    expect(error.type).toBe('forbidden')
    expect(error.serverDescription).toBe('Current secret is incorrect.')
  })

  it('passes the strength rule the SERVER states, rather than inventing one', async () => {
    const fake = fakeClient({
      onSet: () => ({
        notUpdated: {
          singleton: {
            type: 'invalidProperties',
            description: 'Password must be at least 8 characters long.',
            properties: ['secret'],
          },
        },
      }),
    })

    const error = (await rejection(
      makeSelfServiceClient(fake.client, ACC).changePassword('old-Pw1!', 'abc'),
    )) as StalwartSetError

    expect(error.serverDescription).toBe('Password must be at least 8 characters long.')
    expect(error.properties).toEqual(['secret'])
  })
})

describe('makeSelfServiceClient — account settings', () => {
  it('patches exactly ONE property', async () => {
    // Measured on v0.16.18: `{"timeZone":"Europe/Berlin","locale":"de"}` answers `notUpdated` for
    // `locale` and writes `timeZone` anyway. With one property per patch the refusal and the write
    // cannot disagree.
    const fake = fakeClient({ onSet: () => ({ updated: { singleton: null } }) })

    await makeSelfServiceClient(fake.client, ACC).setLanguage('de_DE')

    expect(fake.calls[0]).toEqual([
      'x:AccountSettings/set',
      { accountId: ACC, update: { singleton: { locale: 'de_DE' } } },
      's0',
    ])
  })

  it('reports the enum refusal instead of pretending the language changed', async () => {
    const fake = fakeClient({
      onSet: () => ({
        notUpdated: {
          singleton: {
            type: 'invalidPatch',
            description: 'Invalid value Str("de") for enum type EnUS.',
            properties: ['locale'],
          },
        },
      }),
    })

    await expect(makeSelfServiceClient(fake.client, ACC).setLanguage('de')).rejects.toBeInstanceOf(
      StalwartSetError,
    )
  })
})

describe('makeSelfServiceClient — spam training samples', () => {
  it('destroys one by id', async () => {
    const fake = fakeClient({ onSet: () => ({ destroyed: ['s1'] }) })
    await makeSelfServiceClient(fake.client, ACC).destroySpamSample('s1')
    expect(fake.calls[0]).toEqual([
      'x:SpamTrainingSample/set',
      { accountId: ACC, destroy: ['s1'] },
      's0',
    ])
  })

  it('offers no way to CREATE one — the account is not permitted to', async () => {
    // `sysSpamTrainingSampleCreate` is absent from a normal account's permissions; the server
    // answers `forbidden`. A "create" on this client would be a button that can only ever fail.
    const client = makeSelfServiceClient(fakeClient().client, ACC)
    expect(Object.keys(client)).not.toContain('createSpamSample')
  })
})
