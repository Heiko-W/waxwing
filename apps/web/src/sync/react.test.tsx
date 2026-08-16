import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReplicaDb } from './db'
import {
  getActiveReplica,
  ReplicaProvider,
  useAddressBooks,
  useContactWindow,
  useLocalPref,
  useLocalPrefOptional,
  useMailboxes,
  useReplica,
} from './react'
import {
  putAddressBooks,
  putContactCards,
  putContactQueryCache,
  putMailboxes,
  setPref,
} from './repo'
import { addressBook, contactCard, freshDb, mailbox } from './test-utils'

let db: ReplicaDb
const ACC = 'acc'

beforeEach(() => {
  db = freshDb()
})

afterEach(async () => {
  await db.delete()
})

function wrap(node: React.ReactNode) {
  return render(
    <ReplicaProvider db={db} accountId={ACC}>
      {node}
    </ReplicaProvider>,
  )
}

function MailboxNames() {
  const mailboxes = useMailboxes()
  return (
    <ul aria-label="mailboxes">
      {mailboxes?.map((row) => (
        <li key={row.id}>{row.name}</li>
      ))}
    </ul>
  )
}

describe('ReplicaProvider + hooks', () => {
  it('re-renders live when the replica changes', async () => {
    wrap(<MailboxNames />)
    await putMailboxes(db, ACC, [mailbox('inbox', { name: 'Inbox', role: 'inbox' })])
    expect(await screen.findByText('Inbox')).toBeDefined()
  })

  it('exposes a typed local preference that updates live', async () => {
    function Density() {
      const density = useLocalPref<string>('list.density')
      return <span>{density ?? 'default'}</span>
    }
    wrap(<Density />)
    expect(await screen.findByText('default')).toBeDefined()
    await setPref(db, ACC, 'list.density', 'compact')
    expect(await screen.findByText('compact')).toBeDefined()
  })

  it('useLocalPrefOptional yields undefined OUTSIDE a provider instead of throwing', () => {
    // The composer and the reading pane read prefs and are unit-tested WITHOUT a replica. If the
    // pref hook threw there, a settings-backed default would become a reason for a pane to crash.
    function Optional() {
      const value = useLocalPrefOptional<string>('list.density')
      return <span>{value ?? 'no-replica'}</span>
    }
    render(<Optional />)
    expect(screen.getByText('no-replica')).toBeDefined()
  })

  it('useLocalPrefOptional still reads the value WITH a provider', async () => {
    function Optional() {
      const value = useLocalPrefOptional<string>('list.density')
      return <span>{value ?? 'default'}</span>
    }
    wrap(<Optional />)
    expect(await screen.findByText('default')).toBeDefined()
    await setPref(db, ACC, 'list.density', 'compact')
    expect(await screen.findByText('compact')).toBeDefined()
  })

  it('throws when used outside a provider', () => {
    function Bad() {
      useReplica()
      return null
    }
    expect(() => render(<Bad />)).toThrow(/ReplicaProvider/)
  })

  it('useAddressBooks lists the account address books live (M4.2)', async () => {
    function Books() {
      const books = useAddressBooks()
      return (
        <ul aria-label="books">
          {books?.map((b) => (
            <li key={b.id}>{b.name}</li>
          ))}
        </ul>
      )
    }
    wrap(<Books />)
    await putAddressBooks(db, ACC, [addressBook('book1', { name: 'Personal' })])
    expect(await screen.findByText('Personal')).toBeDefined()
  })

  it('useContactWindow hydrates the cached id window in server order (M4.2)', async () => {
    const KEY = 'ck'
    function Window() {
      const cards = useContactWindow(KEY)
      return (
        <ol aria-label="cards">
          {cards?.map((card, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the window is a positional slice
            <li key={index}>{card ? card.uid : 'gap'}</li>
          ))}
        </ol>
      )
    }
    await putContactCards(db, ACC, [contactCard('c1'), contactCard('c2')])
    await putContactQueryCache(db, {
      accountId: ACC,
      key: KEY,
      ids: ['c2', 'missing', 'c1'],
      queryState: 'cqs',
      total: 3,
      upToId: 'c1',
      filter: null,
      sort: null,
      lastUsedAt: 1,
    })
    wrap(<Window />)
    // Order preserved (c2, gap, c1); the absent id renders as a skeleton gap.
    expect(await screen.findByText('uid-c2')).toBeDefined()
    const items = screen.getByLabelText('cards').textContent
    expect(items).toBe('uid-c2gapuid-c1')
  })
})

describe('getActiveReplica — only the OUTERMOST provider claims it (M4.4 Etappe 4)', () => {
  // The app-wide handle is what `flushActiveDraft` uses to keep M3.5's "open drafts are saved first"
  // promise. Since Etappe 3 the providers nest, and a nested one claiming it would leave the handle
  // pointing at a SHARED account for good — the outer provider's effect does not re-run to restore
  // it — so a flush would `putDraft` under the wrong account while the composer reads the primary's.
  const SHARED = 'shared-acc'

  afterEach(() => {
    cleanup()
  })

  it('keeps the outer account when a nested provider re-scopes a subtree', () => {
    render(
      <ReplicaProvider accountId={ACC} db={db}>
        <ReplicaProvider accountId={SHARED} db={db}>
          <span>nested</span>
        </ReplicaProvider>
      </ReplicaProvider>,
    )

    expect(getActiveReplica()?.accountId).toBe(ACC)
  })

  it('still keeps the outer account after the nested scope switches account', () => {
    const { rerender } = render(
      <ReplicaProvider accountId={ACC} db={db}>
        <ReplicaProvider accountId={SHARED} db={db}>
          <span>nested</span>
        </ReplicaProvider>
      </ReplicaProvider>,
    )
    rerender(
      <ReplicaProvider accountId={ACC} db={db}>
        <ReplicaProvider accountId="other-acc" db={db}>
          <span>nested</span>
        </ReplicaProvider>
      </ReplicaProvider>,
    )

    expect(getActiveReplica()?.accountId).toBe(ACC)
  })

  it('is null once the outermost provider unmounts', () => {
    const { unmount } = render(
      <ReplicaProvider accountId={ACC} db={db}>
        <span>only</span>
      </ReplicaProvider>,
    )
    expect(getActiveReplica()?.accountId).toBe(ACC)

    unmount()

    expect(getActiveReplica()).toBeNull()
  })
})
