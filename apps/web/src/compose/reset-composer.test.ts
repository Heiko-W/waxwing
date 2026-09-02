import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerStore } from './composer-store'
import { getInlineObjectUrl, putInlineObjectUrl } from './inline-image-registry'
import { resetComposer } from './reset-composer'

beforeEach(() => {
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock'),
    revokeObjectURL: vi.fn(),
  })
})
afterEach(() => {
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
  vi.unstubAllGlobals()
})

/**
 * R-03. The composer keeps its drafts at MODULE scope so a window survives a route change and a
 * host remount — which also means a sign-out, an in-SPA transition, leaves every one of them
 * loaded. On a shared machine that is the previous person's half-written mail, still in memory and
 * still ready to be autosaved into whichever account signs in next.
 */
describe('resetComposer', () => {
  it('drops every open draft and its upload view state', () => {
    const id = useComposerStore.getState().openDraft({ subject: 'private to alice' })
    useComposerStore.getState().addUpload(id, {
      tempId: 't1',
      name: 'a.png',
      type: 'image/png',
      size: 10,
      inline: false,
      cid: null,
      previewUrl: null,
      status: 'uploading',
      progress: 0,
      error: null,
    })

    resetComposer()

    expect(useComposerStore.getState().drafts.size).toBe(0)
    expect(useComposerStore.getState().focusedId).toBeUndefined()
    expect(useComposerStore.getState().uploads.size).toBe(0)
  })

  it('revokes every inline-image preview URL', () => {
    putInlineObjectUrl('cid-1@waxwing.local', 'blob:one')
    putInlineObjectUrl('cid-2@waxwing.local', 'blob:two')

    resetComposer()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:one')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:two')
    expect(getInlineObjectUrl('cid-1@waxwing.local')).toBeNull()
    expect(getInlineObjectUrl('cid-2@waxwing.local')).toBeNull()
  })
})
