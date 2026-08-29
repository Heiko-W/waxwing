/**
 * Cache usage accounting (M3.4, FR-OFF-04) — ONE source of truth, consumed by both the Settings
 * "Offline & storage" section and the engine's maintenance pass. That is structural, not stylistic:
 * "the usage the UI reports matches the usage eviction acts on" is a Done-when, and the only way to
 * guarantee it is to have a single function produce both numbers.
 *
 * Everything here is key-only (see `repo.bodyCacheEntries`): a full accounting of a multi-hundred-MB
 * replica costs three index scans and deserializes no mail.
 */

import type { Id } from '@waxwing/jmap'
import { ENVELOPE_BYTES_ESTIMATE, type ReplicaDb } from './db'
import {
  blobCacheEntries,
  bodyCacheEntries,
  type CacheItem,
  envelopeCount,
  personalDataCounts,
} from './repo'
import { browserEstimate, type EstimateFn, type StorageEstimateLike } from './storage'

export type { CacheItem }

export interface CacheCategory {
  readonly bytes: number
  readonly count: number
}

export interface CacheUsage {
  readonly bodies: CacheCategory
  readonly blobs: CacheCategory
  /** Envelopes: `count` is exact (an index count); `bytes` is `count × ENVELOPE_BYTES_ESTIMATE`. */
  readonly envelopes: CacheCategory
  /**
   * Contacts, calendar events, file-tree nodes and address statistics (W-18).
   *
   * Counted the same way as envelopes — exact row count, estimated bytes — and grouped, because
   * the reader's question is "what of MINE is on this machine", not which table it sits in. They
   * used to be in no category at all: their bytes landed silently in `otherBytes`, beside the app
   * shell and IndexedDB overhead, which made the settings breakdown say "Other" about a reader's
   * address book.
   */
  readonly personalData: CacheCategory
  /** Our accounted total (bodies + blobs + envelopes) — the number the eviction budget is measured against. */
  readonly accountedBytes: number
  /** `navigator.storage.estimate()` — ORIGIN-wide and coarse; `null` when unsupported. */
  readonly estimate: StorageEstimateLike | null
  /**
   * `max(0, estimate.usage − accountedBytes)`: the app shell, the service-worker precache, the
   * `waxwing-auth` database and IndexedDB's own overhead. `null` when there is no estimate to
   * subtract from — we do not invent a number.
   */
  readonly otherBytes: number | null
}

/**
 * Per-row byte estimates for the counted tables, in the spirit of {@link ENVELOPE_BYTES_ESTIMATE}:
 * a stored order of magnitude, not a measurement. A contact card carries addresses, phone numbers
 * and notes; a calendar row carries one event's JSON; a file node is a name, a size and ids; an
 * address statistic is an address plus two counters.
 */
const CONTACT_BYTES_ESTIMATE = 2_000
const CALENDAR_EVENT_BYTES_ESTIMATE = 1_500
const FILE_NODE_BYTES_ESTIMATE = 400
const ADDRESS_STAT_BYTES_ESTIMATE = 120

function total(items: readonly CacheItem[]): CacheCategory {
  let bytes = 0
  for (const item of items) bytes += item.bytes
  return { bytes, count: items.length }
}

/** The live cache breakdown for one account. `estimate` is injected so tests stay hermetic. */
export async function collectCacheUsage(
  db: ReplicaDb,
  accountId: Id,
  estimate: EstimateFn = browserEstimate,
): Promise<CacheUsage> {
  const [bodyItems, blobItems, envelopes, personal, storage] = await Promise.all([
    bodyCacheEntries(db, accountId),
    blobCacheEntries(db, accountId),
    envelopeCount(db, accountId),
    personalDataCounts(db, accountId),
    estimate(),
  ])
  const bodies = total(bodyItems)
  const blobs = total(blobItems)
  const envelopeBytes = envelopes * ENVELOPE_BYTES_ESTIMATE
  const personalCount =
    personal.contacts + personal.calendarEvents + personal.files + personal.addressStats
  const personalBytes =
    personal.contacts * CONTACT_BYTES_ESTIMATE +
    personal.calendarEvents * CALENDAR_EVENT_BYTES_ESTIMATE +
    personal.files * FILE_NODE_BYTES_ESTIMATE +
    personal.addressStats * ADDRESS_STAT_BYTES_ESTIMATE
  const accountedBytes = bodies.bytes + blobs.bytes + envelopeBytes + personalBytes
  return {
    bodies,
    blobs,
    envelopes: { bytes: envelopeBytes, count: envelopes },
    personalData: { bytes: personalBytes, count: personalCount },
    accountedBytes,
    estimate: storage,
    otherBytes: storage === null ? null : Math.max(0, storage.usage - accountedBytes),
  }
}
