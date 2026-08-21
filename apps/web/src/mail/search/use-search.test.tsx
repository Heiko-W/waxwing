/**
 * The search hook's SCOPE wiring (B-2).
 *
 * `search-query.test.ts` proves that an `excludeMailboxIds` context produces `inMailboxOtherThan`.
 * This file proves the other half — that choosing "All mailboxes" actually fills that list, from the
 * live mailbox tree, by ROLE. The defect lived exactly in this seam: the parser was fine, the scope
 * simply handed it nothing, so every all-mailboxes search returned Trash and Junk with no way to say
 * otherwise.
 */

import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RouterProvider } from '../../app/route'
import { putMailboxes, type ReplicaDb, ReplicaProvider } from '../../sync'
import { freshDb, mailbox } from '../../sync/test-utils'
import { excludedSearchMailboxes, useSearch } from './use-search'

let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  await putMailboxes(db, 'a', [
    mailbox('inbox', { role: 'inbox' }),
    mailbox('archive', { role: 'archive' }),
    mailbox('sent', { role: 'sent' }),
    mailbox('trash', { role: 'trash' }),
    mailbox('junk', { role: 'junk' }),
    mailbox('project', { name: 'Project Zebra' }),
  ])
})

afterEach(async () => {
  await db.delete()
  window.history.replaceState(null, '', '/mail/inbox')
})

function wrapper({ children }: { readonly children: ReactNode }) {
  return (
    <RouterProvider baseUri="/">
      <ReplicaProvider accountId="a" db={db}>
        {children}
      </ReplicaProvider>
    </RouterProvider>
  )
}

/** Render the hook at a given URL — the search lives entirely in the URL. */
async function searchAt(url: string) {
  window.history.replaceState(null, '', url)
  const view = renderHook(() => useSearch('inbox', 'a'), { wrapper })
  // The mailbox list arrives through a liveQuery, so the first render has no roles to resolve yet.
  await waitFor(() => expect(view.result.current.spec).not.toBeNull())
  return view
}

/** Every condition of an AND filter (or the single condition, when there is only one). */
function conditionsOf(filter: unknown): unknown[] {
  const record = filter as { operator?: string; conditions?: unknown[] }
  return record.operator === 'AND' ? (record.conditions ?? []) : [filter]
}

/** The excluded mailbox ids, sorted — the set is what matters, not the tree's own order. */
function excludedIn(filter: unknown): string[] | undefined {
  for (const condition of conditionsOf(filter)) {
    const ids = (condition as { inMailboxOtherThan?: string[] }).inMailboxOtherThan
    if (ids !== undefined) return [...ids].sort()
  }
  return undefined
}

describe('useSearch — mailbox scope', () => {
  it('scope=all excludes Trash and Junk by role', async () => {
    const { result } = await searchAt('/mail/inbox?q=offer&scope=all')
    await waitFor(() => expect(excludedIn(result.current.spec?.filter)).toEqual(['junk', 'trash']))
  })

  it('scope=all never scopes to a single mailbox', async () => {
    const { result } = await searchAt('/mail/inbox?q=offer&scope=all')
    await waitFor(() => expect(result.current.scope).toBe('all'))
    expect(JSON.stringify(result.current.spec?.filter)).not.toContain('"inMailbox"')
  })

  it('scope=everywhere is the way back in — no exclusion at all', async () => {
    const { result } = await searchAt('/mail/inbox?q=offer&scope=everywhere')
    await waitFor(() => expect(result.current.scope).toBe('everywhere'))
    expect(result.current.spec?.filter).toEqual({ text: 'offer' })
  })

  it('scope=folder is untouched: the current folder, nothing else', async () => {
    const { result } = await searchAt('/mail/inbox?q=offer')
    expect(result.current.scope).toBe('folder')
    expect(result.current.spec?.filter).toEqual({
      operator: 'AND',
      conditions: [{ text: 'offer' }, { inMailbox: 'inbox' }],
    })
  })

  it('an explicit in:trash still reaches the Trash from an all-mailboxes search', async () => {
    const { result } = await searchAt('/mail/inbox?q=in%3Atrash+offer&scope=all')
    await waitFor(() =>
      expect(result.current.spec?.filter).toEqual({
        operator: 'AND',
        conditions: [{ inMailbox: 'trash' }, { text: 'offer' }],
      }),
    )
  })

  it('an unknown ?scope= means the folder, the narrow reading', async () => {
    const { result } = await searchAt('/mail/inbox?q=offer&scope=nonsense')
    expect(result.current.scope).toBe('folder')
  })
})

describe('excludedSearchMailboxes', () => {
  const boxes = [
    mailbox('inbox', { role: 'inbox' }),
    mailbox('trash', { role: 'trash' }),
    mailbox('junk', { role: 'junk' }),
    // A user folder LITERALLY named "Trash" is not the Trash — only the server's role is.
    mailbox('mine', { name: 'Trash', role: null }),
  ].map((box) => ({ ...box, accountId: 'a' }))

  it('picks Trash and Junk by role, never by name', () => {
    expect(excludedSearchMailboxes(boxes, 'all')).toEqual(['trash', 'junk'])
  })

  it('excludes nothing for the other two scopes', () => {
    expect(excludedSearchMailboxes(boxes, 'folder')).toEqual([])
    expect(excludedSearchMailboxes(boxes, 'everywhere')).toEqual([])
  })

  it('survives a tree that has not loaded yet', () => {
    expect(excludedSearchMailboxes(undefined, 'all')).toEqual([])
  })
})
