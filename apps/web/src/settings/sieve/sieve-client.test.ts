/**
 * The JMAP seam for filter rules (M5.2, FR-SIEVE-01/02, RFC 9661).
 *
 * These tests pin the three protocol details that a reasonable-looking implementation gets wrong,
 * each of which fails silently rather than loudly:
 *
 * - a save that sends the script inline instead of uploading it first;
 * - a deactivate that sends `onSuccessActivateScript: null`, which the RFC requires the server to
 *   IGNORE — the old script keeps filtering mail while the UI says filtering is off;
 * - trusting the `/set` echo to say what is active, when an activation-only call may report
 *   nothing at all.
 *
 * The client is a hand-rolled fake of the `call()`/`upload()`/`download()` seams, matching
 * `identity-client.test.ts`: the package's `jmapPostMock` is not part of its published surface.
 */

import type { Id, JmapClient, SieveScript } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import type { JmapSession } from '../../app/session/types'
import {
  MANAGED_SCRIPT_NAME,
  makeSieveClient,
  SieveSetError,
  serverSupportsSieve,
  sieveExtensions,
} from './sieve-client'

const ACC = 'a'
const SIEVE = 'urn:ietf:params:jmap:sieve'
/** The blob id the fake server mints on upload — deliberately not the one it stores on the script. */
const UPLOADED = 'blob-uploaded'

function script(overrides: Partial<SieveScript> = {}): SieveScript {
  return {
    id: 's1',
    name: MANAGED_SCRIPT_NAME,
    blobId: 'blob-stored',
    isActive: true,
    ...overrides,
  }
}

type Call = [name: string, args: Record<string, unknown>, id: string]

interface Fake {
  client: JmapClient
  calls: Call[]
  uploads: { data: unknown; type: string | undefined }[]
  downloads: Id[]
}

/**
 * A server that serves `SieveScript/get` from a mutable list.
 *
 * `/set` deliberately returns an EMPTY `updated` for an activation-only call — which is what
 * Stalwart does, contrary to RFC 9661 §2.4. A client that believed the echo would never learn
 * which script ended up active.
 */
function fakeClient(
  options: { list?: SieveScript[]; source?: string; refuse?: Record<string, unknown> } = {},
): Fake {
  const calls: Call[] = []
  const uploads: { data: unknown; type: string | undefined }[] = []
  const downloads: Id[] = []
  const list = options.list ?? [script()]

  const client = {
    async call(invocations: Call[]) {
      const responses: Call[] = []
      for (const [name, args, id] of invocations) {
        calls.push([name, args, id])
        if (name === 'SieveScript/get') {
          responses.push([name, { accountId: ACC, state: 'st-1', list, notFound: [] }, id])
          continue
        }
        responses.push([
          name,
          {
            accountId: ACC,
            oldState: 'st-0',
            newState: 'st-1',
            created: null,
            updated: null,
            destroyed: null,
            notCreated: null,
            notUpdated: null,
            notDestroyed: null,
            ...(options.refuse ?? {}),
            ...(name === 'SieveScript/validate' ? { error: null } : {}),
          },
          id,
        ])
      }
      return {
        get<T>(id: string): T {
          const found = responses.find(([, , callId]) => callId === id)
          if (found === undefined) throw new Error(`no response for ${id}`)
          return found[1] as T
        },
      }
    },
    async upload(_accountId: Id, data: unknown, opts?: { type?: string }) {
      uploads.push({ data, type: opts?.type })
      return { accountId: ACC, blobId: UPLOADED, type: opts?.type ?? '', size: 0 }
    },
    async download(_accountId: Id, blobId: Id) {
      downloads.push(blobId)
      return new TextEncoder().encode(options.source ?? '# existing\n')
    },
  } as unknown as JmapClient

  return { client, calls, uploads, downloads }
}

const names = (calls: Call[]) => calls.map(([name]) => name)
const setArgs = (calls: Call[]) =>
  calls.filter(([name]) => name === 'SieveScript/set').map(([, args]) => args)

describe('load', () => {
  it('downloads the active script’s source', async () => {
    const fake = fakeClient({ source: 'if true { stop; }' })
    const snapshot = await makeSieveClient(fake.client, ACC).load()

    expect(snapshot.active?.source).toBe('if true { stop; }')
    expect(fake.downloads).toEqual(['blob-stored'])
  })

  it('hides the server-managed vacation script', async () => {
    // It is written by `VacationResponse/set`; offering it here invites an edit the server refuses
    // and that would contradict the vacation section.
    const fake = fakeClient({
      list: [script(), script({ id: 's2', name: 'vacation', isActive: false })],
    })
    const snapshot = await makeSieveClient(fake.client, ACC).load()

    expect(snapshot.scripts.map((s) => s.name)).toEqual([MANAGED_SCRIPT_NAME])
  })

  it('reports no active script rather than failing when none is', async () => {
    const fake = fakeClient({ list: [script({ isActive: false })] })
    const snapshot = await makeSieveClient(fake.client, ACC).load()

    expect(snapshot.active).toBeNull()
    expect(fake.downloads).toEqual([])
  })
})

describe('save', () => {
  it('uploads the source as application/sieve and references the returned blob id', async () => {
    const fake = fakeClient()
    await makeSieveClient(fake.client, ACC).save('if true { stop; }', script())

    expect(fake.uploads).toEqual([{ data: 'if true { stop; }', type: 'application/sieve' }])
    const [args] = setArgs(fake.calls)
    expect(args?.update).toEqual({ s1: { blobId: UPLOADED } })
    // RFC 9661 §2.2: content is never a property of the object.
    expect(JSON.stringify(args)).not.toContain('if true')
  })

  it('activates a newly created script through its creation reference', async () => {
    const fake = fakeClient({ list: [] })
    await makeSieveClient(fake.client, ACC).save('# rules', null)

    const [args] = setArgs(fake.calls)
    expect(args?.create).toEqual({ managed: { name: MANAGED_SCRIPT_NAME, blobId: UPLOADED } })
    expect(args?.onSuccessActivateScript).toBe('#managed')
  })

  it('re-reads instead of trusting the echo, which may report nothing at all', async () => {
    const fake = fakeClient()
    await makeSieveClient(fake.client, ACC).save('# rules', script())

    expect(names(fake.calls)).toEqual(['SieveScript/set', 'SieveScript/get'])
  })

  it('surfaces a per-object refusal as a typed error', async () => {
    const fake = fakeClient({
      // Stalwart's spelling of "this does not compile" is the pre-RFC one.
      refuse: {
        notUpdated: { s1: { type: 'invalidScript', description: 'line 3: syntax error' } },
      },
    })

    await expect(makeSieveClient(fake.client, ACC).save('nonsense', script())).rejects.toThrow(
      SieveSetError,
    )
  })
})

describe('deactivate', () => {
  it('uses onSuccessDeactivateScript, never a null activate id', async () => {
    const fake = fakeClient()
    await makeSieveClient(fake.client, ACC).deactivate()

    const [args] = setArgs(fake.calls)
    expect(args).toHaveProperty('onSuccessDeactivateScript', true)
    // `onSuccessActivateScript: null` must be IGNORED by a conformant server (RFC 9661 §2.4), so
    // sending it would leave the old script filtering mail while the UI claims filtering is off.
    expect(args).not.toHaveProperty('onSuccessActivateScript')
  })
})

describe('destroy', () => {
  it('deactivates in a separate call before destroying the active script', async () => {
    // RFC 9661 §2.4 requires the two to be separate method calls; batching them is refused.
    const fake = fakeClient()
    await makeSieveClient(fake.client, ACC).destroy(script())

    expect(names(fake.calls)).toEqual(['SieveScript/set', 'SieveScript/set', 'SieveScript/get'])
    const [first, second] = setArgs(fake.calls)
    expect(first).toHaveProperty('onSuccessDeactivateScript', true)
    expect(second).toHaveProperty('destroy', ['s1'])
  })

  it('destroys an inactive script in one call', async () => {
    const fake = fakeClient()
    await makeSieveClient(fake.client, ACC).destroy(script({ isActive: false }))

    expect(setArgs(fake.calls)).toHaveLength(1)
  })
})

describe('validate', () => {
  it('uploads first and validates by blob id', async () => {
    const fake = fakeClient()
    const error = await makeSieveClient(fake.client, ACC).validate('# check me')

    expect(fake.uploads[0]?.type).toBe('application/sieve')
    const [, args] = fake.calls.find(([name]) => name === 'SieveScript/validate') ?? []
    expect(args).toEqual({ accountId: ACC, blobId: UPLOADED })
    expect(error).toBeNull()
  })
})

describe('capability probes', () => {
  const session = (accountCapabilities: Record<string, unknown>): JmapSession =>
    ({ capabilities: {}, accounts: { [ACC]: { accountCapabilities } } }) as unknown as JmapSession

  it('finds the capability on the account, where Stalwart puts the limits', () => {
    expect(serverSupportsSieve(session({ [SIEVE]: {} }), ACC)).toBe(true)
    expect(serverSupportsSieve(session({}), ACC)).toBe(false)
    expect(serverSupportsSieve(null, ACC)).toBe(false)
  })

  it('reads the advertised extension list', () => {
    const advertised = session({ [SIEVE]: { sieveExtensions: ['fileinto', 'imap4flags'] } })
    expect(sieveExtensions(advertised, ACC)).toEqual(['fileinto', 'imap4flags'])
  })

  it('returns undefined when the server advertised no list, rather than an empty one', () => {
    // "Unknown" and "supports nothing" must not collapse: the caller warns on the difference.
    expect(sieveExtensions(session({ [SIEVE]: {} }), ACC)).toBeUndefined()
  })
})
