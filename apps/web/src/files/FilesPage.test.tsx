/**
 * The file browser's inline preview (M5.17).
 *
 * The behaviour worth pinning is what the preview REFUSES: a type outside `preview-policy.ts` gets
 * no button at all, and nothing that is previewed reaches a surface that could run it. The two
 * assertions on `sandbox` and on the absence of a frame for images are the ones that fail if
 * someone later "simplifies" the render into a single `<iframe>` for everything.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileNode } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import FilesPage from './FilesPage'
import type { FilesClient } from './files-client'

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

const client: FilesClient = {
  list: async () => listed,
  upload: async () => null,
  createFolder: async () => {},
  rename: async () => {},
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
})

function renderPage() {
  return render(
    <ToastProvider>
      <FilesPage client={client} />
    </ToastProvider>,
  )
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
    render(
      <ToastProvider>
        <FilesPage client={withRename} />
      </ToastProvider>,
    )
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
    const { container } = render(
      <ToastProvider>
        <FilesPage client={failing} />
      </ToastProvider>,
    )
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
