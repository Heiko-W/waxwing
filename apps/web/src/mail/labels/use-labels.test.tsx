import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putEmails, type ReplicaDb, ReplicaProvider, setPref } from '../../sync'
import { getDispatchFailureAt, resetDispatchFailure } from '../../sync/dispatch-failure'
import { setActiveEngine } from '../../sync/engine'
import { email, freshDb } from '../../sync/test-utils'
import type { LabelPref } from './label-model'
import { useLabelActions } from './use-labels'

/**
 * The destructive half of a label delete (R-10, the rest of W-10).
 *
 * `stripKeyword` walks the replica-known carriers in 500-id chunks and `await`s a dispatch per
 * chunk. A throw used to abandon the loop with the registry entry already removed: part of the mail
 * kept a keyword that no longer had a name anywhere, and nothing said so — the rejection went to the
 * console, which is not a place a user looks.
 */
const dispatch = vi.fn()
let db: ReplicaDb

/** Two full chunks and a bit, so a failure on the first has something after it to abandon. */
const CARRIERS = 1100

function wrapper({ children }: { readonly children: ReactNode }) {
  return (
    <ReplicaProvider accountId="a" db={db}>
      {children}
    </ReplicaProvider>
  )
}

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  resetDispatchFailure()
  setActiveEngine({ dispatch } as unknown as Parameters<typeof setActiveEngine>[0])
  await setPref(db, 'a', 'labels', [{ keyword: 'work', name: 'Work', color: 'red' }] as LabelPref[])
  await putEmails(
    db,
    'a',
    Array.from({ length: CARRIERS }, (_, i) =>
      email(`e${String(i)}`, { keywords: { work: true } }),
    ),
  )
})

afterEach(async () => {
  setActiveEngine(null)
  resetDispatchFailure()
  await db.delete()
})

describe('useLabelActions().remove with alsoStrip', () => {
  it('reports a chunk that could not be queued and strips the rest anyway', async () => {
    // The first chunk fails, the second and third succeed. Aborting would leave 600 messages
    // carrying a keyword whose registry entry is already gone.
    dispatch.mockRejectedValueOnce(new Error('QuotaExceededError')).mockResolvedValue(undefined)
    const { result } = renderHook(() => useLabelActions(), { wrapper })

    act(() => {
      result.current.remove('work', { alsoStrip: true })
    })

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(3))
    expect(getDispatchFailureAt()).toBeGreaterThan(0)
  })

  it('reports every chunk that fails rather than only the first', async () => {
    dispatch.mockRejectedValue(new Error('QuotaExceededError'))
    const { result } = renderHook(() => useLabelActions(), { wrapper })

    act(() => {
      result.current.remove('work', { alsoStrip: true })
    })

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(3))
    expect(getDispatchFailureAt()).toBeGreaterThan(0)
  })

  it('says nothing when every chunk lands', async () => {
    dispatch.mockResolvedValue(undefined)
    const { result } = renderHook(() => useLabelActions(), { wrapper })

    act(() => {
      result.current.remove('work', { alsoStrip: true })
    })

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(3))
    expect(getDispatchFailureAt()).toBe(0)
  })
})
