/**
 * The account registry as React state (M5.14, FR-AUTH-07).
 *
 * A module-level store rather than context: the registry is read by the shell's account menu and
 * written by the sign-in flow, which sit on opposite sides of the auth gate. Threading a provider
 * between them would mean a context above `<App>`, which is exactly where the session provider
 * already is — and two providers disagreeing about who owns sign-in is worse than one store.
 *
 * The same shape `sync/engine`'s status store and `storage.ts` already use.
 */

import { useSyncExternalStore } from 'react'
import {
  type AccountRegistry,
  addAccount,
  type RegisteredAccount,
  removeAccount,
  setActiveAccount,
} from './account-registry'
import { loadRegistry, saveRegistry } from './registry-store'

let current: AccountRegistry = loadRegistry()
const listeners = new Set<() => void>()

function emit(next: AccountRegistry): void {
  current = next
  saveRegistry(next)
  for (const listener of listeners) listener()
}

/** Adopt `next` without persisting it — for a store that is already authoritative on disk. */
function adopt(next: AccountRegistry): void {
  current = next
  for (const listener of listeners) listener()
}

export function getAccountRegistry(): AccountRegistry {
  return current
}

/** Records a successful sign-in. Idempotent: the same mailbox updates its row rather than adding one. */
export function registerAccount(account: RegisteredAccount): void {
  emit(addAccount(current, account))
}

/** Forgets an account. The caller is responsible for wiping its data — see `forgetAccount`. */
export function unregisterAccount(scope: string): void {
  emit(removeAccount(current, scope))
}

export function switchAccount(scope: string): void {
  emit(setActiveAccount(current, scope))
}

/**
 * Re-reads from storage — for a tab that was not the one that signed in, and after a wipe.
 *
 * Adopts rather than emits, and the difference is load-bearing: `emit` persists, so re-reading an
 * EMPTY store used to write the empty registry straight back out. That re-created
 * `waxwing.accounts` moments after "Sign out and remove data" had deleted it — an empty value, but
 * a key, and "this origin still holds a Waxwing account list" is exactly the statement the wipe is
 * supposed to remove. Caught by the end-to-end assertion over the whole web storage, not by the
 * unit test, which never went through this store.
 */
export function reloadAccountRegistry(): void {
  adopt(loadRegistry())
}

export function useAccountRegistry(): AccountRegistry {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getAccountRegistry,
    // Server snapshot: this app has no SSR, but the parameter is required and returning the same
    // reference keeps it honest rather than hydrating against a fresh object.
    getAccountRegistry,
  )
}
