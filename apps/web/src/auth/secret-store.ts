/**
 * Encrypted-at-rest secret store (NFR-SEC-02, tech-stack §4.7).
 *
 * Secrets that must survive a reload or a full-page OAuth redirect — the refresh token,
 * optionally-persisted Basic credentials, the in-flight PKCE transaction — are wrapped with
 * AES-GCM under a **non-extractable** {@link CryptoKey} and stored in IndexedDB. The wrapping
 * key itself lives in IndexedDB too, but as a non-extractable `CryptoKey`: it is
 * structured-cloned in and out and can be *used* to encrypt/decrypt, yet its raw bytes can
 * never be exported by script. That raises the bar for token exfiltration even if an
 * attacker gets script execution; the honest primary defense against XSS remains the strict
 * CSP (NFR-SEC-01, threat model NFR-SEC-04).
 *
 * Nothing here ever touches `localStorage`/`sessionStorage` (NFR-SEC-02).
 */

import { SecretStoreBlockedError } from './errors'

/** IndexedDB database + object-store names. Namespaced so the wipe is precise. */
const DB_NAME = 'waxwing-auth'
const DB_VERSION = 1

/**
 * Per-account database name (FR-AUTH-07). The auth persistence layer is account-scoped from
 * day one: the default (first) account lives in the base `waxwing-auth` database, and a
 * named account gets its own `waxwing-auth-<scope>` database with an independent wrapping
 * key and its own {@link SecretName} set. A second account is therefore purely additive —
 * it never collides on the database name or the secret keys, and per-account logout is just
 * a `deleteDatabase` of that scope — so multi-account needs no rename or migration later.
 * (V1 ships single sign-in and passes no scope; see docs/adr/004.)
 */
function scopedDbName(scope: string | undefined): string {
  return scope ? `${DB_NAME}-${scope}` : DB_NAME
}
const KEY_STORE = 'keys'
const SECRET_STORE = 'secrets'
const WRAP_KEY_ID = 'wrap'

/** Stable identifiers for the individual secrets kept in the store. */
export const SecretName = {
  /** OAuth refresh token (rotated in place when the server issues a new one). */
  RefreshToken: 'oauth.refreshToken',
  /** Serialized {@link BasicCredentials} — only when the user opted into "stay signed in". */
  BasicCredentials: 'basic.credentials',
  /** In-flight PKCE transaction, single-use, deleted after the redirect is consumed. */
  PkceTransaction: 'oauth.pkce',
  /** Small record describing the persisted session so it can be restored on cold boot. */
  AuthRecord: 'auth.record',
} as const

export type SecretName = (typeof SecretName)[keyof typeof SecretName]

/** The structured-cloneable shape stored per secret: a random IV plus the ciphertext. */
interface WrappedSecret {
  iv: Uint8Array<ArrayBuffer>
  data: Uint8Array<ArrayBuffer>
}

/** Injectable environment, so unit tests can supply WebCrypto/IndexedDB and isolate the DB. */
export interface SecretStoreOptions {
  crypto?: Crypto
  indexedDB?: IDBFactory
  /** Override the database name (tests use a unique name per case for isolation). */
  dbName?: string
  /**
   * Account scope (FR-AUTH-07). Namespaces the backing database so multiple accounts never
   * collide; omit for the single default account. Ignored when {@link dbName} is set (an
   * explicit name already isolates the store).
   */
  scope?: string
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * A tiny promise wrapper over IndexedDB that keeps a single lazily-opened connection and
 * exposes wrap/unwrap of string secrets. Deliberately dependency-free (Dexie arrives in
 * M1.2) to keep the auth module — and the initial bundle — lean.
 */
export class SecretStore {
  private readonly crypto: Crypto
  private readonly idb: IDBFactory
  private readonly dbName: string
  private dbPromise: Promise<IDBDatabase> | null = null
  private keyPromise: Promise<CryptoKey> | null = null

  constructor(options: SecretStoreOptions = {}) {
    this.crypto = options.crypto ?? globalThis.crypto
    this.idb = options.indexedDB ?? globalThis.indexedDB
    this.dbName = options.dbName ?? scopedDbName(options.scope)
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise
    this.dbPromise = new Promise((resolve, reject) => {
      const request = this.idb.open(this.dbName, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE)
        if (!db.objectStoreNames.contains(SECRET_STORE)) db.createObjectStore(SECRET_STORE)
      }
      request.onsuccess = () => {
        const db = request.result
        // ANOTHER TAB IS TRYING TO DELETE THIS DATABASE — get out of its way.
        //
        // This connection is memoized for the lifetime of the page and every tab opens it at boot
        // (`restore()` reads the AuthRecord). Without this handler, a sign-out in tab A fires
        // `deleteDatabase`, tab B's live connection BLOCKS it, and `wipe()` below used to treat
        // `blocked` as success — so the ciphertext AND the still-usable wrapping key survived a
        // sign-out the UI had already confirmed. The next cold start then found the AuthRecord and
        // signed the next person at that machine in as the previous user. Closing here is what makes
        // the delete actually complete; `wipe()` reporting `blocked` as an error is the second half.
        db.onversionchange = () => {
          db.close()
          this.dbPromise = null
          this.keyPromise = null
        }
        resolve(db)
      }
      request.onerror = () => reject(request.error)
    })
    return this.dbPromise
  }

  /** Get-or-create the non-extractable AES-GCM wrapping key, memoized for the instance. */
  private wrappingKey(): Promise<CryptoKey> {
    if (this.keyPromise) return this.keyPromise
    this.keyPromise = (async () => {
      const db = await this.openDb()
      const existing = await requestToPromise(
        db.transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE).get(WRAP_KEY_ID),
      )
      if (existing) return existing as CryptoKey
      const key = await this.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ])
      const tx = db.transaction(KEY_STORE, 'readwrite')
      tx.objectStore(KEY_STORE).put(key, WRAP_KEY_ID)
      await this.txDone(tx)
      return key
    })()
    return this.keyPromise
  }

  private txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }

  /** Encrypts `value` under the wrapping key and stores it at `name`. */
  async put(name: SecretName, value: string): Promise<void> {
    const key = await this.wrappingKey()
    const iv = this.crypto.getRandomValues(new Uint8Array(12))
    const encoded = new TextEncoder().encode(value)
    const cipher = await this.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
    const record: WrappedSecret = { iv, data: new Uint8Array(cipher) }
    const db = await this.openDb()
    const tx = db.transaction(SECRET_STORE, 'readwrite')
    tx.objectStore(SECRET_STORE).put(record, name)
    await this.txDone(tx)
  }

  /** Returns the decrypted secret at `name`, or `null` if it is absent. */
  async get(name: SecretName): Promise<string | null> {
    const db = await this.openDb()
    const record = (await requestToPromise(
      db.transaction(SECRET_STORE, 'readonly').objectStore(SECRET_STORE).get(name),
    )) as WrappedSecret | undefined
    if (!record) return null
    const key = await this.wrappingKey()
    const plain = await this.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv },
      key,
      record.data,
    )
    return new TextDecoder().decode(plain)
  }

  /** Removes a single secret; a no-op if it does not exist. */
  async delete(name: SecretName): Promise<void> {
    const db = await this.openDb()
    const tx = db.transaction(SECRET_STORE, 'readwrite')
    tx.objectStore(SECRET_STORE).delete(name)
    await this.txDone(tx)
  }

  /**
   * Destroys the entire auth database — every secret and the wrapping key itself. Part of
   * the FR-AUTH-05 logout primitive: after this, nothing decryptable remains at rest.
   *
   * Rejects with {@link SecretStoreBlockedError} when another connection prevented the delete.
   * That case used to resolve silently, on the reasoning that "the secrets are already unreachable
   * once this tab drops its key reference" — which is false. The reference is not what protects
   * them: the ciphertext and the (non-extractable but perfectly usable) wrapping key both stay in
   * IndexedDB, and any later page on this origin can decrypt with them. A blocked delete is a
   * FAILED sign-out and the caller has to be able to say so.
   */
  async wipe(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise
      db.close()
    }
    this.dbPromise = null
    this.keyPromise = null
    await new Promise<void>((resolve, reject) => {
      const request = this.idb.deleteDatabase(this.dbName)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      // Other tabs close on `versionchange` (see openDb), so this is now the genuinely stuck case:
      // a frozen/bfcached page that never ran its handler. Surface it instead of pretending.
      request.onblocked = () => reject(new SecretStoreBlockedError(this.dbName))
    })
  }
}
