/**
 * Removing one account (M5.10, FR-AUTH-07).
 *
 * The ordering assertion is the whole file: credentials before cached data, and no replica clear
 * at all if the credential wipe failed. Reporting a sign-out that did not happen is the failure
 * mode worth a test.
 */

import { describe, expect, it, vi } from 'vitest'
import { freshDb } from '../sync/test-utils'
import { forgetAccount } from './forget-account'
import type { SecretStore } from './secret-store'

/** A store whose wipe is observable, and optionally fails. */
function fakeStore(options: { fails?: boolean } = {}): { store: SecretStore; wiped: string[] } {
  const wiped: string[] = []
  const store = {
    async wipe() {
      if (options.fails === true) throw new Error('blocked')
      wiped.push('wiped')
    },
  } as unknown as SecretStore
  return { store, wiped }
}

describe('forgetAccount', () => {
  it('wipes the credentials and clears the account’s rows', async () => {
    const db = freshDb()
    try {
      await db.accounts.put({
        id: 'a',
        username: 'ada',
        name: null,
        issuer: null,
        isPrimary: true,
        addedAt: 0,
        lastSeenAt: 0,
      })
      const { store, wiped } = fakeStore()

      await forgetAccount({ scope: 's', accountId: 'a', db, store })

      expect(wiped).toEqual(['wiped'])
      expect(await db.accounts.get('a')).toBeUndefined()
    } finally {
      await db.delete()
    }
  })

  it('leaves ANOTHER account untouched', async () => {
    const db = freshDb()
    try {
      for (const id of ['a', 'b']) {
        await db.accounts.put({
          id,
          username: id,
          name: null,
          issuer: null,
          isPrimary: id === 'a',
          addedAt: 0,
          lastSeenAt: 0,
        })
      }
      await forgetAccount({ scope: 's', accountId: 'a', db, store: fakeStore().store })

      expect(await db.accounts.get('b')).toBeDefined()
    } finally {
      await db.delete()
    }
  })

  it('does NOT clear the replica when the credential wipe failed', async () => {
    // A blocked `deleteDatabase` means the refresh token is still on disk. Clearing the cache
    // anyway would hide the account while leaving the credentials readable by any later page on
    // this origin — a sign-out that looks complete and is not.
    const db = freshDb()
    try {
      await db.accounts.put({
        id: 'a',
        username: 'ada',
        name: null,
        issuer: null,
        isPrimary: true,
        addedAt: 0,
        lastSeenAt: 0,
      })
      const { store } = fakeStore({ fails: true })

      await expect(forgetAccount({ scope: 's', accountId: 'a', db, store })).rejects.toThrow(
        'blocked',
      )
      // Still there: the caller can retry, and the UI must not claim success.
      expect(await db.accounts.get('a')).toBeDefined()
    } finally {
      await db.delete()
    }
  })

  it('does not construct a real store when one is injected', async () => {
    // Guards the seam the other tests rely on: a real `SecretStore` would open IndexedDB.
    const db = freshDb()
    try {
      const spy = vi.fn()
      const store = { wipe: spy } as unknown as SecretStore
      await forgetAccount({ scope: 's', accountId: 'a', db, store })
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      await db.delete()
    }
  })
})
