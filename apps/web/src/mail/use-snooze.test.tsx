import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPref, type ReplicaDb, ReplicaProvider, setPref } from '../sync'
import { getDispatchFailureAt, resetDispatchFailure } from '../sync/dispatch-failure'
import { setActiveEngine } from '../sync/engine'
import { freshDb } from '../sync/test-utils'
import { SNOOZE_PREF_KEY } from './snooze'
import { useSnooze, useSnoozeWaker } from './use-snooze'

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
  // `snooze`/`wake` fire the preference write and do not await it. Closing the database out from
  // under an in-flight Dexie transaction produces a `DatabaseClosedError` that vitest reports as an
  // unhandled rejection — an artefact of the harness, not of the hook, so let the write land first.
  await new Promise((resolve) => setTimeout(resolve, 30))
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

describe('the snooze wake times', () => {
  /*
   * A read-modify-write on a map, not a blind write of a render's snapshot (R-48).
   *
   * The keyword travels the outbox and is per-message, so it was never at risk. The wake times are
   * one object under one preference key, and both writers used the map as their own render had seen
   * it — so the second one dropped the first's entry. That is worse than ordinary
   * last-writer-wins: the waker only wakes ids it finds in the MAP, the lost message keeps
   * `$snoozed`, and `backfill.ts` filters `notKeyword: $snoozed` out of every folder window. The
   * mail is then reachable only through search, for good.
   */
  it('keeps both entries when two snoozes land on the same render', async () => {
    dispatch.mockResolvedValue(undefined)
    const { result } = renderHook(() => useSnooze(), { wrapper })
    const wakeAt = new Date(Date.now() + 3_600_000)

    // ONE act, so neither call can see the other's liveQuery emission — which is precisely the
    // window the blind write lost an entry in, and it is not only a cross-tab one.
    await act(async () => {
      result.current.snooze(['e1'], wakeAt)
      result.current.snooze(['e2'], wakeAt)
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    expect(dispatch).toHaveBeenCalledTimes(2)
    const stored = await getPref<Record<string, number>>(db, 'a', SNOOZE_PREF_KEY)
    expect(Object.keys(stored ?? {}).sort()).toEqual(['e1', 'e2'])
  })

  it('does not lose a snooze to a wake that started from the same map', async () => {
    // The waker's minute tick landing during a snooze is the same race in one tab.
    dispatch.mockResolvedValue(undefined)
    await setPref(db, 'a', SNOOZE_PREF_KEY, { e0: Date.now() - 1000 })
    const { result } = renderHook(() => useSnooze(), { wrapper })
    await waitFor(() => expect(result.current.snoozed.e0).toBeDefined())

    await act(async () => {
      result.current.snooze(['e1'], new Date(Date.now() + 3_600_000))
      result.current.wake(['e0'])
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    const stored = await getPref<Record<string, number>>(db, 'a', SNOOZE_PREF_KEY)
    expect(Object.keys(stored ?? {})).toEqual(['e1'])
  })
})

describe('useSnoozeWaker', () => {
  /*
   * The interval belongs to the account, not to the render (R-49). `coerceSnoozeMap` produced a
   * fresh object every render, `snooze`/`wake` hung off it, and the waker's effect hung off those —
   * so `setInterval`/`clearInterval` and a `dueIds` scan ran on every render of the `AppShell`, in
   * every open tab.
   */
  it('installs its interval once, however often the shell re-renders', async () => {
    dispatch.mockResolvedValue(undefined)
    const spy = vi.spyOn(window, 'setInterval')
    // Only OUR interval: `waitFor` polls on a `setInterval` of its own, and counting every call
    // would measure the harness rather than the hook.
    const wakerIntervals = () => spy.mock.calls.filter((call) => call[1] === 60_000).length
    try {
      const { rerender } = renderHook(() => useSnoozeWaker(), { wrapper })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
      expect(wakerIntervals()).toBe(1)

      rerender()
      rerender()
      rerender()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
      expect(wakerIntervals()).toBe(1)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('still wakes what is due as soon as the preference arrives', async () => {
    // The counter-control for the memo: an interval that is never re-installed must not also stop
    // noticing data. A message due at mount has to come back without waiting a minute for the tick.
    dispatch.mockResolvedValue(undefined)
    await setPref(db, 'a', SNOOZE_PREF_KEY, { e0: Date.now() - 1000 })

    renderHook(() => useSnoozeWaker(), { wrapper })

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'setKeywords',
      keyword: '$snoozed',
      value: false,
      emailIds: ['e0'],
    })
  })
})
