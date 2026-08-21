/**
 * What a delegated account is ALLOWED to become in the app (S-4).
 *
 * The measurement this file defends, taken against the live Stalwart v0.16.18 fixture on
 * 2026-08-21: a share of one single object makes the whole owning account appear in the recipient's
 * session with **all seventeen** capabilities. Sharing a calendar advertises mail. Sharing an
 * address book advertises mail and files. The capability list cannot tell the areas apart, and
 * `secondaryMailAccounts()` — the strictest test the session offers — reads exactly that list.
 *
 * Two things were built on it and both were wrong: a mail section over a folder tree that could
 * never fill, and, invisibly, a whole SYNC ENGINE started for an account whose every `Mailbox/get`
 * answers `forbidden`. The engine is the reason this test sits here rather than beside the sidebar:
 * it reads `connected.accounts` and renders nothing, so no assertion about the rail could ever have
 * caught it.
 */

import type { MailAccount } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import type { AreaAccess } from '../../sharing/probe'
import { fleetAccounts } from '../../sync/engine/react'
import { delegatedAccountsFor, deriveDelegation, secondaryMailAccounts } from './accounts'
import type { ConnectedSession } from './types'

const ALICE: MailAccount = {
  id: 'b',
  name: 'alice@waxwing.test',
  isPersonal: true,
  isReadOnly: false,
}
/** Carol, as the session presents her: not personal, and advertising everything. */
const CAROL: MailAccount = {
  id: 'd',
  name: 'carol@waxwing.test',
  isPersonal: false,
  isReadOnly: false,
}

const access = (over: Partial<AreaAccess>): AreaAccess => ({
  mail: 'granted',
  contacts: 'granted',
  files: 'granted',
  ...over,
})

/** A ConnectedSession over a derivation — only the fields these selectors read are real. */
function session(derived: ReturnType<typeof deriveDelegation>, accountId = 'b'): ConnectedSession {
  return {
    accountId,
    username: 'alice@waxwing.test',
    accounts: derived.accounts,
    delegated: derived.delegated,
  } as unknown as ConnectedSession
}

describe('a shared account that only shares contacts', () => {
  // Exactly the measured state: alice shared ONE address book with carol. Read from carol's side,
  // alice's account serves `AddressBook/get` and refuses `Mailbox/get` and `FileNode/get`.
  const verdicts = new Map([['d', access({ mail: 'denied', files: 'denied' })]])
  const derived = deriveDelegation(ALICE, [CAROL], verdicts)

  it('THE ONE: full capabilities plus a forbidden AddressBook/get produces NO contacts section', () => {
    // The mirror of the case above, and the one the brief names: this time the address book is the
    // area the server refuses, and the contacts rail must list nothing.
    const denied = deriveDelegation(
      ALICE,
      [CAROL],
      new Map([['d', access({ contacts: 'denied' })]]),
    )
    expect(delegatedAccountsFor(session(denied), 'contacts')).toEqual([])
    // …while the areas the same account DOES serve are untouched. A rail-wide "hide the account"
    // would be the easy fix and the wrong one.
    expect(delegatedAccountsFor(session(denied), 'files').map((a) => a.id)).toEqual(['d'])
  })

  it('AND NO SYNC ENGINE STARTS FOR IT', () => {
    // `fleetAccounts` is what `SyncEngineHost` hands `startEngineFleet`; one entry per engine. The
    // account is shared, it is in the session, it advertises mail — and it is not here.
    expect(fleetAccounts(session(derived)).map((account) => account.id)).toEqual(['b'])
    expect(secondaryMailAccounts(session(derived))).toEqual([])
  })

  it('is still reachable in the area it really shares', () => {
    expect(delegatedAccountsFor(session(derived), 'contacts').map((a) => a.id)).toEqual(['d'])
    expect(delegatedAccountsFor(session(derived), 'files')).toEqual([])
  })
})

describe('deriveDelegation', () => {
  it('runs an engine for a shared account whose mail the server DOES serve', () => {
    const derived = deriveDelegation(ALICE, [CAROL], new Map([['d', access({})]]))
    expect(fleetAccounts(session(derived)).map((account) => account.id)).toEqual(['b', 'd'])
  })

  it('keeps everything when the probe never answered', () => {
    // Offline must not empty the app. A section that should not be there is recoverable on the next
    // connect; an account that vanished while the user was working in it is not.
    const derived = deriveDelegation(ALICE, [CAROL], new Map())
    expect(fleetAccounts(session(derived)).map((account) => account.id)).toEqual(['b', 'd'])
    expect(delegatedAccountsFor(session(derived), 'files').map((a) => a.id)).toEqual(['d'])
  })

  it('puts the user’s own account first and never in `delegated`', () => {
    // `accounts[0]` is load-bearing: the fleet reads it as the primary (the one with the notifier,
    // the real bus and the bare lock).
    const derived = deriveDelegation(ALICE, [ALICE, CAROL], new Map())
    expect(derived.accounts[0]?.id).toBe('b')
    expect(derived.delegated.map((a) => a.id)).toEqual(['d'])
  })

  it('is a plain pass-through when nothing is shared', () => {
    const derived = deriveDelegation(ALICE, [], new Map())
    expect(derived.accounts).toEqual([ALICE])
    expect(derived.delegated).toEqual([])
  })
})
