import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerStore } from './composer-store'
import { useDraftAutosave } from './use-draft-autosave'
import type { DraftSync } from './use-draft-sync'

const flush = vi.fn(async () => {})

vi.mock('./use-draft-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./use-draft-sync')>()),
  useDraftSync: (): Pick<DraftSync, 'flush'> => ({ flush }),
}))

beforeEach(() => {
  vi.useFakeTimers()
  flush.mockClear()
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
})
afterEach(() => {
  vi.useRealTimers()
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
})

/**
 * The autosave used to re-arm on ANY store mutation, because the store rebuilds the draft object
 * for every one of them. Minimizing a window, restoring it or going full screen therefore each
 * bought a `saveDraft` — and a save is create-new + destroy-old, so each one also minted a fresh
 * server id for a message nobody had edited (R-12).
 */
describe('useDraftAutosave', () => {
  it('persists a draft 3 s after the last CONTENT change', () => {
    renderHook(() => useDraftAutosave())
    const id = useComposerStore.getState().openDraft()
    useComposerStore.getState().updateBody(id, '<p>typing</p>')

    vi.advanceTimersByTime(3000)

    expect(flush).toHaveBeenCalledWith(id)
  })

  it('does not arm on a window change (minimize / restore / full screen)', () => {
    renderHook(() => useDraftAutosave())
    const id = useComposerStore.getState().openDraft()
    vi.advanceTimersByTime(3000)
    flush.mockClear()

    useComposerStore.getState().setMode(id, 'minimized')
    useComposerStore.getState().setMode(id, 'docked')
    useComposerStore.getState().setMode(id, 'expanded')
    vi.advanceTimersByTime(3000)

    expect(flush).not.toHaveBeenCalled()
  })
})
