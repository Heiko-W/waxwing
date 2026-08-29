/**
 * Full local-data wipe for "Sign out & remove data" (FR-AUTH-05): Cache Storage, every
 * IndexedDB database, service-worker registrations for this origin, and the two web storages.
 * Each step is feature-detected and best-effort (`allSettled`) so one unsupported/blocked API
 * never aborts the rest of the wipe.
 */

import { EPHEMERAL_INDEX_KEY } from '../sync/ephemeral'

/** The browser surfaces the wipe touches; injectable so tests can supply fakes. */
export interface WipeEnvironment {
  caches?: CacheStorage | undefined
  indexedDB?: IDBFactory | undefined
  serviceWorker?: ServiceWorkerContainer | undefined
  localStorage?: Storage | undefined
  sessionStorage?: Storage | undefined
}

function deleteDatabase(idb: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = idb.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

async function clearCaches(cacheStorage: CacheStorage | undefined): Promise<void> {
  if (!cacheStorage) return
  const keys = await cacheStorage.keys()
  await Promise.allSettled(keys.map((key) => cacheStorage.delete(key)))
}

async function clearIndexedDatabases(idb: IDBFactory | undefined): Promise<void> {
  // `databases()` is unavailable on Firefox; there is no enumeration fallback, so on those
  // engines the app's known databases are dropped individually by their own owners instead.
  if (!idb || typeof idb.databases !== 'function') return
  const databases = await idb.databases()
  await Promise.allSettled(
    databases.map((info) => (info.name ? deleteDatabase(idb, info.name) : Promise.resolve())),
  )
}

async function clearServiceWorkers(container: ServiceWorkerContainer | undefined): Promise<void> {
  if (!container || typeof container.getRegistrations !== 'function') return
  const registrations = await container.getRegistrations()
  await Promise.allSettled(registrations.map((registration) => registration.unregister()))
}

/**
 * The web storages, by name-blind `clear()` — the same call the U2 reset path makes.
 *
 * This step was missing, and what it left behind was not settings but IDENTITY: the account
 * registry (`waxwing.accounts`) holds the mailbox address and server origin of everyone who has
 * signed in on this browser, no production path has ever removed a row, and the account menu
 * offers them to the NEXT person as "switch to alice@example.com". The dialog promises "mail and
 * settings", the sign-in screen promises to keep no sign-in on this device, and public-computer
 * mode promises that leaving does not depend on picking the right menu item on the way out.
 *
 * Name-blind rather than a list of keys: a list goes stale the first time a feature adds one, and
 * this app owns its origin (root-scoped service worker, static deployment).
 *
 * ONE key survives, and it is not user data: `waxwing.ephemeralDbs` is the index of throwaway
 * replicas still awaiting a sweep. Firefox has no `indexedDB.databases()`, so on that engine the
 * loop above cannot enumerate them and this index is the only remaining way to find them — losing
 * it would strand exactly the databases a public-computer session created.
 */
function clearWebStorage(storage: Storage | undefined, keep: readonly string[]): void {
  if (!storage) return
  try {
    const preserved = keep.map((key) => [key, storage.getItem(key)] as const)
    storage.clear()
    for (const [key, value] of preserved) if (value !== null) storage.setItem(key, value)
  } catch {
    // Private mode / storage disabled: nothing was stored, nothing to clear.
  }
}

export async function wipeLocalData(env: WipeEnvironment): Promise<void> {
  await Promise.allSettled([
    clearCaches(env.caches),
    clearIndexedDatabases(env.indexedDB),
    clearServiceWorkers(env.serviceWorker),
  ])
  // After the databases, not alongside them: the sweep index above is only worth keeping once the
  // enumerating wipe has had its turn.
  clearWebStorage(env.localStorage, [EPHEMERAL_INDEX_KEY])
  clearWebStorage(env.sessionStorage, [])
}
