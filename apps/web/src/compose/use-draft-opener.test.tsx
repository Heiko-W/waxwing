import { renderHook, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionContext } from '../app/session/context'
import { putEmails, type ReplicaDb, ReplicaProvider } from '../sync'
import { email, freshDb } from '../sync/test-utils'
import { useComposerStore } from './composer-store'
import { useDraftOpener } from './use-draft-opener'

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
