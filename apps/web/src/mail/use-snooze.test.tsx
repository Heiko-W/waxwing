import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ReplicaDb, ReplicaProvider } from '../sync'
import { getDispatchFailureAt, resetDispatchFailure } from '../sync/dispatch-failure'
import { setActiveEngine } from '../sync/engine'
import { freshDb } from '../sync/test-utils'
import { useSnooze } from './use-snooze'

/**
 * Snooze's write half (R-10, the rest of W-10).
 *
 * `engine.dispatch` awaits `stateGuard`, `enqueueAction` and `refreshQueueCounts` — three IndexedDB
 * writes, and `enqueueAction` applies the OPTIMISTIC mutation before any of them (W-31). W-10 fixed
 * `use-message-actions`, `use-folder-actions` and the compose paths and stopped there, although its
 * own description was "not a single caller". This is one of the two it left.
 *
 * The damage is not a console line. On a full disk the message vanishes from the list, the wake time
 * is written to the preference, nothing carries either half to the server, and the automatic waker
 * does the same thing in reverse once a minute — all of it silent.
 */
const dispatch = vi.fn()
let db: ReplicaDb

function wrapper({ children }: { readonly children: ReactNode }) {
  return (
    <ReplicaProvider accountId="a" db={db}>
      {children}
    </ReplicaProvider>
  )
}

beforeEach(() => {
  db = freshDb()
  dispatch.mockReset()
  resetDispatchFailure()
  setActiveEngine({ dispatch } as unknown as Parameters<typeof setActiveEngine>[0])
})

afterEach(async () => {
  setActiveEngine(null)
  resetDispatchFailure()
  await db.delete()
})

describe('useSnooze', () => {
  it('reports a dispatch that could not be queued instead of dropping the rejection', async () => {
    dispatch.mockRejectedValue(new Error('QuotaExceededError'))
    const { result } = renderHook(() => useSnooze(), { wrapper })

    act(() => {
      result.current.snooze(['e1'], new Date(Date.now() + 3_600_000))
    })

    await waitFor(() => expect(getDispatchFailureAt()).toBeGreaterThan(0))
  })

  it('reports it on the wake path too — the one the waker drives automatically', async () => {
    dispatch.mockRejectedValue(new Error('QuotaExceededError'))
    const { result } = renderHook(() => useSnooze(), { wrapper })

    act(() => {
      result.current.wake(['e1'])
    })

    await waitFor(() => expect(getDispatchFailureAt()).toBeGreaterThan(0))
  })

  it('says nothing when the dispatch succeeds', async () => {
    dispatch.mockResolvedValue(undefined)
    const { result } = renderHook(() => useSnooze(), { wrapper })

    act(() => {
      result.current.snooze(['e1'], new Date(Date.now() + 3_600_000))
    })

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(getDispatchFailureAt()).toBe(0)
  })
})
