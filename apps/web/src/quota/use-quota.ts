/**
 * The quota store (M3.7, FR-QTA-01): ONE fetch, ONE cached result, shared by the sidebar bar, the
 * settings panel and the warning notifier.
 *
 * A module-scoped store with subscribers (the `sync/engine/status.ts` idiom), not per-hook state.
 * That distinction is the whole point and is easy to get subtly wrong: a TTL guard around a
 * per-component `useState` gives the FIRST consumer the data and every later one `null`, because the
 * others skip the fetch on the TTL and have nothing of their own to show. The bar would render and
 * the notifier would stay silent — or the other way round, depending on mount order.
 *
 * **Quota is deliberately NOT a watched push type.** Adding `Quota` to the engine's `WATCHED_TYPES`
 * would look tidy and would be a mistake: every `StateChange` there drives a full delta sync pass, so
 * a quota tick — which happens on every single delivery — would kick a mailbox/thread/email sync. A
 * TTL plus explicit invalidation after the two events that actually move the needle (a send or a save
 * the server refused for `overQuota`) costs one request every few minutes and nothing else.
 */

import type { Quota } from '@waxwing/jmap'
import { useEffect, useSyncExternalStore } from 'react'
import { useSessionOptional } from '../app/session/context'
import { useEngineStatus } from '../sync/engine'
import { makeQuotaClient, type QuotaClient, serverSupportsQuota } from './quota-client'

export const QUOTA_TTL_MS = 5 * 60_000

let quotas: readonly Quota[] | null = null
let fetchedAt = 0
let inFlight = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const snapshot = (): readonly Quota[] | null => quotas

/** Force the next read to re-fetch — the numbers just stopped being true. */
export function invalidateQuota(): void {
  fetchedAt = 0
}

/** Test seam: forget everything, so a module-scoped cache cannot leak between tests. */
export function resetQuotaStore(): void {
  quotas = null
  fetchedAt = 0
  inFlight = false
  listeners.clear()
}

async function refresh(client: QuotaClient, now: number): Promise<void> {
  if (inFlight || now - fetchedAt < QUOTA_TTL_MS) return
  inFlight = true
  fetchedAt = now
  try {
    quotas = await client.list()
  } catch {
    // A failed quota read is never an error the user sees: it is a courtesy number. Drop it and let
    // the next window try again rather than pin a value we can no longer vouch for.
    quotas = null
    fetchedAt = 0
  } finally {
    inFlight = false
    emit()
  }
}

export interface UseQuotaOptions {
  /** Injected in tests; defaults to a client built from the live session. */
  readonly client?: QuotaClient
}

/**
 * The account's quotas, or `null` when there is nothing honest to show: the server offers no quota
 * capability, we are not connected, or the fetch failed. The caller renders nothing — a stale or
 * invented number in a storage meter is worse than no meter.
 */
export function useQuota(options: UseQuotaOptions = {}): readonly Quota[] | null {
  const connected = useSessionOptional()
  const status = useEngineStatus()
  const value = useSyncExternalStore(subscribe, snapshot, () => null)

  const injected = options.client
  const supported =
    injected !== undefined ||
    serverSupportsQuota(connected?.jmapSession ?? null, connected?.accountId ?? null)

  // Refresh on mount and after a sync pass, throttled by the TTL. `lastSyncedAt` is the cheapest
  // "something changed on the server" signal we already have.
  const syncedAt = status.lastSyncedAt
  // biome-ignore lint/correctness/useExhaustiveDependencies: syncedAt is the intended re-fetch trigger.
  useEffect(() => {
    if (!supported) return
    const client =
      injected ??
      (connected === null ? null : makeQuotaClient(connected.client, connected.accountId))
    if (client === null) return
    void refresh(client, Date.now())
  }, [supported, injected, connected, syncedAt])

  return supported ? value : null
}
