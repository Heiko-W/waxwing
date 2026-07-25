import type { MailAccount } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { secondaryMailAccounts } from './accounts'
import type { ConnectedSession } from './types'

const OWN: MailAccount = {
  id: 'acc-1',
  name: 'alice@waxwing.test',
  isPersonal: true,
  isReadOnly: false,
}
const SHARED: MailAccount = {
  id: 'shared-1',
  name: 'team@waxwing.test',
  isPersonal: false,
  isReadOnly: true,
}

/** A ConnectedSession stub carrying only what the selector reads. */
function connected(accounts: readonly MailAccount[]): ConnectedSession {
  return { accountId: 'acc-1', accounts } as unknown as ConnectedSession
}

describe('secondaryMailAccounts (connected selector, M4.4)', () => {
  it('returns [] when only the own account is present', () => {
    expect(secondaryMailAccounts(connected([OWN]))).toEqual([])
  })

  it('returns the delegated accounts with the own account excluded', () => {
    expect(secondaryMailAccounts(connected([OWN, SHARED]))).toEqual([SHARED])
  })
})
