import { describe, expect, it } from 'vitest'
import { basic, bearer } from './auth'
import { JmapSessionOriginError } from './errors'
import {
  getCoreCapability,
  getMailCapability,
  getSession,
  getWebPushVapidCapability,
  hasCapability,
  normalizeSession,
  secondaryMailAccounts,
  sessionStateChanged,
  toWellKnownUrl,
} from './session'
import { at, makeSession } from './test-support'
import type { FetchLike } from './transport'

describe('toWellKnownUrl', () => {
  it('appends the well-known path to an origin/base', () => {
    expect(toWellKnownUrl('https://mail.example.com')).toBe(
      'https://mail.example.com/.well-known/jmap',
    )
    expect(toWellKnownUrl('https://mail.example.com/')).toBe(
      'https://mail.example.com/.well-known/jmap',
    )
  })
  it('passes a full well-known URL through unchanged', () => {
    expect(toWellKnownUrl('https://x.test/.well-known/jmap')).toBe(
      'https://x.test/.well-known/jmap',
    )
  })
  it('resolves empty / root to the relative well-known path (same-origin)', () => {
    expect(toWellKnownUrl('')).toBe('/.well-known/jmap')
    expect(toWellKnownUrl('/')).toBe('/.well-known/jmap')
  })
})

describe('normalizeSession', () => {
  const ORIGIN = 'https://mail.example.com'
  const BASE = `${ORIGIN}/.well-known/jmap`

  it('resolves relative *Url fields and preserves URI-template braces', () => {
    const raw = {
      ...makeSession(),
      apiUrl: '/jmap/api',
      // Root-relative template: resolves to origin root, braces intact.
      uploadUrl: '/jmap/upload/{accountId}',
      // Absolute template on the connected origin: kept, and NOT percent-encoded.
      downloadUrl: `${ORIGIN}/dl/{accountId}/{blobId}?type={type}`,
      eventSourceUrl: '/es?types={types}',
    }
    const normalized = normalizeSession(raw, BASE, ORIGIN)
    expect(normalized.apiUrl).toBe('https://mail.example.com/jmap/api')
    expect(normalized.uploadUrl).toBe('https://mail.example.com/jmap/upload/{accountId}')
    expect(normalized.downloadUrl).toBe(
      'https://mail.example.com/dl/{accountId}/{blobId}?type={type}',
    )
    expect(normalized.eventSourceUrl).toBe('https://mail.example.com/es?types={types}')
  })

  it('rejects every *Url field that resolves off the connected origin (S7)', () => {
    // This case used to be PINNED as "absolute template on a different host: kept". That
    // expectation was wrong: transport/blob/push attach the Authorization header to whatever
    // these fields say, so keeping a foreign host means shipping the credential to it the first
    // time the app downloads an attachment or opens the event stream. Nothing but this check
    // stood between an altered /.well-known/jmap response and that.
    for (const field of ['apiUrl', 'downloadUrl', 'uploadUrl', 'eventSourceUrl'] as const) {
      const raw = { ...makeSession(), [field]: 'https://cdn.evil.test/x/{accountId}' }
      // The other three fields resolve on-origin, so only `field` can be what trips this.
      raw.apiUrl = field === 'apiUrl' ? raw.apiUrl : `${ORIGIN}/jmap/api`
      raw.downloadUrl = field === 'downloadUrl' ? raw.downloadUrl : `${ORIGIN}/dl/{blobId}`
      raw.uploadUrl = field === 'uploadUrl' ? raw.uploadUrl : `${ORIGIN}/up/{accountId}`
      raw.eventSourceUrl = field === 'eventSourceUrl' ? raw.eventSourceUrl : `${ORIGIN}/es`
      const error = catchError(() => normalizeSession(raw, BASE, ORIGIN))
      expect(error, field).toBeInstanceOf(JmapSessionOriginError)
      expect((error as JmapSessionOriginError).field).toBe(field)
    }
  })

  it('treats a differing port or scheme as a differing origin', () => {
    // Same host, other port / other scheme — a distinct origin to the browser, and just as
    // capable of being another server's listener.
    for (const apiUrl of ['https://mail.example.com:8443/jmap', 'http://mail.example.com/jmap']) {
      const raw = { ...makeSession(), apiUrl }
      expect(() => normalizeSession(raw, BASE, ORIGIN), apiUrl).toThrow(JmapSessionOriginError)
    }
  })

  it('rejects a field that stays relative — nothing proves it same-origin', () => {
    // Relative value + relative base ⇒ resolveUrl gives up and passes it through verbatim. With
    // an origin to enforce that is not "harmless", it is an unverified target.
    const raw = { ...makeSession(), apiUrl: '/jmap/api' }
    expect(() => normalizeSession(raw, '/.well-known/jmap', ORIGIN)).toThrow(JmapSessionOriginError)
  })

  it('skips the check when no origin could be determined (SSR / mock fetch)', () => {
    // `null` is what getSession passes when the connect URL is relative and there is no document
    // to resolve it against. Off-origin URLs then pass through — a browser never takes this path.
    const raw = { ...makeSession(), apiUrl: 'https://cdn.evil.test/jmap' }
    expect(normalizeSession(raw, BASE, null).apiUrl).toBe('https://cdn.evil.test/jmap')
  })
})

/** Runs `fn` and returns whatever it threw (so a test can assert on the error's fields). */
function catchError(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (error) {
    return error
  }
}

describe('getSession', () => {
  it('fetches /.well-known/jmap with the auth header and resolves relative URLs', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const fetch: FetchLike = async (url, init) => {
      seenUrl = url
      seenAuth = init?.headers?.Authorization ?? ''
      // The fixture's *Url fields all sit on mail.waxwing.test — the host connected to below, as
      // any real session's do; only `apiUrl` is made relative to exercise the resolution.
      const body = { ...makeSession(), apiUrl: '/jmap/api' }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const session = await getSession('https://mail.waxwing.test', bearer('abc'), { fetch })
    expect(seenUrl).toBe('https://mail.waxwing.test/.well-known/jmap')
    expect(seenAuth).toBe('Bearer abc')
    expect(session.apiUrl).toBe('https://mail.waxwing.test/jmap/api')
  })

  it('surfaces an authentication failure as a thrown error', async () => {
    const fetch: FetchLike = async () => new Response('no', { status: 401 })
    await expect(getSession('https://mail.example.com', bearer('x'), { fetch })).rejects.toThrow()
  })

  it('validates against the CONNECT origin, not the redirected response URL (S7)', async () => {
    // An open redirect (or a hijacked well-known path) lands the session fetch on another host,
    // whose document names only relative URLs — they resolve against `response.url` and would
    // silently become evil.test endpoints carrying the Authorization header. The expected origin
    // is taken from the URL the caller configured, so the redirect cannot nominate its own.
    const fetch: FetchLike = async () => {
      const body = {
        ...makeSession(),
        apiUrl: '/jmap/api',
        downloadUrl: '/dl/{blobId}',
        uploadUrl: '/up/{accountId}',
        eventSourceUrl: '/es',
      }
      const response = new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
      Object.defineProperty(response, 'url', { value: 'https://evil.test/.well-known/jmap' })
      return response
    }
    await expect(
      getSession('https://mail.example.com', bearer('abc'), { fetch }),
    ).rejects.toBeInstanceOf(JmapSessionOriginError)
  })
})

describe('getCoreCapability', () => {
  it('reads the numeric limits from the session', () => {
    const cap = getCoreCapability(makeSession({ maxObjectsInGet: 42 }))
    expect(cap?.maxObjectsInGet).toBe(42)
    expect(cap?.collationAlgorithms).toEqual(['i;ascii-numeric'])
  })
  it('returns null when the core capability is absent', () => {
    const session = makeSession()
    session.capabilities = {}
    expect(getCoreCapability(session)).toBeNull()
  })
})

describe('getMailCapability', () => {
  it('reads the mail limits from the account capability', () => {
    const session = makeSession()
    session.accounts.a = {
      ...at(Object.values(session.accounts), 0),
      accountCapabilities: {
        'urn:ietf:params:jmap:mail': {
          maxSizeAttachmentsPerEmail: 50_000_000,
          emailQuerySortOptions: ['receivedAt'],
        },
      },
    }
    expect(getMailCapability(session, 'a')?.maxSizeAttachmentsPerEmail).toBe(50_000_000)
  })

  it('returns null for an unknown account or a missing capability', () => {
    const session = makeSession() // the fixture account has accountCapabilities: {}
    expect(getMailCapability(session, 'nope')).toBeNull()
    expect(getMailCapability(session, 'a')).toBeNull()
  })
})

describe('getWebPushVapidCapability (RFC 9749)', () => {
  const VAPID = 'urn:ietf:params:jmap:webpush-vapid'

  it('reads the applicationServerKey when the server advertises one', () => {
    const session = makeSession()
    session.capabilities[VAPID] = { applicationServerKey: 'BEl62iUYgUiv…' }
    expect(getWebPushVapidCapability(session)?.applicationServerKey).toBe('BEl62iUYgUiv…')
  })

  it('returns null when the capability is absent, as on most JMAP servers', () => {
    // The fixture session is a server that does not implement RFC 9749: core, mail, submission…
    // and no VAPID. (Stalwart does implement it as of v0.16.14 — see the case above.)
    expect(getWebPushVapidCapability(makeSession())).toBeNull()
  })

  it('returns null for a malformed capability rather than handing out a bad key', () => {
    // A key that is not a non-empty string would be passed straight to PushManager.subscribe(),
    // where it throws — better to report "unsupported" than to break the subscribe call.
    const session = makeSession()
    for (const bad of [null, 'nope', 42, {}, { applicationServerKey: '' }, { key: 'x' }]) {
      session.capabilities[VAPID] = bad
      expect(getWebPushVapidCapability(session), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('hasCapability (M3.7)', () => {
  it('finds a capability advertised at SESSION level', () => {
    expect(hasCapability(makeSession(), 'urn:ietf:params:jmap:core')).toBe(true)
  })

  it('finds one advertised ONLY on the account — the case Stalwart forces', () => {
    // Stalwart advertises `mail` at both levels but leaves the SESSION-level object empty and puts
    // every real limit in the account. A predicate that only looked at `session.capabilities` would
    // still pass there — but one that only looked at the account would not, and a server is free to
    // announce a per-account capability without a session-level twin. Check both.
    const session = makeSession()
    session.accounts.a = {
      ...at(Object.values(session.accounts), 0),
      accountCapabilities: { 'urn:ietf:params:jmap:quota': {} },
    }
    expect(hasCapability(session, 'urn:ietf:params:jmap:quota', 'a')).toBe(true)
    // …and without the accountId there is nowhere to look.
    expect(hasCapability(session, 'urn:ietf:params:jmap:quota')).toBe(false)
  })

  it('is false for a capability nobody advertises, and for an unknown account', () => {
    const session = makeSession()
    expect(hasCapability(session, 'urn:ietf:params:jmap:vacationresponse', 'a')).toBe(false)
    expect(hasCapability(session, 'urn:ietf:params:jmap:quota', 'nope')).toBe(false)
  })

  it('does not mistake an inherited Object.prototype key for a capability', () => {
    const session = makeSession()
    expect(hasCapability(session, 'toString', 'a')).toBe(false)
    expect(hasCapability(session, 'constructor', 'a')).toBe(false)
  })
})

describe('secondaryMailAccounts (M4.4)', () => {
  const MAIL = 'urn:ietf:params:jmap:mail'

  it('returns [] when the primary mail account is the only one', () => {
    // makeSession() ships a single personal account 'a' — the primary.
    expect(secondaryMailAccounts(makeSession(), 'a')).toEqual([])
  })

  it('lifts a delegated account that carries account-level mail', () => {
    const session = makeSession()
    session.accounts.b = {
      name: 'team@waxwing.test',
      isPersonal: false,
      isReadOnly: true,
      accountCapabilities: { [MAIL]: {} },
    }
    expect(secondaryMailAccounts(session, 'a')).toEqual([
      { id: 'b', name: 'team@waxwing.test', isPersonal: false, isReadOnly: true },
    ])
  })

  it('excludes a shared account without account-level mail — even though the SESSION advertises mail', () => {
    // makeSession() advertises `mail` at SESSION level, so a hasCapability()-based filter would
    // wrongly keep this contacts-only share. Only the per-account object says mail is usable here.
    const session = makeSession()
    session.accounts.c = {
      name: 'contacts@waxwing.test',
      isPersonal: false,
      isReadOnly: false,
      accountCapabilities: { 'urn:ietf:params:jmap:contacts': {} },
    }
    expect(secondaryMailAccounts(session, 'a')).toEqual([])
  })

  it('excludes the primary by id and preserves account order', () => {
    const session = makeSession()
    session.accounts.b = {
      name: 'team@waxwing.test',
      isPersonal: false,
      isReadOnly: true,
      accountCapabilities: { [MAIL]: {} },
    }
    session.accounts.d = {
      name: 'ops@waxwing.test',
      isPersonal: false,
      isReadOnly: false,
      accountCapabilities: { [MAIL]: {} },
    }
    expect(secondaryMailAccounts(session, 'a').map((a) => a.id)).toEqual(['b', 'd'])
  })
})

describe('sessionStateChanged', () => {
  it('detects a changed sessionState', () => {
    const session = makeSession()
    expect(sessionStateChanged(session, { sessionState: 's0' })).toBe(false)
    expect(sessionStateChanged(session, { sessionState: 's9' })).toBe(true)
  })
})

describe('auth schemes', () => {
  it('basic() base64-encodes UTF-8 user:pass per RFC 7617', () => {
    // Compared against a UTF-8 encoder, never against `btoa('alice:secret')` — that reference is
    // the naive implementation, so it would keep passing after base64() was "simplified" to a bare
    // btoa() and would then have blessed a client that cannot sign in with a non-Latin1 password.
    expect(basic('alice', 'sécret✓').authorization()).toBe(
      `Basic ${Buffer.from('alice:sécret✓', 'utf8').toString('base64')}`,
    )
  })
  it('bearer() accepts an async token getter', async () => {
    const provider = bearer(async () => 'refreshed')
    expect(await provider.authorization()).toBe('Bearer refreshed')
  })
})

// A concrete assertion that the test helper's session is internally consistent.
it('makeSession exposes the primary mail account', () => {
  const session = makeSession()
  expect(at(Object.keys(session.accounts), 0)).toBe('a')
  expect(session.primaryAccounts['urn:ietf:params:jmap:mail']).toBe('a')
})
