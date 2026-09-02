import { renderHook, waitFor } from '@testing-library/react'
import { JmapProblemError } from '@waxwing/jmap'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionContext } from '../app/session/context'
import { fakeJmapClient, fakeJmapSession } from '../app/session/test-fakes'
import type { SessionContextValue } from '../app/session/types'
import { ToastProvider } from '../ui'
import type { BlobUploader, ValidationLimits } from './attachment-upload'
import { useComposerStore } from './composer-store'
import {
  abortPendingUploads,
  type UseAttachmentUploadOptions,
  useAttachmentUpload,
} from './use-attachment-upload'

const limits: ValidationLimits = { maxSizeUpload: 1000, maxSizeAttachmentsPerEmail: 5000 }

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>
}

function mount(draftId: string, options: UseAttachmentUploadOptions) {
  return renderHook(() => useAttachmentUpload(draftId, options), { wrapper })
}

const MAIL_URN = 'urn:ietf:params:jmap:mail'

/**
 * The hook with a real session behind it — i.e. WITHOUT the `limits` override, so the caps come
 * from the server's capability objects the way they do in the app.
 */
function mountWithSession(
  draftId: string,
  mailCapability: Record<string, unknown>,
  options: UseAttachmentUploadOptions,
) {
  const jmapSession = fakeJmapSession('acc-1', 'alice@waxwing.test', {
    accountCapabilities: { [MAIL_URN]: mailCapability },
  })
  const value = {
    status: 'ready',
    onboarding: null,
    reauth: null,
    connected: {
      client: fakeJmapClient(jmapSession),
      jmapSession,
      accountId: 'acc-1',
      accounts: [],
      delegated: [],
      username: 'alice@waxwing.test',
      method: 'basic',
    },
  } as unknown as SessionContextValue
  return renderHook(() => useAttachmentUpload(draftId, options), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <SessionContext.Provider value={value}>
        <ToastProvider>{children}</ToastProvider>
      </SessionContext.Provider>
    ),
  })
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

  /**
   * R-53: a chip that FAILED carries no blob and will never be part of the message. It was still
   * counted against the per-email cap, so one dead upload put the draft "over the limit": Send went
   * grey under "Attachments too large" and every further file was refused as oversized — for bytes
   * nobody was sending.
   */
  it('a failed upload neither blocks Send nor refuses the next file', async () => {
    const id = useComposerStore.getState().openDraft()
    const tight: ValidationLimits = { maxSizeUpload: 1000, maxSizeAttachmentsPerEmail: 25 }
    const uploader = vi.fn(async (file: Blob) => {
      if ((file as File).name === 'dead.png') throw new TypeError('fetch failed')
      return { blobId: 'ok', type: 'image/png', size: (file as File).size }
    }) as unknown as BlobUploader
    const { result } = mount(id, { uploader, limits: tight })

    result.current.addFiles([pngFile('dead.png', 20)], 'attach')
    await waitFor(() =>
      expect(useComposerStore.getState().uploads.get(id)?.[0]?.status).toBe('error'),
    )
    expect(result.current.oversized).toBe(false)

    // 0 real bytes + 10 incoming is under the 25-byte cap; counting the dead 20 made it 30.
    result.current.addFiles([pngFile('next.png', 10)], 'attach')
    await waitFor(() =>
      expect(useComposerStore.getState().drafts.get(id)?.attachments).toHaveLength(1),
    )
  })

  /**
   * R-57: `maxSizeAttachmentsPerEmail` is a server's JSON. Read with `??` — which only replaces
   * `null`/`undefined` — a `0` became a real cap: every file was refused as `totalTooLarge` and
   * `oversized` greyed out Send for any draft with an attachment. Same class as W-28.
   */
  it('ignores an unusable maxSizeAttachmentsPerEmail from the session', async () => {
    for (const cap of [0, -1, Number.NaN]) {
      useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
      const id = useComposerStore.getState().openDraft()
      const { result, unmount } = mountWithSession(
        id,
        { maxSizeAttachmentsPerEmail: cap, emailQuerySortOptions: [] },
        { uploader: okUploader('fine') },
      )
      result.current.addFiles([pngFile('a.png', 10)], 'attach')
      await waitFor(() =>
        expect(useComposerStore.getState().drafts.get(id)?.attachments, String(cap)).toHaveLength(
          1,
        ),
      )
      expect(result.current.oversized, String(cap)).toBe(false)
      unmount()
    }
  })

  it('still honours a maxSizeAttachmentsPerEmail the server can mean', async () => {
    // The guard is a guard, not a bypass: a real cap of 5 bytes still refuses a 10-byte file.
    const id = useComposerStore.getState().openDraft()
    const uploader = okUploader('nope')
    const { result } = mountWithSession(
      id,
      { maxSizeAttachmentsPerEmail: 5, emailQuerySortOptions: [] },
      { uploader },
    )
    result.current.addFiles([pngFile('a.png', 10)], 'attach')
    await Promise.resolve()
    expect(uploader).not.toHaveBeenCalled()
    expect(useComposerStore.getState().drafts.get(id)?.attachments ?? []).toHaveLength(0)
  })

  /**
   * R-03: the `pending` map is module-scoped and holds the `File` the user picked. A sign-out does
   * not unmount the module graph, so without an explicit abort the previous person's attachment
   * kept uploading — with the NEXT person's credentials once the session was replaced.
   */
  it('abortPendingUploads aborts the transfer and forgets the File (sign-out)', async () => {
    const id = useComposerStore.getState().openDraft()
    let signal: AbortSignal | undefined
    const uploader = vi.fn(
      (_file: Blob, options: { signal?: AbortSignal }) =>
        new Promise(() => {
          signal = options.signal
        }),
    ) as unknown as BlobUploader
    const { result } = mount(id, { uploader, limits })
    result.current.addFiles([pngFile()], 'attach')
    await waitFor(() => expect(signal).toBeDefined())

    abortPendingUploads()

    expect(signal?.aborted).toBe(true)
    // And the handle is gone, so a retry cannot resurrect it under the next session.
    result.current.retry(useComposerStore.getState().uploads.get(id)?.[0]?.tempId ?? 'none')
    expect(uploader).toHaveBeenCalledTimes(1)
  })
})
