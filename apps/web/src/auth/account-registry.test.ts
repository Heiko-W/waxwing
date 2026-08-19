/**
 * The signed-in account registry (M5.10, FR-AUTH-07).
 *
 * Two properties carry this file, and both are security-relevant rather than cosmetic: a scope has
 * to be STABLE for a given mailbox (or re-signing in duplicates the account and its stored
 * credentials), and two different accounts must never derive the SAME scope (or one could read the
 * other's refresh token out of a shared database).
 */

import { describe, expect, it } from 'vitest'
import {
  activeAccount,
  addAccount,
  coerceRegistry,
  deriveScope,
  EMPTY_REGISTRY,
  hasAccount,
  MAX_ACCOUNTS,
  type RegisteredAccount,
  removeAccount,
  setActiveAccount,
} from './account-registry'

const account = (over: Partial<RegisteredAccount> = {}): RegisteredAccount => ({
  scope: 'mail.example.test|ada',
  issuer: 'https://mail.example.test',
  username: 'ada',
  label: 'ada@example.test',
  addedAt: 1000,
  ...over,
})

describe('deriveScope', () => {
  it('is stable for the same mailbox', () => {
    // Signing in again has to find the SAME storage scope, or the user accumulates duplicate
    // entries each holding a separate copy of their credentials.
    expect(deriveScope('https://mail.example.test', 'ada')).toBe(
      deriveScope('https://mail.example.test', 'ada'),
    )
  })

  it('ignores case and surrounding whitespace in the username', () => {
    expect(deriveScope('https://x.test', '  Ada  ')).toBe(deriveScope('https://x.test', 'ada'))
  })

  it('separates two accounts on the same server', () => {
    expect(deriveScope('https://x.test', 'ada')).not.toBe(deriveScope('https://x.test', 'grace'))
  })

  it('separates the same username on two servers', () => {
    expect(deriveScope('https://a.test', 'ada')).not.toBe(deriveScope('https://b.test', 'ada'))
  })

  it('cannot be made to collide by moving the separator', () => {
    // ("https://a|b", "c") and ("https://a", "b|c") must not land on one scope — a collision would
    // let one account read the other's stored refresh token.
    expect(deriveScope('https://a|b', 'c')).not.toBe(deriveScope('https://a', 'b|c'))
  })

  it('produces a bounded, database-safe name', () => {
    const scope = deriveScope('https://very.long.example.test'.repeat(20), 'x'.repeat(200))
    expect(scope.length).toBeLessThanOrEqual(96)
    // `:` belongs to the length-prefix encoding that makes the scope collision-free; the rest is
    // the conservative set an IndexedDB name is safe with.
    expect(scope).toMatch(/^[a-z0-9@._|:-]+$/)
  })

  it('has a scope for a Basic sign-in with no issuer', () => {
    expect(deriveScope(null, 'ada')).not.toBe('')
  })
})

describe('addAccount', () => {
  it('adds and activates', () => {
    const registry = addAccount(EMPTY_REGISTRY, account())
    expect(registry.accounts).toHaveLength(1)
    expect(registry.activeScope).toBe(account().scope)
  })

  it('UPDATES rather than duplicating when the scope is already known', () => {
    const first = addAccount(EMPTY_REGISTRY, account())
    const second = addAccount(first, account({ label: 'Ada Lovelace', addedAt: 9999 }))
    expect(second.accounts).toHaveLength(1)
    expect(second.accounts[0]?.label).toBe('Ada Lovelace')
    // The original `addedAt` survives: a re-authentication is not a new account.
    expect(second.accounts[0]?.addedAt).toBe(1000)
  })

  it('refuses beyond the cap rather than evicting somebody', () => {
    let registry = EMPTY_REGISTRY
    for (let index = 0; index < MAX_ACCOUNTS; index += 1) {
      registry = addAccount(registry, account({ scope: `s${index}` }))
    }
    const full = addAccount(registry, account({ scope: 'one-too-many' }))
    expect(full.accounts).toHaveLength(MAX_ACCOUNTS)
    expect(hasAccount(full, 'one-too-many')).toBe(false)
  })
})

describe('removeAccount', () => {
  it('picks a successor when the ACTIVE account goes', () => {
    // Leaving `activeScope` on a removed account strands the app with a session it cannot restore.
    let registry = addAccount(EMPTY_REGISTRY, account({ scope: 'a' }))
    registry = addAccount(registry, account({ scope: 'b' }))
    const after = removeAccount(registry, 'b')
    expect(after.activeScope).toBe('a')
  })

  it('leaves the active account alone when another one goes', () => {
    let registry = addAccount(EMPTY_REGISTRY, account({ scope: 'a' }))
    registry = addAccount(registry, account({ scope: 'b' }))
    expect(removeAccount(registry, 'a').activeScope).toBe('b')
  })

  it('is the signed-out state when the last one goes', () => {
    const registry = addAccount(EMPTY_REGISTRY, account({ scope: 'a' }))
    expect(removeAccount(registry, 'a')).toEqual({ accounts: [], activeScope: null })
  })
})

describe('setActiveAccount', () => {
  it('switches to a registered account', () => {
    let registry = addAccount(EMPTY_REGISTRY, account({ scope: 'a' }))
    registry = addAccount(registry, account({ scope: 'b' }))
    expect(setActiveAccount(registry, 'a').activeScope).toBe('a')
  })

  it('IGNORES a scope that is not registered', () => {
    // Trusting it would send the app looking for credentials in a database that does not exist.
    const registry = addAccount(EMPTY_REGISTRY, account({ scope: 'a' }))
    expect(setActiveAccount(registry, 'ghost').activeScope).toBe('a')
  })
})

describe('coerceRegistry', () => {
  it('reads a well-formed registry', () => {
    const registry = { accounts: [account()], activeScope: account().scope }
    expect(coerceRegistry(registry)).toEqual(registry)
  })

  it('is empty for anything that is not a registry', () => {
    for (const value of [null, undefined, [], 'x', 3]) {
      expect(coerceRegistry(value)).toEqual(EMPTY_REGISTRY)
    }
  })

  it('drops an activeScope naming an account that is not there', () => {
    const coerced = coerceRegistry({ accounts: [account({ scope: 'a' })], activeScope: 'ghost' })
    expect(coerced.activeScope).toBe('a')
  })

  it('skips malformed entries instead of throwing', () => {
    const coerced = coerceRegistry({
      accounts: [{ scope: '' }, { username: 'no-scope' }, account()],
      activeScope: null,
    })
    expect(coerced.accounts).toHaveLength(1)
  })

  it('falls back to the username when an entry has no label', () => {
    const coerced = coerceRegistry({ accounts: [{ scope: 's', username: 'ada' }] })
    expect(coerced.accounts[0]?.label).toBe('ada')
  })
})

describe('activeAccount', () => {
  it('resolves the active entry', () => {
    const registry = addAccount(EMPTY_REGISTRY, account())
    expect(activeAccount(registry)?.username).toBe('ada')
  })

  it('is null when signed out', () => {
    expect(activeAccount(EMPTY_REGISTRY)).toBeNull()
  })
})
