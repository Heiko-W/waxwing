/**
 * Full local-data wipe for "Sign out & remove data" (FR-AUTH-05): Cache Storage, every
 * IndexedDB database, and service-worker registrations for this origin. Each step is
 * feature-detected and best-effort (`allSettled`) so one unsupported/blocked API never
 * aborts the rest of the wipe.
 */

/** The browser surfaces the wipe touches; injectable so tests can supply fakes. */
export interface WipeEnvironment {
  caches?: CacheStorage | undefined
  indexedDB?: IDBFactory | undefined
  serviceWorker?: ServiceWorkerContainer | undefined
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

export async function wipeLocalData(env: WipeEnvironment): Promise<void> {
  await Promise.allSettled([
    clearCaches(env.caches),
    clearIndexedDatabases(env.indexedDB),
    clearServiceWorkers(env.serviceWorker),
  ])
}
