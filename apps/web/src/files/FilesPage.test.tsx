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
    // Only Download and Delete remain — no Preview.
    const labels = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    expect(labels.filter((label) => label?.includes('archive.zip'))).toHaveLength(2)
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

  it('puts a PDF in a frame that is sandboxed to nothing', async () => {
    listed = [node({ id: '1', name: 'report.pdf', type: 'application/pdf' })]
    const { container } = renderPage()
    await showing('report.pdf')
    await userEvent.click(screen.getByRole('button', { name: /Preview report\.pdf/i }))

    const frame = await waitFor(() => {
      const found = container.querySelector('iframe')
      expect(found).not.toBeNull()
      return found as HTMLIFrameElement
    })
    // Empty, not absent: `sandbox=""` denies same-origin, and a blob: URL carries this app's origin.
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('src')).toBe(created[0])
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
})
