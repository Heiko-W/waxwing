import { describe, expect, it } from 'vitest'
import { InvalidTargetError, pinnedTarget, resolveManualTarget, sameOriginTarget } from './target'

describe('connect target resolution', () => {
  it('builds a same-origin autoconnect target that hides the server field', () => {
    expect(sameOriginTarget('https://mail.example.com')).toEqual({
      connectUrl: 'https://mail.example.com',
      issuer: 'https://mail.example.com',
      displayHost: 'mail.example.com',
      fromProbe: true,
    })
  })

  it('pins a configured session URL and derives its issuer origin', () => {
    expect(pinnedTarget('https://host.example:8443/jmap/session')).toEqual({
      connectUrl: 'https://host.example:8443/jmap/session',
      issuer: 'https://host.example:8443',
      displayHost: 'host.example:8443',
      fromProbe: false,
    })
  })

  it('derives https://{domain} from an email address (FR-AUTH-02)', () => {
    expect(resolveManualTarget('alice@waxwing.test')).toEqual({
      connectUrl: 'https://waxwing.test',
      issuer: 'https://waxwing.test',
      displayHost: 'waxwing.test',
      fromProbe: false,
    })
  })

  it('normalizes a schemeless host to https and keeps it editable', () => {
    expect(resolveManualTarget('mail.example.com')).toEqual({
      connectUrl: 'https://mail.example.com',
      issuer: 'https://mail.example.com',
      displayHost: 'mail.example.com',
      fromProbe: false,
    })
  })

  it('passes a full URL through, deriving the issuer from its origin', () => {
    const target = resolveManualTarget('https://mail.example.com:8443/jmap')
    expect(target.connectUrl).toBe('https://mail.example.com:8443/jmap')
    expect(target.issuer).toBe('https://mail.example.com:8443')
    expect(target.displayHost).toBe('mail.example.com:8443')
    expect(target.fromProbe).toBe(false)
  })

  it('rejects unusable input', () => {
    expect(() => resolveManualTarget('')).toThrow(InvalidTargetError)
    expect(() => resolveManualTarget('   ')).toThrow(InvalidTargetError)
    expect(() => resolveManualTarget('alice@')).toThrow(InvalidTargetError)
    expect(() => resolveManualTarget('alice@bad domain')).toThrow(InvalidTargetError)
  })
})
