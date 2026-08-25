/**
 * The one shared mailbox subscription (B10, ADR-035).
 *
 * What is asserted here is the guarantee, not the implementation: two consumers read ONE snapshot.
 * That is the property whose absence produced the defect — with a liveQuery each, the reveal layer
 * had already re-rendered without Archive while the shortcut layer still had it, and `e` dispatched
 * a move into a mailbox that was gone.
 *
 * Identity (`toBe`) rather than deep equality is the whole point: two subscriptions can be deeply
 * equal at rest and still disagree for the tick that matters.
 */

import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteMailbox, putMailboxes, type ReplicaDb, ReplicaProvider } from '.'
import { useMailboxByRole, useMailboxes } from './react'
import { freshDb, mailbox } from './test-utils'

let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  await putMailboxes(db, 'a', [
    mailbox('inbox', { role: 'inbox' }),
    mailbox('archive', { role: 'archive' }),
  ])
  await putMailboxes(db, 'b', [mailbox('other-inbox', { role: 'inbox' })])
})

afterEach(async () => {
  await db.delete()
})

function wrapper(accountId = 'a') {
  return ({ children }: { children: React.ReactNode }) => (
    <ReplicaProvider accountId={accountId} db={db}>
      {children}
    </ReplicaProvider>
  )
}

describe('the shared mailbox subscription', () => {
  it('hands two consumers the SAME array, not two equal ones', async () => {
    const first = renderHook(() => useMailboxes(), { wrapper: wrapper() })
    const second = renderHook(() => useMailboxes(), { wrapper: wrapper() })
    await waitFor(() => expect(first.result.current).toBeDefined())
    await waitFor(() => expect(second.result.current).toBeDefined())
    expect(first.result.current).toBe(second.result.current)
  })

  it('derives a role mailbox from that same array', async () => {
    // `useMailboxByRole` was the most-repeated independent subscription in the app — five in
    // `useTriage` alone. It is a `find` over the shared list now, so the row a chord acts on and the
    // row a button acts on are one object.
    const list = renderHook(() => useMailboxes(), { wrapper: wrapper() })
    const role = renderHook(() => useMailboxByRole('archive'), { wrapper: wrapper() })
    await waitFor(() => expect(role.result.current).toBeDefined())
    expect(role.result.current).toBe(list.result.current?.find((box) => box.id === 'archive'))
  })

  it('keeps accounts apart', async () => {
    const a = renderHook(() => useMailboxes(), { wrapper: wrapper('a') })
    const b = renderHook(() => useMailboxes(), { wrapper: wrapper('b') })
    await waitFor(() => expect(a.result.current).toHaveLength(2))
    await waitFor(() => expect(b.result.current).toHaveLength(1))
    expect(b.result.current?.[0]?.id).toBe('other-inbox')
  })

  it('delivers a change to every consumer', async () => {
    // The half that makes sharing safe rather than merely cheap: one subscription must still push
    // to everyone, or the second consumer would be stuck on the snapshot it mounted with — a worse
    // version of the very defect this replaced.
    function Probe({ label }: { label: string }) {
      return <span>{`${label}:${(useMailboxes() ?? []).map((box) => box.id).join(',')}`}</span>
    }
    render(
      <ReplicaProvider accountId="a" db={db}>
        <Probe label="one" />
        <Probe label="two" />
      </ReplicaProvider>,
    )
    await screen.findByText('one:archive,inbox')
    await screen.findByText('two:archive,inbox')

    await act(async () => {
      await deleteMailbox(db, 'a', 'archive')
    })
    await screen.findByText('one:inbox')
    await screen.findByText('two:inbox')
  })

  it('re-queries after the last consumer has gone', async () => {
    // The subscription is torn down when nobody is listening, so the snapshot must not be served
    // stale to whoever mounts next.
    const first = renderHook(() => useMailboxes(), { wrapper: wrapper() })
    await waitFor(() => expect(first.result.current).toHaveLength(2))
    first.unmount()

    await putMailboxes(db, 'a', [mailbox('work', { name: 'Work' })])
    const second = renderHook(() => useMailboxes(), { wrapper: wrapper() })
    await waitFor(() => expect(second.result.current).toHaveLength(3))
  })
})
