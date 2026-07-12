/**
 * The storage seam (M3.4). The load-bearing part is {@link isQuotaExceeded}: it decides whether a
 * failed cache write triggers a forced eviction pass and a retry, or is re-thrown as a real error.
 *
 * It is tested against the shapes the failure ACTUALLY arrives in — not the convenient one. Every
 * cache write happens inside a Dexie `rw` transaction, and Dexie does not re-throw the browser's
 * `DOMException`: it wraps it in a `DexieError` whose own `name` is the mapped Dexie name and whose
 * `inner` holds the original. A guard that only matched a bare `DOMException` would therefore miss
 * every real quota failure while looking perfectly correct in a test that throws one directly.
 */

import { describe, expect, it } from 'vitest'
import { getStorageFullAt, isQuotaExceeded, reportStorageFull, resetStorageFull } from './storage'

describe('isQuotaExceeded', () => {
  it('matches a bare DOMException', () => {
    expect(isQuotaExceeded(new DOMException('out of space', 'QuotaExceededError'))).toBe(true)
  })

  it('matches a Dexie error that WRAPS the DOMException in `inner` (the real shape)', () => {
    // What Dexie 4 actually throws out of an aborted `rw` transaction: its own error object, whose
    // `name` is a Dexie name — NOT 'QuotaExceededError' — carrying the original in `inner`.
    const dexieError = Object.assign(new Error('Transaction aborted'), {
      name: 'AbortError',
      inner: new DOMException('out of space', 'QuotaExceededError'),
    })
    expect(isQuotaExceeded(dexieError)).toBe(true)
  })

  it('matches a nested wrap (inner.inner) and the legacy numeric code 22', () => {
    const nested = { name: 'AbortError', inner: { name: 'QuotaExceededError' } }
    expect(isQuotaExceeded({ name: 'AbortError', inner: nested })).toBe(true)
    expect(isQuotaExceeded({ code: 22 })).toBe(true)
  })

  it('does NOT match anything else — a false positive silently deletes user data', () => {
    // A pass triggered by a misread error would evict for no reason; worse, `withQuotaRecovery` would
    // swallow a genuine bug (a constraint error, a closed DB) as "the disk is full".
    expect(isQuotaExceeded(new DOMException('gone', 'NotFoundError'))).toBe(false)
    expect(isQuotaExceeded(new Error('boom'))).toBe(false)
    expect(isQuotaExceeded({ name: 'AbortError' })).toBe(false)
    expect(isQuotaExceeded({ code: 21 })).toBe(false)
    expect(isQuotaExceeded(null)).toBe(false)
    expect(isQuotaExceeded('QuotaExceededError')).toBe(false)
  })
})

describe('the "storage is full" signal', () => {
  it('records the event and clears on reset (a stale one would re-toast after re-login)', () => {
    resetStorageFull()
    expect(getStorageFullAt()).toBe(0)

    reportStorageFull(1234)
    expect(getStorageFullAt()).toBe(1234)

    // Sign-out wipes the replica; the module singleton must not survive it, or the next session's
    // notifier (whose own "already surfaced" ref starts at 0) fires a toast for the old event.
    resetStorageFull()
    expect(getStorageFullAt()).toBe(0)
  })
})
