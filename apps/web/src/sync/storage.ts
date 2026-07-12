/**
 * The StorageManager seam (M3.4, FR-OFF-04) — the ONLY module that touches `navigator.storage`, and
 * the only one that knows what a `QuotaExceededError` looks like. Zero Dexie dependencies and fully
 * injectable ({@link EstimateFn}), so every consumer stays hermetically testable: fake-indexeddb has
 * no StorageManager at all, and a real one is quantized and unavailable in jsdom.
 *
 * ## Why `estimate()` is NOT the eviction budget
 * `navigator.storage.estimate()` is deliberately coarse: padded/quantized against fingerprinting,
 * ORIGIN-wide (it counts the service-worker precache, the `waxwing-auth` database, IndexedDB's own
 * overhead — everything), and it returns ONE number with no attribution. We use it for exactly two
 * things: the total/quota line + meter in Settings, and a PRESSURE trigger (`usage / quota >
 * PRESSURE_RATIO`). The eviction budget is our own key-only sum of the stored `bytes` — deterministic,
 * attributable, testable.
 */

export interface StorageEstimateLike {
  readonly usage: number
  readonly quota: number
}

/** How the engine and the UI read origin storage. Injected everywhere; {@link browserEstimate} is the default. */
export type EstimateFn = () => Promise<StorageEstimateLike | null>

/** `navigator.storage.estimate()`, or `null` when unsupported / it throws / it reports nothing. */
export const browserEstimate: EstimateFn = async () => {
  try {
    const storage = globalThis.navigator?.storage
    if (typeof storage?.estimate !== 'function') return null
    const estimate = await storage.estimate()
    const usage = estimate.usage
    const quota = estimate.quota
    if (typeof usage !== 'number' || typeof quota !== 'number' || quota <= 0) return null
    return { usage, quota }
  } catch {
    return null
  }
}

/** `navigator.storage.persisted()`; `null` when the StorageManager is unsupported. */
export async function isPersisted(): Promise<boolean | null> {
  try {
    const storage = globalThis.navigator?.storage
    if (typeof storage?.persisted !== 'function') return null
    return await storage.persisted()
  } catch {
    return null
  }
}

/**
 * `navigator.storage.persist()` — asks the browser to exempt this origin from eviction under storage
 * pressure. It MAY PROMPT (Firefox shows a permission bar), so it must only ever be called from a
 * user gesture or the `appinstalled` event — NEVER on first paint. A denial is final for the session:
 * do not auto-retry.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    const storage = globalThis.navigator?.storage
    if (typeof storage?.persist !== 'function') return false
    return await storage.persist()
  } catch {
    return false
  }
}

/**
 * True for a `QuotaExceededError` from any layer: a DOM `DOMException` (`name`, or the legacy
 * `code === 22`), or a Dexie error wrapping one in `inner` — a Dexie transaction reports the abort
 * as its own error object, so checking `name` alone misses every quota failure that happens inside a
 * `rw` transaction (which is all of ours).
 */
export function isQuotaExceeded(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as {
    name?: unknown
    code?: unknown
    inner?: unknown
  }
  if (candidate.name === 'QuotaExceededError') return true
  if (candidate.code === 22) return true
  return candidate.inner !== undefined && isQuotaExceeded(candidate.inner)
}

// ---------------------------------------------------------------------------------------------
// "Storage is full" signal.
//
// A cache write is BEST-EFFORT: it must never fail a read (the message still has to open). But the
// user has to learn that mail is no longer being kept offline, so the failing writer reports it here
// and a single notifier hook in the shell turns it into one toast. A module-level observable (the
// `setActiveEngine` precedent) rather than an EngineStatus field: it is a transient event, not part
// of the cross-tab status the leader broadcasts.
// ---------------------------------------------------------------------------------------------

let storageFullAt = 0
const storageFullListeners = new Set<() => void>()

/** Record that a cache write was rejected for lack of space (after recovery already failed). */
export function reportStorageFull(now: number = Date.now()): void {
  storageFullAt = now
  for (const listener of storageFullListeners) listener()
}

/** Epoch ms of the last {@link reportStorageFull}; `0` when it has never happened. */
export function getStorageFullAt(): number {
  return storageFullAt
}

export function subscribeStorageFull(listener: () => void): () => void {
  storageFullListeners.add(listener)
  return () => {
    storageFullListeners.delete(listener)
  }
}

/** Test seam: forget any recorded "storage full" event. */
export function resetStorageFull(): void {
  storageFullAt = 0
}
