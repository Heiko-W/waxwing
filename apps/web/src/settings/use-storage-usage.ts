/**
 * The Settings "Offline & storage" data source (M3.4). It reads the SAME {@link collectCacheUsage} the
 * engine's eviction planner reads, so "the usage the UI shows" and "the usage eviction acts on" cannot
 * drift apart — and because it is a Dexie liveQuery, freeing space re-renders the meter with no manual
 * refresh.
 *
 * `estimate()` / `persisted()` are re-read on every run (they are cheap and origin-wide), but
 * `persist()` is NEVER called here: it may prompt (Firefox), so it only ever runs from the user's
 * click on the switch.
 */

import { useCallback, useEffect, useState } from 'react'
import { useConfig } from '../app/config-context'
import {
  browserEstimate,
  type CacheUsage,
  collectCacheUsage,
  type EstimateFn,
  isPersisted,
  requestPersistence,
  useReplicaQuery,
} from '../sync'
import { chooseBudget } from '../sync/engine'

export interface StorageUsageView {
  readonly usage: CacheUsage
  /** The effective eviction budget — the config budget capped by a safe share of the browser's quota. */
  readonly budgetBytes: number
  /** `null` = the StorageManager is unsupported (the persistence switch is then hidden entirely). */
  readonly persisted: boolean | null
}

export interface StorageUsageOptions {
  /** Injected in tests (jsdom/fake-indexeddb have no StorageManager); defaults to the browser's. */
  readonly estimate?: EstimateFn
  readonly persisted?: () => Promise<boolean | null>
}

/** Live cache usage + budget + persistence state; `undefined` until the first query resolves. */
export function useStorageUsage(options: StorageUsageOptions = {}): StorageUsageView | undefined {
  const config = useConfig()
  const estimate = options.estimate ?? browserEstimate
  const readPersisted = options.persisted ?? isPersisted
  const [persisted, setPersisted] = useState<boolean | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void readPersisted().then((value) => {
      if (!cancelled) setPersisted(value)
    })
    return () => {
      cancelled = true
    }
  }, [readPersisted])

  const usage = useReplicaQuery(
    ({ db, accountId }) => collectCacheUsage(db, accountId, estimate),
    [estimate],
  )

  if (usage === undefined || persisted === undefined) return undefined
  return {
    usage,
    budgetBytes: chooseBudget(config.offline.maxStorageMB, usage.estimate),
    persisted,
  }
}

/**
 * Ask the browser to keep this origin's data (`navigator.storage.persist()`). MUST be called from a
 * user gesture — it can raise a permission prompt. A denial is final for the session: the caller
 * renders the "not granted" hint and does NOT retry.
 */
export function useRequestPersistence(request: () => Promise<boolean> = requestPersistence) {
  return useCallback(() => request(), [request])
}
