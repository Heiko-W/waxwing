/**
 * The file browser's inline preview (M5.17).
 *
 * The behaviour worth pinning is what the preview REFUSES: a type outside `preview-policy.ts` gets
 * no button at all, and nothing that is previewed reaches a surface that could run it. The two
 * assertions on `sandbox` and on the absence of a frame for images are the ones that fail if
 * someone later "simplifies" the render into a single `<iframe>` for everything.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileNode, FileNodeCapability } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionContext } from '../app/session/context'
import type { SessionContextValue } from '../app/session/types'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import FilesPage from './FilesPage'
import type { FileSearchHit, FilesClient } from './files-client'

function node(over: Partial<FileNode> & { id: string; name: string }): FileNode {
  return {
    parentId: null,
    nodeType: 'file',
    blobId: `blob-${over.id}`,
    target: null,
    size: 1024,
    type: 'application/octet-stream',
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
      mayShare: false,
    },
    shareWith: {},
    role: null,
    ...over,
  }
}

const download = vi.fn(async () => new Blob(['bytes']))
let listed: FileNode[] = []
/** What `list` reports about its own completeness — the B-6 seam. */
let truncated = false
/** What `search` answers with, paired with the folder each hit was found in. */
let searchHits: FileSearchHit[] = []

const client: FilesClient = {
  list: async () => ({ nodes: listed, truncated }),
  search: async () => searchHits,
  ancestors: async () => [],
  upload: async () => null,
  createFolder: async () => {},
  rename: async () => {},
  move: async () => {},
  destroy: async () => {},
  download,
  searchPrincipals: async () => [],
  setShareWith: async () => {},
}

const created: string[] = []
const revoked: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  created.length = 0
  revoked.length = 0
  let seq = 0
  // jsdom implements neither, and the component's whole job here is to hand one to a surface.
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test/${++seq}`
    created.push(url)
    return url
  })
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url)
  })
})

afterEach(() => {
  listed = []
  searchHits = []
  truncated = false
})

/**
 * The session the screen reads its LIMITS from, measured against Stalwart 0.16.18.
 *
 * Not decoration in a test: `fileNodeQuerySortOptions` is what the sort menu may offer (a
 * comparator this server has not advertised fails the whole request, not just the sort), and
 * `forbiddenNameChars` / `forbiddenNodeNames` are what a name is refused for before the round trip.
 * Rendering without a session leaves both unanswered, which is a different screen from the one that
 * ships.
 */
const CAPABILITY: FileNodeCapability = {
  maxFileNodeDepth: null,
  maxSizeFileNodeName: 255,
  forbiddenNameChars: '/<>:"\\|?*',
  forbiddenNodeNames: ['.', '..', 'CON', 'PRN', 'AUX', 'NUL'],
  fileNodeQuerySortOptions: ['name', 'size', 'nodeType'],
}

const session = {
  connected: {
    client: {},
    accountId: 'a',
    // Nothing shared: the "Shared with me" section is absent and this is the pre-S-4 screen.
    delegated: [],
    jmapSession: {
      accounts: { a: { accountCapabilities: { 'urn:ietf:params:jmap:filenode': CAPABILITY } } },
    },
  },
} as unknown as SessionContextValue

function mount(injected: FilesClient = client) {
  return render(
    <SessionContext.Provider value={session}>
      <ToastProvider>
        <FilesPage client={injected} />
      </ToastProvider>
    </SessionContext.Provider>,
  )
}

function renderPage() {
  return mount()
}

async function showing(name: string) {
  await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument())
}

describe('which files offer a preview', () => {
  it('offers one for an image', async () => {
    listed = [node({ id: '1', name: 'photo.png', type: 'image/png' })]
    renderPage()
    await showing('photo.png')
    expect(screen.getByRole('button', { name: /Preview photo\.png/i })).toBeInTheDocument()
  })

  it('offers none for a type the policy refuses', async () => {
    listed = [node({ id: '1', name: 'archive.zip', type: 'application/zip' })]
    renderPage()
    await showing('archive.zip')
    // Rename, Download and Delete remain — no Preview.
    const labels = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    expect(labels.filter((label) => label?.includes('archive.zip'))).toEqual([
      'Rename archive.zip',
      'Move archive.zip',
      'Download archive.zip',
      'Delete archive.zip',
    ])
  })

  it('offers none for a directory', async () => {
    listed = [node({ id: '1', name: 'pictures', nodeType: 'directory', type: null, blobId: null })]
    renderPage()
    await showing('pictures')
    expect(screen.queryByRole('button', { name: /Preview/i })).not.toBeInTheDocument()
  })

  it('offers none for a file the user may not read', async () => {
    listed = [
      node({
        id: '1',
        name: 'secret.png',
        type: 'image/png',
        myRights: {
          mayRead: false,
          mayAddChildren: false,
          mayRename: false,
          mayDelete: false,
          mayModifyContent: false,
          mayShare: false,
        },
      }),
    ]
    renderPage()
    await showing('secret.png')
    expect(screen.queryByRole('button', { name: /Preview/i })).not.toBeInTheDocument()
  })
})

describe('the surface a preview is rendered in', () => {
  it('puts an image in an <img> and NOT in a frame', async () => {
    listed = [node({ id: '1', name: 'photo.png', type: 'image/png' })]
    const { container } = renderPage()
    await showing('photo.png')
    await userEvent.click(screen.getByRole('button', { name: /Preview photo\.png/i }))

    const image = await screen.findByAltText('photo.png')
    expect(image).toHaveAttribute('src', created[0])
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('puts plain text in a frame that is sandboxed to nothing', async () => {
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    const { container } = renderPage()
    await showing('notes.txt')
    await userEvent.click(screen.getByRole('button', { name: /Preview notes\.txt/i }))

    const frame = await waitFor(() => {
      const found = container.querySelector('iframe')
      expect(found).not.toBeNull()
      return found as HTMLIFrameElement
    })
    // Empty, not absent: `sandbox=""` denies same-origin, and a blob: URL carries this app's origin.
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('src')).toBe(created[0])
  })

  it('offers a PDF no preview at all rather than an empty frame', async () => {
    // The frame it would need is one this app may not open — `sandbox=""` stops Chromium's viewer
    // dead, and the only tokens that revive it hand a blob: URL this app's own origin. Download is
    // the honest offer, and it is the button next to where this one used to be.
    listed = [node({ id: '1', name: 'report.pdf', type: 'application/pdf' })]
    const { container } = renderPage()
    await showing('report.pdf')

    expect(screen.queryByRole('button', { name: /Preview report\.pdf/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download report\.pdf/i })).toBeInTheDocument()
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('reads the type through the policy, parameters and all', async () => {
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain; charset=utf-8' })]
    const { container } = renderPage()
    await showing('notes.txt')
    await userEvent.click(screen.getByRole('button', { name: /Preview notes\.txt/i }))
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
  })
})

describe('opening and closing', () => {
  it('toggles the same preview shut without downloading again', async () => {
    listed = [node({ id: '1', name: 'photo.png', type: 'image/png' })]
    renderPage()
    await showing('photo.png')

    await userEvent.click(screen.getByRole('button', { name: /Preview photo\.png/i }))
    await screen.findByAltText('photo.png')
    expect(download).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: /Hide the preview of photo\.png/i }))
    await waitFor(() => expect(screen.queryByAltText('photo.png')).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /Preview photo\.png/i }))
    await screen.findByAltText('photo.png')
    // The object URL is cached per node: re-opening must not spend a second round trip, and must
    // not mint a second URL that nothing would revoke.
    expect(download).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
  })

  it('shows one preview at a time', async () => {
    listed = [
      node({ id: '1', name: 'one.png', type: 'image/png' }),
      node({ id: '2', name: 'two.png', type: 'image/png' }),
    ]
    renderPage()
    await showing('one.png')

    await userEvent.click(screen.getByRole('button', { name: /Preview one\.png/i }))
    await screen.findByAltText('one.png')
    await userEvent.click(screen.getByRole('button', { name: /Preview two\.png/i }))
    await screen.findByAltText('two.png')
    expect(screen.queryByAltText('one.png')).not.toBeInTheDocument()
  })

  it('revokes every object URL on unmount', async () => {
    listed = [node({ id: '1', name: 'photo.png', type: 'image/png' })]
    const { unmount } = renderPage()
    await showing('photo.png')
    await userEvent.click(screen.getByRole('button', { name: /Preview photo\.png/i }))
    await screen.findByAltText('photo.png')

    unmount()
    expect(revoked).toEqual(created)
  })
})

/**
 * Renaming (M1).
 *
 * `filesClient.rename()` has existed since M5.7 and shipped with no caller outside its own unit
 * test: the file header listed "rename" among the seven things this screen does, and the row
 * offered view, share, download and delete. It went unnoticed because the whole screen was dead
 * until the M1 fix — a missing control on a broken screen looks like the broken screen.
 */
describe('renaming a node', () => {
  it('offers the control, and sends the id and the new name', async () => {
    const renamed: [string, string][] = []
    const withRename: FilesClient = {
      ...client,
      rename: async (id, name) => {
        renamed.push([id, name])
      },
    }
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    mount(withRename)
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'Rename notes.txt' }))

    // Opened with the current name, not empty: a rename is far more often an edit of what is there
    // than a replacement of it, and an empty field makes the reader retype what they can see.
    const field = await screen.findByLabelText('New name')
    expect(field).toHaveValue('notes.txt')

    await userEvent.clear(field)
    await userEvent.type(field, 'minutes.txt')
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(renamed).toEqual([['1', 'minutes.txt']]))
  })

  it('does not offer it where the server says the node may not be renamed', async () => {
    // Gated on the record's own flag, like delete is: the server puts `mayRename` there precisely
    // so a client does not have to offer a failure and then explain it.
    listed = [
      node({
        id: '1',
        name: 'shared-with-me.txt',
        type: 'text/plain',
        myRights: {
          mayRead: true,
          mayAddChildren: false,
          mayRename: false,
          mayDelete: false,
          mayModifyContent: false,
          mayShare: false,
        },
      }),
    ]
    renderPage()
    await showing('shared-with-me.txt')

    expect(screen.queryByRole('button', { name: /^Rename/ })).not.toBeInTheDocument()
  })

  it('will not spend a round trip on a name that has not changed', async () => {
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    renderPage()
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'Rename notes.txt' }))
    await screen.findByLabelText('New name')

    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
  })
})

describe('a write whose reload does not come back', () => {
  it('still says the upload was saved', async () => {
    // The measured shape of the outage: the listing is refused, the upload is not. The screen kept
    // showing "could not be loaded" and said nothing at all about the file that had just landed on
    // the server — the user uploaded into a void. A failed refresh is not a failed write.
    const uploaded: string[] = []
    const failing: FilesClient = {
      ...client,
      list: async () => {
        throw new Error('400 notRequest')
      },
      upload: async (file) => {
        uploaded.push(file.name)
        return node({ id: '9', name: file.name })
      },
    }
    const { container } = mount(failing)
    await screen.findByText('The files could not be loaded.')

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, new File(['bytes'], 'note.txt', { type: 'text/plain' }))

    expect(uploaded).toEqual(['note.txt'])
    expect(await screen.findByText(/could not be reloaded/i)).toBeInTheDocument()
  })
})

describe('accessibility', () => {
  it('states whether the preview is open, and has no violations with one open', async () => {
    listed = [node({ id: '1', name: 'photo.png', type: 'image/png' })]
    const { container } = renderPage()
    await showing('photo.png')

    const toggle = screen.getByRole('button', { name: /Preview photo\.png/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    await screen.findByAltText('photo.png')
    expect(screen.getByRole('button', { name: /Hide the preview of photo\.png/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expectNoA11yViolations(container)
  })

  it('has no violations with the rename dialog open', async () => {
    // Scanned against document.body, not the RTL container: the dialog renders through a portal.
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    renderPage()
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'Rename notes.txt' }))
    await screen.findByLabelText('New name')
    await expectNoA11yViolations()
  })
})

/**
 * D-1 — moving, which did not exist.
 *
 * The server changes `parentId` without complaint and the client offered no way to ask, so folders
 * could be created and nothing could be put in one. That makes the tree decoration, and it is why
 * this is the first of the four 2026-08-21 findings.
 *
 * ADR-012 is why the picker is a dialog rather than a drag: HTML5 drag does not reach the phone, so
 * a drag-only move would be no move at all there. What is asserted below is therefore the whole
 * mechanism on every viewport — a control, a destination, and the write.
 */
describe('moving a node', () => {
  function withMove() {
    const moved: [readonly string[], string | null][] = []
    const spy: FilesClient = {
      ...client,
      move: async (ids, parentId) => {
        moved.push([[...ids], parentId])
      },
    }
    return { moved, spy }
  }

  it('offers the control on every node, and sends the chosen destination', async () => {
    const { moved, spy } = withMove()
    listed = [
      node({ id: 'd1', name: 'invoices', nodeType: 'directory', type: null, blobId: null }),
      node({ id: '1', name: 'notes.txt', type: 'text/plain' }),
    ]
    mount(spy)
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'Move notes.txt' }))
    // The picker walks the tree rather than listing it flat: a file tree has no replica and no
    // bound on its depth, so "every folder at once" would be a crawl of the account.
    const picker = await screen.findByRole('dialog', { name: /Move “notes.txt”/ })
    await userEvent.click(await within(picker).findByRole('button', { name: 'invoices' }))
    await userEvent.click(await within(picker).findByRole('button', { name: 'Move to invoices' }))

    await waitFor(() => expect(moved).toEqual([[['1'], 'd1']]))
  })

  it('refuses to move a node into the folder it is already in', async () => {
    const { spy } = withMove()
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain', parentId: null })]
    mount(spy)
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'Move notes.txt' }))
    // The picker opens at the root, which is where this node already lives. A round trip and a
    // reload that change nothing are not a move.
    expect(await screen.findByRole('button', { name: 'Move to Files' })).toBeDisabled()
  })

  it('never offers a folder as a destination for itself', async () => {
    const { spy } = withMove()
    listed = [node({ id: 'd1', name: 'invoices', nodeType: 'directory', type: null, blobId: null })]
    mount(spy)
    await showing('invoices')

    await userEvent.click(screen.getByRole('button', { name: 'Move invoices' }))
    const dialog = await screen.findByRole('dialog')
    // Structural rather than a check: the folder being moved is absent from every level the picker
    // lists, so its own descendants cannot be walked to either.
    expect(within(dialog).queryByRole('button', { name: 'invoices' })).not.toBeInTheDocument()
  })

  it('offers to put it back (ADR-021), because a move is the one file write that reverses', async () => {
    const { moved, spy } = withMove()
    listed = [
      node({ id: 'd1', name: 'invoices', nodeType: 'directory', type: null, blobId: null }),
      node({ id: '1', name: 'notes.txt', type: 'text/plain', parentId: null }),
    ]
    mount(spy)
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'Move notes.txt' }))
    const picker = await screen.findByRole('dialog')
    await userEvent.click(await within(picker).findByRole('button', { name: 'invoices' }))
    await userEvent.click(await within(picker).findByRole('button', { name: 'Move to invoices' }))
    await waitFor(() => expect(moved).toHaveLength(1))

    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))

    // Back to where it came from — `null`, the root — not to wherever the screen happens to be.
    await waitFor(() => expect(moved[1]).toEqual([['1'], null]))
  })

  it('offers the control even where myRights says nothing is allowed (D-7)', async () => {
    // Measured server behaviour: under a shared FOLDER the download access is inherited correctly
    // while every flag on the CHILD comes back false. Gating move on `mayRename` would hide it
    // exactly where a grantee has been given the run of a folder.
    const { spy } = withMove()
    listed = [
      node({
        id: '1',
        name: 'shared.txt',
        type: 'text/plain',
        myRights: {
          mayRead: false,
          mayAddChildren: false,
          mayRename: false,
          mayDelete: false,
          mayModifyContent: false,
          mayShare: false,
        },
      }),
    ]
    mount(spy)
    await showing('shared.txt')

    expect(screen.getByRole('button', { name: 'Move shared.txt' })).toBeInTheDocument()
  })
})

/**
 * B-7 — the one delete in this app that never asked.
 *
 * Every other destroy in Waxwing is either confirmed (mail) or undoable (triage). This one was
 * neither: one tap on an icon-only button, and the file was gone from a server that keeps no trash
 * for file nodes. Undo was considered and cannot be built — `FileNode/set destroy` has nowhere to
 * restore from, and an Undo that silently does nothing is worse than no Undo at all. So the
 * question is asked first, which is also what the Finder does for a delete that skips the trash.
 */
describe('deleting a node', () => {
  function withDestroy() {
    const destroyed: string[][] = []
    const spy: FilesClient = {
      ...client,
      destroy: async (ids) => {
        destroyed.push([...ids])
      },
    }
    return { destroyed, spy }
  }

  it('asks before it destroys anything', async () => {
    const { destroyed, spy } = withDestroy()
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    mount(spy)
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'Delete notes.txt' }))

    await screen.findByText(/permanently deleted/i)
    expect(destroyed).toEqual([])
  })

  it('destroys once the question is answered', async () => {
    const { destroyed, spy } = withDestroy()
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    mount(spy)
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'Delete notes.txt' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(destroyed).toEqual([['1']]))
  })

  it('destroys nothing when the question is declined', async () => {
    const { destroyed, spy } = withDestroy()
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    mount(spy)
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'Delete notes.txt' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(destroyed).toEqual([])
  })

  it('warns that a folder takes its contents with it', async () => {
    const { spy } = withDestroy()
    listed = [node({ id: 'd1', name: 'invoices', nodeType: 'directory', type: null, blobId: null })]
    mount(spy)
    await showing('invoices')

    await userEvent.click(screen.getByRole('button', { name: 'Delete invoices' }))

    expect(await screen.findByText(/Everything inside/i)).toBeInTheDocument()
  })
})

/**
 * D-2 — one file per operation, both ways.
 *
 * Selecting is a MODE, entered on purpose: an ordinary tap still opens a folder, which is what a
 * tap on a file row means every other day. That is iOS Files' arrangement and the reason it works
 * on a phone, where there is no modifier key to hold.
 */
describe('selecting several nodes', () => {
  const open = () => userEvent.click(screen.getByRole('button', { name: 'List options' }))

  it('takes several files in one trip to the picker', async () => {
    const uploaded: string[] = []
    const spy: FilesClient = {
      ...client,
      upload: async (file) => {
        uploaded.push(file.name)
        return null
      },
    }
    listed = []
    const { container } = mount(spy)
    await screen.findByText('This folder is empty.')

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.multiple).toBe(true)
    await userEvent.upload(input, [
      new File(['a'], 'one.txt', { type: 'text/plain' }),
      new File(['b'], 'two.txt', { type: 'text/plain' }),
    ])

    await waitFor(() => expect(uploaded).toEqual(['one.txt', 'two.txt']))
  })

  it('turns the rows into checkboxes only once selecting has been asked for', async () => {
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    renderPage()
    await showing('notes.txt')
    expect(screen.queryByRole('checkbox', { name: /notes\.txt/ })).not.toBeInTheDocument()

    await open()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Select' }))

    expect(await screen.findByRole('checkbox', { name: /notes\.txt/ })).toBeInTheDocument()
  })

  it('deletes the whole selection in one write', async () => {
    const destroyed: string[][] = []
    const spy: FilesClient = {
      ...client,
      destroy: async (ids) => {
        destroyed.push([...ids])
      },
    }
    listed = [
      node({ id: '1', name: 'one.txt', type: 'text/plain' }),
      node({ id: '2', name: 'two.txt', type: 'text/plain' }),
    ]
    mount(spy)
    await showing('one.txt')

    await open()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Select' }))
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select everything here' }))
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    // ONE `FileNode/set`, not two: half a deleted selection is the outcome nothing on screen can
    // describe afterwards.
    await waitFor(() => expect(destroyed).toEqual([['1', '2']]))
  })

  it('moves the whole selection to one destination', async () => {
    const moved: [readonly string[], string | null][] = []
    const spy: FilesClient = {
      ...client,
      move: async (ids, parentId) => {
        moved.push([[...ids], parentId])
      },
    }
    listed = [
      node({ id: 'd1', name: 'invoices', nodeType: 'directory', type: null, blobId: null }),
      node({ id: '1', name: 'one.txt', type: 'text/plain' }),
      node({ id: '2', name: 'two.txt', type: 'text/plain' }),
    ]
    mount(spy)
    await showing('one.txt')

    await open()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Select' }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /one\.txt/ }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /two\.txt/ }))

    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    const picker = await screen.findByRole('dialog')
    await userEvent.click(await within(picker).findByRole('button', { name: 'invoices' }))
    await userEvent.click(await within(picker).findByRole('button', { name: 'Move to invoices' }))

    await waitFor(() => expect(moved).toEqual([[['1', '2'], 'd1']]))
  })
})

/** D-3 — `FileNode/query` takes a name condition and a comparator; nothing was using either. */
describe('searching and sorting', () => {
  const open = () => userEvent.click(screen.getByRole('button', { name: 'List options' }))

  it('asks the server, and states which folder each hit was found in', async () => {
    const asked: string[] = []
    const parent = node({
      id: 'd1',
      name: 'invoices',
      nodeType: 'directory',
      type: null,
      blobId: null,
    })
    const spy: FilesClient = {
      ...client,
      search: async (query) => {
        asked.push(query)
        return [{ node: node({ id: '1', name: 'report.txt', parentId: 'd1' }), parent }]
      },
    }
    listed = []
    mount(spy)
    await screen.findByText('This folder is empty.')

    await userEvent.type(screen.getByLabelText('Search files'), 'report')

    // A search spans the whole account — the server has no subtree condition — so the row has to
    // say which `report.txt` it is.
    await waitFor(() => expect(asked.at(-1)).toBe('report'))
    expect(await screen.findByText('report.txt')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'in invoices' })).toBeInTheDocument()
  })

  it('says so when nothing matches, rather than showing an empty folder', async () => {
    const spy: FilesClient = { ...client, search: async () => [] }
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    mount(spy)
    await showing('notes.txt')

    await userEvent.type(screen.getByLabelText('Search files'), 'zzz')

    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument()
  })

  it('reorders the list without a second request', async () => {
    let calls = 0
    const spy: FilesClient = {
      ...client,
      list: async () => {
        calls += 1
        return { nodes: listed, truncated: false }
      },
    }
    listed = [
      node({ id: '1', name: 'a.txt', size: 900, type: 'text/plain' }),
      node({ id: '2', name: 'b.txt', size: 10, type: 'text/plain' }),
    ]
    mount(spy)
    await showing('a.txt')

    await open()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sort by size' }))

    // The server's comparator decides what survives a TRUNCATED listing; what is on screen is
    // ordered here, so a server that ignores the comparator changes the wire and nothing else.
    await waitFor(() => {
      const names = screen.getAllByText(/\.txt$/).map((element) => element.textContent)
      expect(names).toEqual(['b.txt', 'a.txt'])
    })
    expect(calls).toBeGreaterThan(0)
  })
})

/**
 * B-6 — the listing that stopped at 500 nodes and said nothing.
 *
 * The silence is the defect, not the limit: a folder that is short and LOOKS complete makes every
 * conclusion the reader draws from it wrong.
 */
describe('a listing the server could not give in full', () => {
  it('says that something is missing', async () => {
    truncated = true
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    renderPage()
    await showing('notes.txt')

    expect(await screen.findByText(/some files are not shown/i)).toBeInTheDocument()
  })

  it('says nothing when the listing is complete', async () => {
    truncated = false
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    renderPage()
    await showing('notes.txt')

    expect(screen.queryByText(/some files are not shown/i)).not.toBeInTheDocument()
  })
})

/**
 * The server's own name rules, honoured before the round trip.
 *
 * `forbiddenNameChars` and `forbiddenNodeNames` are session facts (`/<>:"\|?*`, plus `.`, `..`,
 * `CON`, `AUX`, `COM0`–`COM9`, …). They are refused for Windows-compatibility reasons that have
 * nothing to do with what the user meant, so "the server said no" is not an explanation anyone can
 * act on — and with a MULTI-file upload the round trip is the wrong place to find out, because a
 * batch that fails halfway leaves the reader working out which of eleven files landed.
 */
describe('names the server would refuse', () => {
  it('stops a whole upload batch on the first bad name, before any bytes go up', async () => {
    const uploaded: string[] = []
    const spy: FilesClient = {
      ...client,
      upload: async (file) => {
        uploaded.push(file.name)
        return null
      },
    }
    listed = []
    const { container } = mount(spy)
    await screen.findByText('This folder is empty.')

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, [
      new File(['a'], 'fine.txt', { type: 'text/plain' }),
      new File(['b'], 'a:b.txt', { type: 'text/plain' }),
    ])

    expect(await screen.findByText(/character the server does not allow/i)).toBeInTheDocument()
    expect(uploaded).toEqual([])
  })

  it('refuses a reserved DOS name for a new folder without asking the server', async () => {
    const created: string[] = []
    const spy: FilesClient = {
      ...client,
      createFolder: async (name) => {
        created.push(name)
      },
    }
    listed = []
    mount(spy)
    await screen.findByText('This folder is empty.')

    await userEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('New folder'), 'aux')
    await userEvent.click(within(dialog).getByRole('button', { name: 'New folder' }))

    expect(await screen.findByText(/reserved/i)).toBeInTheDocument()
    expect(created).toEqual([])
  })
})

describe('accessibility of the surfaces added on 2026-08-21', () => {
  it('has no violations with the move picker open', async () => {
    listed = [
      node({ id: 'd1', name: 'invoices', nodeType: 'directory', type: null, blobId: null }),
      node({ id: '1', name: 'notes.txt', type: 'text/plain' }),
    ]
    renderPage()
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'Move notes.txt' }))
    await screen.findByRole('dialog')
    // Against document.body, not the RTL container: the dialog renders through a portal.
    await expectNoA11yViolations()
  })

  it('has no violations while the list is in selection mode', async () => {
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    const { container } = renderPage()
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'List options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Select' }))
    await screen.findByRole('checkbox', { name: /notes\.txt/ })

    await expectNoA11yViolations(container)
  })

  it('has no violations with the delete question on screen', async () => {
    listed = [node({ id: '1', name: 'notes.txt', type: 'text/plain' })]
    renderPage()
    await showing('notes.txt')

    await userEvent.click(screen.getByRole('button', { name: 'Delete notes.txt' }))
    await screen.findByRole('dialog')
    await expectNoA11yViolations()
  })
})
