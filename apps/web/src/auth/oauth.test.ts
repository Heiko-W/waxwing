import type { AuthorizationServer } from 'oauth4webapi'
import * as oauth from 'oauth4webapi'
import { describe, expect, it } from 'vitest'
import { computeRedirectUri, isLoopbackHttp } from './controller'
import {
  beginAuthorization,
  buildAuthorizationUrl,
  DEFAULT_SCOPES,
  type ResolvedOAuthConfig,
} from './oauth'

const CONFIG: ResolvedOAuthConfig = {
  issuer: 'https://mail.example.com',
  clientId: 'waxwing',
  scopes: ['urn:ietf:params:oauth:scope:mail', 'offline_access'],
  redirectUri: 'https://app.example.com/mail/',
  discovery: 'oauth2',
  allowInsecureRequests: false,
}

describe('buildAuthorizationUrl', () => {
  it('constructs an Authorization-Code + PKCE(S256) request with every required param', () => {
    const url = buildAuthorizationUrl({
      authorizationEndpoint: 'https://mail.example.com/authorize',
      clientId: 'waxwing',
      redirectUri: 'https://app.example.com/mail/',
      scopes: ['urn:ietf:params:oauth:scope:mail', 'offline_access'],
      codeChallenge: 'CHALLENGE123',
      state: 'STATE456',
    })
    const p = url.searchParams
    expect(url.origin + url.pathname).toBe('https://mail.example.com/authorize')
    expect(p.get('response_type')).toBe('code')
    expect(p.get('client_id')).toBe('waxwing')
    expect(p.get('redirect_uri')).toBe('https://app.example.com/mail/')
    expect(p.get('scope')).toBe('urn:ietf:params:oauth:scope:mail offline_access')
    expect(p.get('code_challenge')).toBe('CHALLENGE123')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('state')).toBe('STATE456')
  })

  it('preserves an existing query on the authorization endpoint', () => {
    const url = buildAuthorizationUrl({
      authorizationEndpoint: 'https://host/login?tenant=acme',
      clientId: 'c',
      redirectUri: 'https://app/cb',
      scopes: ['s'],
      codeChallenge: 'x',
      state: 'y',
    })
    expect(url.searchParams.get('tenant')).toBe('acme')
    expect(url.searchParams.get('client_id')).toBe('c')
  })
})

describe('beginAuthorization', () => {
  it('generates a real PKCE verifier whose S256 challenge matches the built URL', async () => {
    const as: AuthorizationServer = {
      issuer: CONFIG.issuer,
      authorization_endpoint: 'https://mail.example.com/authorize',
      token_endpoint: 'https://mail.example.com/token',
      code_challenge_methods_supported: ['S256'],
    }
    const { url, transaction } = await beginAuthorization(as, CONFIG)

    // The verifier is kept for the token exchange; the URL carries only its S256 hash.
    expect(transaction.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(url.searchParams.get('code_challenge')).toBe(
      await oauth.calculatePKCECodeChallenge(transaction.verifier),
    )
    expect(url.searchParams.get('code_challenge')).not.toBe(transaction.verifier)
    expect(url.searchParams.get('state')).toBe(transaction.state)
    expect(transaction.config).toEqual(CONFIG)
  })

  it('throws when the authorization endpoint is absent from discovery', async () => {
    const as: AuthorizationServer = { issuer: CONFIG.issuer, token_endpoint: 'https://x/token' }
    await expect(beginAuthorization(as, CONFIG)).rejects.toThrow(/authorization_endpoint/)
  })
})

describe('computeRedirectUri (FR-DEP-02)', () => {
  it('derives the redirect URI from the base href, stripping query and hash', () => {
    expect(computeRedirectUri('https://host/mail/#/inbox')).toBe('https://host/mail/')
    expect(computeRedirectUri('https://host/mail/?x=1')).toBe('https://host/mail/')
    expect(computeRedirectUri('https://host/')).toBe('https://host/')
  })

  it('honours an arbitrary deployment prefix', () => {
    expect(computeRedirectUri('https://cdn.example.com/apps/waxwing/')).toBe(
      'https://cdn.example.com/apps/waxwing/',
    )
  })
})

describe('isLoopbackHttp', () => {
  it('is true only for http loopback issuers', () => {
    expect(isLoopbackHttp('http://localhost:18080')).toBe(true)
    expect(isLoopbackHttp('http://127.0.0.1:8080')).toBe(true)
    expect(isLoopbackHttp('https://localhost')).toBe(false)
    expect(isLoopbackHttp('http://mail.example.com')).toBe(false)
    expect(isLoopbackHttp('not-a-url')).toBe(false)
  })
})

describe('DEFAULT_SCOPES', () => {
  it('requests JMAP mail access and offline_access (for a refresh token), not openid', () => {
    expect(DEFAULT_SCOPES).toContain('urn:ietf:params:oauth:scope:mail')
    expect(DEFAULT_SCOPES).toContain('offline_access')
    expect(DEFAULT_SCOPES).not.toContain('openid')
  })
})
