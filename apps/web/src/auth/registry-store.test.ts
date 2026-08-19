/**
 * Persisting the account registry (M5.12, FR-AUTH-07).
 *
 * Every assertion is about a failure that must NOT take the app down: a corrupted entry, a storage
 * that is not there, a quota that is full. None of those is a reason a user cannot sign in.
 */

import { describe, expect, it } from 'vitest'
import { addAccount, EMPTY_REGISTRY, type RegisteredAccount } from './account-registry'
import {
  clearRegistry,
  loadRegistry,
  REGISTRY_STORAGE_KEY,
  type RegistryStorage,
  saveRegistry,
} from './registry-store'

const account: RegisteredAccount = {
  scope: '19:mail.example.test|3:ada',
  issuer: 'https://mail.example.test',
  username: 'ada',
  label: 'ada@example.test',
  addedAt: 1000,
}

/** An in-memory storage, optionally failing on write. */
function memoryStorage(options: { failWrites?: boolean } = {}): RegistryStorage & {
  readonly data: Map<string, string>
} {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (options.failWrites === true) throw new Error('QuotaExceededError')
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
}

describe('round trip', () => {
  it('saves and reads a registry back', () => {
    const storage = memoryStorage()
    const registry = addAccount(EMPTY_REGISTRY, account)

    saveRegistry(registry, storage)
    expect(loadRegistry(storage)).toEqual(registry)
  })

  it('stores no secrets — only what a sign-in screen would show anyway', () => {
    const storage = memoryStorage()
    saveRegistry(addAccount(EMPTY_REGISTRY, account), storage)

    const raw = storage.data.get(REGISTRY_STORAGE_KEY) ?? ''
    // The credentials live in per-scope IndexedDB behind a non-extractable key (ADR-004); this
    // entry must never grow a token, a password or a key.
    expect(raw).not.toMatch(/token|password|secret|refresh/i)
    expect(raw).toContain('ada')
  })
})

describe('failures that must not break the app', () => {
  it('is empty when nothing was ever stored', () => {
    expect(loadRegistry(memoryStorage())).toEqual(EMPTY_REGISTRY)
  })

  it('is empty for a corrupted entry rather than throwing', () => {
    const storage = memoryStorage()
    storage.data.set(REGISTRY_STORAGE_KEY, '{not json')
    expect(loadRegistry(storage)).toEqual(EMPTY_REGISTRY)
  })

  it('is empty for a well-formed entry of the wrong shape', () => {
    const storage = memoryStorage()
    storage.data.set(REGISTRY_STORAGE_KEY, '[1,2,3]')
    expect(loadRegistry(storage)).toEqual(EMPTY_REGISTRY)
  })

  it('is empty where there is no storage at all', () => {
    // Safari private mode and some embedded webviews. The app runs; it just cannot remember.
    expect(loadRegistry(null)).toEqual(EMPTY_REGISTRY)
  })

  it('SWALLOWS a write failure rather than breaking a sign-in that succeeded', () => {
    // A full quota means the app forgets accounts next visit — degraded, not broken. Throwing
    // here would fail an authentication that had otherwise gone through.
    const storage = memoryStorage({ failWrites: true })
    expect(() => saveRegistry(addAccount(EMPTY_REGISTRY, account), storage)).not.toThrow()
  })

  it('tolerates a missing storage on write and clear', () => {
    expect(() => saveRegistry(EMPTY_REGISTRY, null)).not.toThrow()
    expect(() => clearRegistry(null)).not.toThrow()
  })
})

describe('clearRegistry', () => {
  it('removes the entry', () => {
    const storage = memoryStorage()
    saveRegistry(addAccount(EMPTY_REGISTRY, account), storage)
    clearRegistry(storage)
    expect(storage.data.has(REGISTRY_STORAGE_KEY)).toBe(false)
    expect(loadRegistry(storage)).toEqual(EMPTY_REGISTRY)
  })
})
