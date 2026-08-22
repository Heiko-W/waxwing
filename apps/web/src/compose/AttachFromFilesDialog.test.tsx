/**
 * The "attach from Files" picker (D-5).
 *
 * What is worth asserting here is the thing that makes the feature cheap: what leaves this dialog
 * is the picked `FileNode`s, and the attachment built from one carries the node's OWN `blobId`.
 * Nothing is uploaded, nothing is downloaded — see `attach-from-files.ts` for the measurement.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileNode } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import type { FilesClient } from '../files/files-client'
import { expectNoA11yViolations } from '../test/axe'
import AttachFromFilesDialog from './AttachFromFilesDialog'
import { fileNodeAttachment } from './attach-from-files'

function node(over: Partial<FileNode> & { id: string; name: string }): FileNode {
  return {
    parentId: null,
    nodeType: 'file',
    blobId: `blob-${over.id}`,
    target: null,
    size: 1024,
    type: 'text/plain',
    created: '2026-08-01T00:00:00Z',
    modified: '2026-08-01T00:00:00Z',
    accessed: '2026-08-01T00:00:00Z',
    changed: '2026-08-01T00:00:00Z',
    executable: false,
    isSubscribed: true,
    myRights: {
      mayRead: true,
      mayAddChildren: true,
      mayRename: true,
      mayDelete: true,
      mayModifyContent: true,
      mayShare: true,
    },
    shareWith: {},
    role: null,
    ...over,
  }
}

const ROOT: FileNode[] = [
  node({ id: 'f1', name: 'Rechnung.pdf', type: 'application/pdf', size: 2048 }),
  node({ id: 'd1', name: 'Projekt', nodeType: 'directory', blobId: null, size: 0, type: null }),
]
const INSIDE: FileNode[] = [node({ id: 'f2', name: 'Notizen.txt', parentId: 'd1' })]

function fakeClient(over: Partial<FilesClient> = {}): FilesClient {
  return {
    list: vi.fn(async (parentId: string | null) => ({
      nodes: parentId === null ? ROOT : INSIDE,
      truncated: false,
    })),
    search: vi.fn(async () => []),
    ancestors: vi.fn(async () => []),
    upload: vi.fn(async () => null),
    createFolder: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    download: vi.fn(async () => null),
    searchPrincipals: vi.fn(async () => []),
    setShareWith: vi.fn(async () => {}),
    ...over,
  } as FilesClient
}

describe('AttachFromFilesDialog (D-5)', () => {
  it('hands back the picked node, whose attachment reuses the stored blobId', async () => {
    const onPick = vi.fn()
    render(
      <AttachFromFilesDialog
        client={fakeClient()}
        tier="desktop"
        onPick={onPick}
        onClose={() => {}}
      />,
    )
    await screen.findByText('Rechnung.pdf')

    await userEvent.click(screen.getByRole('checkbox', { name: /Rechnung\.pdf/ }))
    await userEvent.click(screen.getByRole('button', { name: /Attach 1 file/ }))

    const picked = onPick.mock.calls[0]?.[0] as FileNode[]
    expect(picked.map((n) => n.id)).toEqual(['f1'])
    // The load-bearing assertion: the draft attachment addresses the file's OWN blob. If this were
    // an upload id the feature would cost a transfer of every attached file.
    expect(fileNodeAttachment(picked[0] as FileNode)).toEqual({
      blobId: 'blob-f1',
      name: 'Rechnung.pdf',
      type: 'application/pdf',
      size: 2048,
      cid: null,
    })
  })

  it('walks into a folder and back out through the path', async () => {
    const client = fakeClient()
    render(
      <AttachFromFilesDialog client={client} tier="desktop" onPick={() => {}} onClose={() => {}} />,
    )
    await screen.findByText('Projekt')

    await userEvent.click(screen.getByRole('button', { name: 'Projekt' }))
    await screen.findByText('Notizen.txt')
    expect(client.list).toHaveBeenLastCalledWith('d1')

    // A picker one folder deep whose only way out is Cancel is the classic dead end.
    await userEvent.click(screen.getByRole('button', { name: 'Files' }))
    await screen.findByText('Rechnung.pdf')
  })

  it('keeps a selection made in one folder while browsing another', async () => {
    const onPick = vi.fn()
    render(
      <AttachFromFilesDialog
        client={fakeClient()}
        tier="desktop"
        onPick={onPick}
        onClose={() => {}}
      />,
    )
    await screen.findByText('Rechnung.pdf')
    await userEvent.click(screen.getByRole('checkbox', { name: /Rechnung\.pdf/ }))

    await userEvent.click(screen.getByRole('button', { name: 'Projekt' }))
    await screen.findByText('Notizen.txt')
    await userEvent.click(screen.getByRole('checkbox', { name: /Notizen\.txt/ }))
    await userEvent.click(screen.getByRole('button', { name: /Attach 2 files/ }))

    expect((onPick.mock.calls[0]?.[0] as FileNode[]).map((n) => n.id)).toEqual(['f1', 'f2'])
  })

  it('cannot confirm an empty selection', async () => {
    render(
      <AttachFromFilesDialog
        client={fakeClient()}
        tier="desktop"
        onPick={() => {}}
        onClose={() => {}}
      />,
    )
    await screen.findByText('Rechnung.pdf')
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled()
  })

  it('says so when the listing fails, instead of showing an empty folder', async () => {
    // An error that renders as "this folder is empty" is the one outcome nothing on screen can
    // correct: the reader concludes the file is gone.
    render(
      <AttachFromFilesDialog
        client={fakeClient({ list: vi.fn(async () => Promise.reject(new Error('offline'))) })}
        tier="desktop"
        onPick={() => {}}
        onClose={() => {}}
      />,
    )
    await screen.findByText('Files could not be loaded')
  })

  it('has no a11y violations', async () => {
    // Scanned against `document.body`: the Dialog renders through a Portal, so the render
    // container is empty and axe would have nothing to look at.
    render(
      <AttachFromFilesDialog
        client={fakeClient()}
        tier="phone"
        onPick={() => {}}
        onClose={() => {}}
      />,
    )
    await screen.findByText('Rechnung.pdf')
    await expectNoA11yViolations(document.body)
  })
})
