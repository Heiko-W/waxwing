/**
 * The one shared contact-card subscription (R-21).
 *
 * Two properties are pinned here, and the second is the finding.
 *
 *  1. Two consumers read ONE snapshot (the `mailbox-store` guarantee, `toBe` not `toEqual`).
 *  2. Three consumers cost ONE whole-table read, not three — and a write costs one more, not
 *     three more. That count IS the defect: the contacts screen, the sender card and every open
 *     composer window each held a `contactCards` live query of their own, and a contact card
 *     carries its photo inline, so each rerun deserialised the whole table again.
 */

import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putContactCards, type ReplicaDb, ReplicaProvider } from '.'
import { useContactCards } from './react'
import { contactCard, freshDb } from './test-utils'

let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  await putContactCards(db, 'a', [contactCard('c1'), contactCard('c2')])
  await putContactCards(db, 'b', [contactCard('other')])
})

afterEach(async () => {
  vi.restoreAllMocks()
  await db.delete()
})

function wrapper(accountId = 'a') {
  return ({ children }: { children: React.ReactNode }) => (
    <ReplicaProvider accountId={accountId} db={db}>
      {children}
    </ReplicaProvider>
  )
}

describe('the shared contact-card subscription', () => {
  it('hands two consumers the SAME array, not two equal ones', async () => {
    const first = renderHook(() => useContactCards(), { wrapper: wrapper() })
    const second = renderHook(() => useContactCards(), { wrapper: wrapper() })
    await waitFor(() => expect(first.result.current).toBeDefined())
    await waitFor(() => expect(second.result.current).toBeDefined())
    expect(first.result.current).toBe(second.result.current)
  })

  it('reads the table ONCE for three consumers, and once more per write', async () => {
    const reads = vi.spyOn(db.contactCards, 'where')

    function Probe({ label }: { label: string }) {
      return <span>{`${label}:${(useContactCards() ?? []).length}`}</span>
    }
    render(
      <ReplicaProvider accountId="a" db={db}>
        {/* The contacts screen, the sender card and a composer window, as far as this query
            is concerned. */}
        <Probe label="screen" />
        <Probe label="sender" />
        <Probe label="composer" />
      </ReplicaProvider>,
    )
    await screen.findByText('screen:2')
    await screen.findByText('sender:2')
    await screen.findByText('composer:2')
    expect(reads).toHaveBeenCalledTimes(1)

    await act(async () => {
      await putContactCards(db, 'a', [contactCard('c3')])
    })
    await screen.findByText('screen:3')
    await screen.findByText('composer:3')
    expect(reads).toHaveBeenCalledTimes(2)
  })

  it('keeps accounts apart', async () => {
    const a = renderHook(() => useContactCards(), { wrapper: wrapper('a') })
    const b = renderHook(() => useContactCards(), { wrapper: wrapper('b') })
    await waitFor(() => expect(a.result.current).toHaveLength(2))
    await waitFor(() => expect(b.result.current).toHaveLength(1))
    expect(b.result.current?.[0]?.id).toBe('other')
  })

  it('answers `undefined` without a provider instead of throwing', async () => {
    // What lets the composer share this query at all: `RecipientFields` is unit-tested with no
    // `ReplicaProvider` and kept a hand-rolled copy of the query for exactly that reason.
    const { result } = renderHook(() => useContactCards())
    expect(result.current).toBeUndefined()
  })

  it('re-queries after the last consumer has gone', async () => {
    const first = renderHook(() => useContactCards(), { wrapper: wrapper() })
    await waitFor(() => expect(first.result.current).toHaveLength(2))
    first.unmount()

    await putContactCards(db, 'a', [contactCard('c9')])
    const second = renderHook(() => useContactCards(), { wrapper: wrapper() })
    await waitFor(() => expect(second.result.current).toHaveLength(3))
  })
})
