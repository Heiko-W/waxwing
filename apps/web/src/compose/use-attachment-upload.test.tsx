import { renderHook, waitFor } from '@testing-library/react'
import { JmapProblemError } from '@waxwing/jmap'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../ui'
import type { BlobUploader, ValidationLimits } from './attachment-upload'
import { useComposerStore } from './composer-store'
import { type UseAttachmentUploadOptions, useAttachmentUpload } from './use-attachment-upload'

const limits: ValidationLimits = { maxSizeUpload: 1000, maxSizeAttachmentsPerEmail: 5000 }

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>
}

function mount(draftId: string, options: UseAttachmentUploadOptions) {
  return renderHook(() => useAttachmentUpload(draftId, options), { wrapper })
}

function pngFile(name = 'a.png', size = 10): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' })
}

const okUploader = (blobId = 'b1'): BlobUploader => {
  return vi.fn(async (file: Blob) => ({
    blobId,
    type: 'image/png',
    size: (file as File).size,
  })) as unknown as BlobUploader
}

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

describe('useAttachmentUpload', () => {
  it('moves a finished upload into draft.attachments', async () => {
    const id = useComposerStore.getState().openDraft()
    const { result } = mount(id, { uploader: okUploader('done'), limits })
    result.current.addFiles([pngFile()], 'attach')
    await waitFor(() =>
      expect(useComposerStore.getState().drafts.get(id)?.attachments).toHaveLength(1),
    )
    expect(useComposerStore.getState().uploads.get(id) ?? []).toHaveLength(0)
    expect(useComposerStore.getState().drafts.get(id)?.attachments[0]?.blobId).toBe('done')
  })

  it('rejects an oversize file before calling the uploader', async () => {
    const id = useComposerStore.getState().openDraft()
    const uploader = okUploader()
    const { result } = mount(id, { uploader, limits })
    result.current.addFiles([pngFile('big.png', 2000)], 'attach')
    await Promise.resolve()
    expect(uploader).not.toHaveBeenCalled()
    expect(useComposerStore.getState().uploads.get(id) ?? []).toHaveLength(0)
  })

  it('marks the upload errored on a 429 quota rejection', async () => {
    const id = useComposerStore.getState().openDraft()
    const uploader = vi.fn(async () => {
      throw new JmapProblemError({ type: 'x', status: 429 }, 429, 1000)
    }) as unknown as BlobUploader
    const { result } = mount(id, { uploader, limits })
    result.current.addFiles([pngFile()], 'attach')
    await waitFor(() => {
      const item = useComposerStore.getState().uploads.get(id)?.[0]
      expect(item?.status).toBe('error')
      expect(item?.error?.code).toBe('quota')
    })
  })

  it('recovers via retry after a failure', async () => {
    const id = useComposerStore.getState().openDraft()
    let calls = 0
    const uploader = vi.fn(async (file: Blob) => {
      calls += 1
      if (calls === 1) throw new Error('network blip')
      return { blobId: 'ok', type: 'image/png', size: (file as File).size }
    }) as unknown as BlobUploader
    const { result } = mount(id, { uploader, limits })
    result.current.addFiles([pngFile()], 'attach')
    await waitFor(() =>
      expect(useComposerStore.getState().uploads.get(id)?.[0]?.status).toBe('error'),
    )
    const tempId = useComposerStore.getState().uploads.get(id)?.[0]?.tempId
    result.current.retry(tempId as string)
    await waitFor(() =>
      expect(useComposerStore.getState().drafts.get(id)?.attachments).toHaveLength(1),
    )
  })

  it('cancels an in-flight upload (aborts, removes, keeps no attachment)', async () => {
    const id = useComposerStore.getState().openDraft()
    const uploader: BlobUploader = (_file, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        )
      })
    const { result } = mount(id, { uploader, limits })
    result.current.addFiles([pngFile()], 'attach')
    await waitFor(() => expect(useComposerStore.getState().uploads.get(id)).toHaveLength(1))
    const tempId = useComposerStore.getState().uploads.get(id)?.[0]?.tempId
    result.current.removeUpload(tempId as string)
    await waitFor(() => expect(useComposerStore.getState().uploads.get(id) ?? []).toHaveLength(0))
    expect(useComposerStore.getState().drafts.get(id)?.attachments ?? []).toHaveLength(0)
  })

  it('inserts an inline preview and stores the blob under a cid', async () => {
    const id = useComposerStore.getState().openDraft()
    const insertInlineImage = vi.fn(() => true)
    const { result } = mount(id, { uploader: okUploader('bi'), limits, insertInlineImage })
    result.current.addFiles([pngFile()], 'inline')
    expect(insertInlineImage).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      const att = useComposerStore.getState().drafts.get(id)?.attachments ?? []
      expect(att).toHaveLength(1)
      expect(att[0]?.cid).not.toBeNull()
    })
  })

  it('falls back to a regular attachment when the editor is not ready (no cid)', async () => {
    const id = useComposerStore.getState().openDraft()
    const insertInlineImage = vi.fn(() => false) // editor not mounted yet
    const { result } = mount(id, { uploader: okUploader('bi'), limits, insertInlineImage })
    result.current.addFiles([pngFile()], 'inline')
    await waitFor(() => {
      const att = useComposerStore.getState().drafts.get(id)?.attachments ?? []
      expect(att).toHaveLength(1)
      expect(att[0]?.cid).toBeNull() // downgraded to an attachment — never silently lost
    })
  })

  it('dedupes identical content-addressed blobIds', async () => {
    const id = useComposerStore.getState().openDraft()
    const { result } = mount(id, { uploader: okUploader('same'), limits })
    result.current.addFiles([pngFile('a.png'), pngFile('b.png')], 'attach')
    await waitFor(() => expect(useComposerStore.getState().uploads.get(id) ?? []).toHaveLength(0))
    expect(useComposerStore.getState().drafts.get(id)?.attachments).toHaveLength(1)
  })

  it('disables uploads when no uploader is available (no session)', () => {
    const id = useComposerStore.getState().openDraft()
    const { result } = mount(id, {})
    expect(result.current.canUpload).toBe(false)
  })
})
