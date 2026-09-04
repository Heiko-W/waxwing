import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftRow, DraftSyncStatus, ReplicaDb } from '../sync'
import { putDraft, ReplicaProvider } from '../sync'
import { freshDb } from '../sync/test-utils'
import { useComposerStore } from './composer-store'
import { useDraftRestore } from './use-draft-restore'

let db: ReplicaDb

beforeEach(() => {
  db = freshDb()
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
})
afterEach(async () => {
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
  await db.delete()
})

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ReplicaProvider accountId="a" db={db}>
      {children}
    </ReplicaProvider>
  )
}

async function draft(localId: string, status: DraftSyncStatus): Promise<void> {
  const row: DraftRow = {
    accountId: 'a',
    localId,
    serverEmailId: status === 'synced' ? 'srv-1' : null,
    status,
    content: {
      to: [],
      cc: [],
      bcc: [],
      subject: localId,
      body: '<div>x</div>',
      inReplyTo: null,
      references: null,
      fromIdentityId: null,
      fromIdentityHint: null,
      attachments: [],
      sourceEmailId: null,
      sourceFlag: null,
    },
    createdAt: 0,
    updatedAt: 1,
    lastError: null,
  }
  await putDraft(db, row)
}

/**
 * Run crash-restore once and wait until it has reopened exactly `expected` windows; returns their
 * subjects, sorted. Waiting on the COUNT is what makes a wrongly reopened row a failure rather than
 * a race: the hook is asynchronous, so "nothing extra appeared" has to be asserted with a timeout.
 */
async function restored(expected: number): Promise<string[]> {
  renderHook(() => useDraftRestore(), { wrapper })
  await waitFor(() => expect(useComposerStore.getState().drafts.size).toBe(expected))
  return [...useComposerStore.getState().drafts.values()].map((d) => d.subject).sort()
}

/**
 * The rule is "reopen everything the SERVER does not already have". It was an inline two-value
 * comparison, so a fifth `DraftSyncStatus` would have joined the reopen side with nobody asked —
 * and the type's doc comment was the only thing saying what the values mean (N-02 follow-up).
 */
describe('useDraftRestore', () => {
  it('reopens `pending` and `error` rows and leaves `synced`/`sending` alone', async () => {
    await draft('pending-1', 'pending')
    await draft('error-1', 'error')
    await draft('synced-1', 'synced')
    await draft('sending-1', 'sending')

    expect(await restored(2)).toEqual(['error-1', 'pending-1'])
  })

  it('reopens a row whose status this build does not know', async () => {
    // An older tab reading a replica a newer build wrote. A duplicate chip is a nuisance; a draft
    // that is never reopened is lost work — so the unknown case falls on the restoring side.
    await draft('future-1', 'quantum' as DraftSyncStatus)

    expect(await restored(1)).toEqual(['future-1'])
  })
})
