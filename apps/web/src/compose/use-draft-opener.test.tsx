import { renderHook, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionContext } from '../app/session/context'
import { putEmails, putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { email, freshDb, mailbox } from '../sync/test-utils'
import { useComposerStore } from './composer-store'
import { useDraftOpener } from './use-draft-opener'
import { type DraftSync, useDraftSync } from './use-draft-sync'

let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
  // The same draft id in both accounts' caches, so nothing but the SCOPE decides the outcome.
  for (const accountId of ['a', 'c']) {
    await putEmails(db, accountId, [
      email('draft-1', { subject: 'Carols Entwurf', keywords: { $draft: true } }),
    ])
  }
})
afterEach(async () => {
  setActiveEngine(null)
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
  await db.delete()
})

/** A connected session on account `a` (the composer's account) — see `ActiveAccountScope`. */
function wrapperFor(actingAccountId: string) {
  const session = {
    connected: { accountId: 'a', jmapSession: { accounts: { a: {} } } },
  } as unknown as ComponentProps<typeof SessionContext.Provider>['value']
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <SessionContext.Provider value={session}>
        <ReplicaProvider accountId={actingAccountId} db={db}>
          {children}
        </ReplicaProvider>
      </SessionContext.Provider>
    )
  }
}

/**
 * R-52. `useDraftOpener` runs inside `ActiveAccountScope`; the composer mounts OUTSIDE it, on the
 * primary account, because there is no send-as from a delegated account (ADR-020). Opening a
 * delegated account's draft therefore adopted it under THAT account's id and flushed it under the
 * primary's: a copy in the user's own Drafts folder on close, the original untouched, and a Discard
 * that destroyed nothing.
 */
describe('useDraftOpener — a draft of a delegated account', () => {
  it('refuses to open it for editing', async () => {
    const { result } = renderHook(() => useDraftOpener(), { wrapper: wrapperFor('c') })

    expect(result.current.canEdit).toBe(false)
    await result.current.open('draft-1')

    expect(useComposerStore.getState().drafts.size).toBe(0)
    expect(await db.drafts.get(['c', 'draft-1'])).toBeUndefined()
  })

  it('opens the primary account’s own draft as before — the counter-test', async () => {
    const { result } = renderHook(() => useDraftOpener(), { wrapper: wrapperFor('a') })

    expect(result.current.canEdit).toBe(true)
    await result.current.open('draft-1')

    await waitFor(() => expect(useComposerStore.getState().drafts.size).toBe(1))
  })
})

/**
 * N-02. The row that ties an opened Drafts message to its server copy said `pending` — "a write is
 * outstanding" — while the draft sat unchanged on the server. The unchanged-guard (R-12) tests for
 * `synced`, so it never fired on the FIRST close, and open-then-close without an edit still cost a
 * `create` + `destroy` against the server: the most ordinary thing anyone does with a draft.
 */
describe('useDraftOpener — the row it writes for a server draft', () => {
  const dispatch = vi.fn()

  /** Open `draft-1` from the server envelope and return the composer's local id for it. */
  async function openServerDraft(): Promise<{ localId: string; sync: DraftSync }> {
    dispatch.mockReset()
    const fetchBody = vi.fn(async () => undefined)
    setActiveEngine({ dispatch, fetchBody } as unknown as Parameters<typeof setActiveEngine>[0])
    // Without a Drafts mailbox `flushDraft` returns before dispatching anything — the "nothing was
    // queued" assertion would then hold for the wrong reason.
    await putMailboxes(db, 'a', [mailbox('mb-d', { role: 'drafts' })])
    const { result } = renderHook(() => ({ opener: useDraftOpener(), sync: useDraftSync() }), {
      wrapper: wrapperFor('a'),
    })

    await result.current.opener.open('draft-1')
    await waitFor(() => expect(useComposerStore.getState().drafts.size).toBe(1))
    const localId = [...useComposerStore.getState().drafts.keys()][0] as string
    return { localId, sync: result.current.sync }
  }

  it('says `synced` — the content IS the server copy, nothing is owed (N-02)', async () => {
    const { localId } = await openServerDraft()

    const adopted = await db.drafts.get(['a', localId])
    expect(adopted?.serverEmailId).toBe('draft-1')
    expect(adopted?.status).toBe('synced')
  })

  it('closing it untouched queues no save — no create+destroy round trip (N-02, R-12)', async () => {
    const { localId, sync } = await openServerDraft()

    await sync.flush(localId)

    expect(dispatch).not.toHaveBeenCalled()
    expect((await db.drafts.get(['a', localId]))?.status).toBe('synced')
  })
})
