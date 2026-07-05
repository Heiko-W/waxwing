import { afterEach, describe, expect, it } from 'vitest'
import { SecretName, SecretStore } from './secret-store'
import { TokenStore } from './token-store'

const created: string[] = []
function freshStore(): SecretStore {
  const dbName = `waxwing-auth-${crypto.randomUUID()}`
  created.push(dbName)
  return new SecretStore({ dbName })
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name)
          request.onsuccess = () => resolve()
          request.onerror = () => resolve()
          request.onblocked = () => resolve()
        }),
    ),
  )
})

describe('TokenStore', () => {
  it('keeps the access token in memory and persists the refresh token (wrapped)', async () => {
    const secretStore = freshStore()
    const now = 1_000_000
    const tokens = new TokenStore(secretStore, { now: () => now })

    await tokens.apply({ accessToken: 'at-1', expiresAt: now + 3_600_000, refreshToken: 'rt-1' })

    expect(tokens.getAccessToken()).toBe('at-1')
    expect(tokens.getExpiresAt()).toBe(now + 3_600_000)
    // The refresh token is the only durable credential — and it is encrypted at rest.
    expect(await secretStore.get(SecretName.RefreshToken)).toBe('rt-1')
  })

  it('reports freshness against the skew window', async () => {
    const secretStore = freshStore()
    let clock = 0
    const tokens = new TokenStore(secretStore, { now: () => clock, skewMs: 60_000 })
    await tokens.apply({ accessToken: 'at', expiresAt: 100_000 })

    clock = 0
    expect(tokens.isFresh()).toBe(true)
    clock = 39_000 // 61s before expiry -> still fresh
    expect(tokens.isFresh()).toBe(true)
    clock = 41_000 // within the 60s skew of expiry -> stale
    expect(tokens.isFresh()).toBe(false)
  })

  it('offline start: a new TokenStore reads the persisted refresh token', async () => {
    const secretStore = freshStore()
    await new TokenStore(secretStore).apply({
      accessToken: 'at',
      expiresAt: Date.now() + 1000,
      refreshToken: 'rt-persist',
    })

    // Simulate a reload: the access token is gone (memory only) but the refresh token remains.
    const rebooted = new TokenStore(secretStore)
    expect(rebooted.getAccessToken()).toBeNull()
    expect(await rebooted.getRefreshToken()).toBe('rt-persist')
  })

  it('rotates the persisted refresh token when a new one is issued', async () => {
    const secretStore = freshStore()
    const tokens = new TokenStore(secretStore)
    await tokens.apply({ accessToken: 'a', expiresAt: 1, refreshToken: 'rt-old' })
    await tokens.apply({ accessToken: 'b', expiresAt: 2, refreshToken: 'rt-new' })
    expect(await secretStore.get(SecretName.RefreshToken)).toBe('rt-new')
  })

  it('clear() drops the access token and deletes the refresh token', async () => {
    const secretStore = freshStore()
    const tokens = new TokenStore(secretStore)
    await tokens.apply({ accessToken: 'a', expiresAt: Date.now() + 1000, refreshToken: 'rt' })
    await tokens.clear()
    expect(tokens.getAccessToken()).toBeNull()
    expect(await secretStore.get(SecretName.RefreshToken)).toBeNull()
  })
})
