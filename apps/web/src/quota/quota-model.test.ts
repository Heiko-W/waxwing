import type { Quota } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { pickPrimaryQuota, quotaLevel, toQuotaView } from './quota-model'

const quota = (over: Partial<Quota> = {}): Quota => ({
  id: 'q1',
  resourceType: 'octets',
  used: 0,
  hardLimit: 1000,
  scope: 'account',
  name: 'alice@waxwing.test',
  types: ['Email'],
  warnLimit: null,
  softLimit: null,
  description: null,
  ...over,
})

describe('quotaLevel', () => {
  it('is ok below 90 %', () => {
    expect(quotaLevel(899, 1000, null)).toBe('ok')
  })

  it('warns at exactly 90 % — the threshold FR-QTA-01 promises', () => {
    expect(quotaLevel(900, 1000, null)).toBe('warn')
  })

  it('warns EARLIER when the server asks it to', () => {
    // A server that wants to warn at 50 % is entitled to; our floor must not silence it.
    expect(quotaLevel(500, 1000, 500)).toBe('warn')
    expect(quotaLevel(499, 1000, 500)).toBe('ok')
  })

  it('still warns at 90 % when the server sets its own threshold LATER', () => {
    // The trap: honouring only `warnLimit` would let a server that warns at 98 % break the promise
    // FR-QTA-01 makes to the user. Whichever fires first wins.
    expect(quotaLevel(900, 1000, 980)).toBe('warn')
  })

  it('is over at and above the hard limit', () => {
    expect(quotaLevel(1000, 1000, null)).toBe('over')
    expect(quotaLevel(1300, 1000, null)).toBe('over')
  })

  it('never divides by a zero (or negative) limit', () => {
    expect(quotaLevel(5, 0, null)).toBe('ok')
    expect(quotaLevel(5, -1, null)).toBe('ok')
  })
})

describe('pickPrimaryQuota', () => {
  it('prefers the account-scoped BYTE quota that counts Email', () => {
    const mail = quota({ id: 'mail', types: ['Email'] })
    const files = quota({ id: 'files', types: ['FileNode'] })
    expect(pickPrimaryQuota([files, mail])?.id).toBe('mail')
  })

  it('falls back to any account-scoped byte quota, then any byte quota', () => {
    const domain = quota({ id: 'dom', scope: 'domain', types: ['Email'] })
    const other = quota({ id: 'acct', types: ['FileNode'] })
    expect(pickPrimaryQuota([domain, other])?.id).toBe('acct')
    expect(pickPrimaryQuota([domain])?.id).toBe('dom')
  })

  it('ignores COUNT quotas — the chrome bar meters bytes', () => {
    expect(pickPrimaryQuota([quota({ resourceType: 'count' })])).toBeNull()
  })

  it('skips a hardLimit of 0 — a bar reading "0 of 0" is worse than no bar', () => {
    expect(pickPrimaryQuota([quota({ hardLimit: 0 })])).toBeNull()
  })

  it('is null for an empty list', () => {
    expect(pickPrimaryQuota([])).toBeNull()
  })
})

describe('toQuotaView', () => {
  it('clamps the BAR at 100 % while the numbers keep telling the truth', () => {
    const view = toQuotaView(quota({ used: 1300, hardLimit: 1000 }))
    expect(view.ratio).toBe(1)
    expect(view.used).toBe(1300)
    expect(view.level).toBe('over')
  })

  it('carries the raw numbers, not formatted strings', () => {
    const view = toQuotaView(quota({ used: 250 }))
    expect(view).toMatchObject({ used: 250, limit: 1000, ratio: 0.25, level: 'ok' })
  })
})
