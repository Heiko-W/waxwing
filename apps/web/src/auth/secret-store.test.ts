import { afterEach, describe, expect, it } from 'vitest'
import { SecretName, SecretStore } from './secret-store'

// Each case gets an isolated fake-indexeddb database so state never leaks between tests.
const created: string[] = []
function uniqueStore(): { store: SecretStore; dbName: string } {
  const dbName = `waxwing-auth-${crypto.randomUUID()}`
  created.push(dbName)
  return { store: new SecretStore({ dbName }), dbName }
}

function openRaw(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function readRaw<T>(db: IDBDatabase, storeName: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
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

describe('SecretStore', () => {
  it('round-trips a refresh token: value in -> ciphertext at rest -> value out', async () => {
    const { store } = uniqueStore()
    const token = 'sw1.a-refresh-token-value'
    await store.put(SecretName.RefreshToken, token)
    expect(await store.get(SecretName.RefreshToken)).toBe(token)
  })

  it('stores the secret encrypted at rest (never the plaintext bytes)', async () => {
    const { store, dbName } = uniqueStore()
    const token = 'sw1.super-secret-refresh-token'
    await store.put(SecretName.RefreshToken, token)

    const db = await openRaw(dbName)
    const record = await readRaw<{ iv: ArrayBufferView; data: ArrayBufferView }>(
      db,
      'secrets',
      SecretName.RefreshToken,
    )
    db.close()
    expect(record).toBeDefined()
    const decoded = new TextDecoder().decode(record?.data)
    // The ciphertext must not contain the plaintext, and must not be trivially equal to it.
    expect(decoded).not.toContain('refresh-token')
    expect(decoded).not.toBe(token)
    // AES-GCM uses a 96-bit (12-byte) nonce; assert realm-agnostically.
    expect(ArrayBuffer.isView(record?.iv)).toBe(true)
    expect(record?.iv.byteLength).toBe(12)
  })

  it('persists the wrapping key as a NON-EXTRACTABLE CryptoKey', async () => {
    const { store, dbName } = uniqueStore()
    // Force the key to be generated + persisted.
    await store.put(SecretName.RefreshToken, 'x')

    const db = await openRaw(dbName)
    const key = await readRaw<CryptoKey>(db, 'keys', 'wrap')
    db.close()
    expect(key).toBeDefined()
    expect(key?.extractable).toBe(false)
    expect(key?.algorithm.name).toBe('AES-GCM')
    // The raw key bytes can never be exported by script — the whole point of NFR-SEC-02.
    await expect(crypto.subtle.exportKey('raw', key as CryptoKey)).rejects.toThrow()
  })

  it('reuses the same wrapping key across store instances on the same database', async () => {
    const { store, dbName } = uniqueStore()
    await store.put(SecretName.RefreshToken, 'sw1.persisted')
    // A fresh instance (e.g. after reload) must decrypt what the first one wrote.
    const reopened = new SecretStore({ dbName })
    expect(await reopened.get(SecretName.RefreshToken)).toBe('sw1.persisted')
  })

  it('returns null for an absent secret and after delete', async () => {
    const { store } = uniqueStore()
    expect(await store.get(SecretName.BasicCredentials)).toBeNull()
    await store.put(SecretName.BasicCredentials, '{"username":"a"}')
    expect(await store.get(SecretName.BasicCredentials)).toBe('{"username":"a"}')
    await store.delete(SecretName.BasicCredentials)
    expect(await store.get(SecretName.BasicCredentials)).toBeNull()
  })

  it('wipe() destroys the persisted secret and leaves the store usable', async () => {
    const { store } = uniqueStore()
    await store.put(SecretName.RefreshToken, 'sw1.gone')
    await store.wipe()
    // Data is gone; the store self-heals (new database + fresh wrapping key) for reuse.
    expect(await store.get(SecretName.RefreshToken)).toBeNull()
    await store.put(SecretName.RefreshToken, 'sw1.new')
    expect(await store.get(SecretName.RefreshToken)).toBe('sw1.new')
  })
})
