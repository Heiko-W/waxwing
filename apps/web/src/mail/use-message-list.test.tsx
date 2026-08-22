/**
 * The list's sort keys (M-10).
 *
 * `emailQuerySortOptions` offers `sentAt` and `to`; the toolbar offered neither. The assertion that
 * matters is not which options a `<select>` renders but which COMPARATOR reaches the engine — the
 * window is keyed by it, so a sort that never gets sent is a sort that silently does nothing.
 */

import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb, mailbox } from '../sync/test-utils'
import { type MessageSort, useMessageList } from './use-message-list'

let db: ReplicaDb
const watchWindow = vi.fn<(mailboxId: string, spec: unknown) => string>(() => 'k')

beforeEach(async () => {
  db = freshDb()
  watchWindow.mockClear()
  setActiveEngine({
    watchWindow,
    watchQuery: vi.fn(() => 'k'),
    unwatchQuery: vi.fn(),
    loadMoreFor: vi.fn(),
    fetchEnvelopes: vi.fn(),
    dispatch: vi.fn(),
  } as unknown as Parameters<typeof setActiveEngine>[0])
  await putMailboxes(db, 'a', [mailbox('inbox', { role: 'inbox' })])
})

afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

function wrapper({ children }: { readonly children: ReactNode }) {
  return (
    <ConfigProvider config={DEFAULT_CONFIG}>
      <ReplicaProvider accountId="a" db={db}>
        {children}
      </ReplicaProvider>
    </ConfigProvider>
  )
}

/** The comparators the folder window was actually watched with. */
function watchedSort(sort: MessageSort): unknown {
  renderHook(() => useMessageList({ kind: 'folder', mailboxId: 'inbox' }, sort), { wrapper })
  return watchWindow.mock.calls.at(-1)?.[1]
}

describe('useMessageList — sort comparators', () => {
  it('sends sentAt for "Date sent" — newest first, like received', () => {
    expect(watchedSort('sentAt')).toEqual({
      sort: [{ property: 'sentAt', isAscending: false }],
      collapseThreads: true,
    })
  })

  it('sends to for "Recipient" — ascending, the key Sent is read by', () => {
    expect(watchedSort('to')).toEqual({
      sort: [{ property: 'to', isAscending: true }],
      collapseThreads: true,
    })
  })

  it('leaves the four existing keys exactly as they were', () => {
    expect(watchedSort('date')).toEqual({
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: true,
    })
    expect(watchedSort('from')).toEqual({
      sort: [{ property: 'from', isAscending: true }],
      collapseThreads: true,
    })
    expect(watchedSort('subject')).toEqual({
      sort: [{ property: 'subject', isAscending: true }],
      collapseThreads: true,
    })
    expect(watchedSort('size')).toEqual({
      sort: [{ property: 'size', isAscending: false }],
      collapseThreads: true,
    })
  })

  // A stored preference is user data: a build that drops a sort must not leave the list blank.
  it('falls back to the received date for a sort this build does not know', () => {
    expect(watchedSort('nonsense' as MessageSort)).toEqual({
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: true,
    })
  })
})
