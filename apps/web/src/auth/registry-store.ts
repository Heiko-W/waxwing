/**
 * Persisting the account registry (M5.12, FR-AUTH-07).
 *
 * The registry lives in `localStorage`, deliberately, and it is the one piece of auth state that
 * does: it holds **no secrets**. A scope, an issuer, a username and a label — the same things the
 * sign-in screen would show anyway. The credentials themselves stay where ADR-004 put them, in
 * per-scope IndexedDB databases behind a non-extractable wrapping key.
 *
 * `localStorage` rather than IndexedDB because this is read once, synchronously, before the app
 * decides which account to restore. An async read there would mean a frame of "signed out" on
 * every start.
 */

import { type AccountRegistry, coerceRegistry, EMPTY_REGISTRY } from './account-registry'

export const REGISTRY_STORAGE_KEY = 'waxwing.accounts'

/** The storage surface, injectable for tests. */
export interface RegistryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultStorage(): RegistryStorage | null {
  try {
    return window.localStorage
  } catch {
    // A browser with storage blocked (Safari private mode, an embedded webview) is not a reason
    // to fail: the app runs, it just cannot remember accounts between visits.
    return null
  }
}

/**
 * Reads the registry. Returns the empty one for anything unreadable — a corrupted entry must not
 * be a reason the app cannot start.
 */
export function loadRegistry(storage: RegistryStorage | null = defaultStorage()): AccountRegistry {
  if (storage === null) return EMPTY_REGISTRY
  try {
    const raw = storage.getItem(REGISTRY_STORAGE_KEY)
    if (raw === null) return EMPTY_REGISTRY
    return coerceRegistry(JSON.parse(raw))
  } catch {
    return EMPTY_REGISTRY
  }
}

/**
 * Writes the registry.
 *
 * Failures are swallowed on purpose: a full quota or a blocked store means the app forgets which
 * accounts exist on the next visit, which is a degraded experience rather than a broken one — and
 * throwing here would break a sign-in that had otherwise succeeded.
 */
export function saveRegistry(
  registry: AccountRegistry,
  storage: RegistryStorage | null = defaultStorage(),
): void {
  if (storage === null) return
  try {
    storage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(registry))
  } catch {
    // Deliberately ignored — see above.
  }
}

/** Removes the registry entirely (a full sign-out of every account). */
export function clearRegistry(storage: RegistryStorage | null = defaultStorage()): void {
  if (storage === null) return
  try {
    storage.removeItem(REGISTRY_STORAGE_KEY)
  } catch {
    // Deliberately ignored.
  }
}
