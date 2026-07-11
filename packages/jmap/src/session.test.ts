import { describe, expect, it } from 'vitest'
import { basic, bearer } from './auth'
import {
  getCoreCapability,
  getMailCapability,
  getSession,
  normalizeSession,
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
  it('resolves relative *Url fields and preserves URI-template braces', () => {
    const raw = {
      ...makeSession(),
      apiUrl: '/jmap/api',
      // Root-relative template: resolves to origin root, braces intact.
      uploadUrl: '/jmap/upload/{accountId}',
      // Absolute template (a different host): kept, and NOT percent-encoded.
      downloadUrl: 'https://cdn.example.com/dl/{accountId}/{blobId}?type={type}',
      eventSourceUrl: '/es?types={types}',
    }
    const normalized = normalizeSession(raw, 'https://mail.example.com/.well-known/jmap')
    expect(normalized.apiUrl).toBe('https://mail.example.com/jmap/api')
    expect(normalized.uploadUrl).toBe('https://mail.example.com/jmap/upload/{accountId}')
    expect(normalized.downloadUrl).toBe(
      'https://cdn.example.com/dl/{accountId}/{blobId}?type={type}',
    )
    expect(normalized.eventSourceUrl).toBe('https://mail.example.com/es?types={types}')
  })
})

describe('getSession', () => {
  it('fetches /.well-known/jmap with the auth header and resolves relative URLs', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const fetch: FetchLike = async (url, init) => {
      seenUrl = url
      seenAuth = init?.headers?.Authorization ?? ''
      const body = { ...makeSession(), apiUrl: '/jmap/api' }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const session = await getSession('https://mail.example.com', bearer('abc'), { fetch })
    expect(seenUrl).toBe('https://mail.example.com/.well-known/jmap')
    expect(seenAuth).toBe('Bearer abc')
    expect(session.apiUrl).toBe('https://mail.example.com/jmap/api')
  })

  it('surfaces an authentication failure as a thrown error', async () => {
    const fetch: FetchLike = async () => new Response('no', { status: 401 })
    await expect(getSession('https://mail.example.com', bearer('x'), { fetch })).rejects.toThrow()
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

describe('sessionStateChanged', () => {
  it('detects a changed sessionState', () => {
    const session = makeSession()
    expect(sessionStateChanged(session, { sessionState: 's0' })).toBe(false)
    expect(sessionStateChanged(session, { sessionState: 's9' })).toBe(true)
  })
})

describe('auth schemes', () => {
  it('basic() base64-encodes user:pass per RFC 7617', () => {
    expect(basic('alice', 'secret').authorization()).toBe(`Basic ${btoa('alice:secret')}`)
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
