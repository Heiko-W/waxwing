/**
 * What the file listing re-renders, and when (R-61).
 *
 * The finding is a cost, not a wrong answer, so the assertion has to be a COUNT rather than a
 * screenshot. Every file row renders its size cell exactly once, so a counting `formatBytes` is a
 * render counter for the list — one call per row per render, in select mode as well as out of it.
 *
 * Two numbers matter, and they are the two the finding names: a keystroke in the search box (the
 * rows cannot change until the 250 ms debounce lands, so it must not reach them at all) and a
 * checkbox (which changes exactly one row). Measured in jsdom before this: 43 ms per keystroke
 * over 100 rows, 135 ms over 300, 455 ms over 1 000; a checkbox 24 / 63 / 154 ms.
 *
 * Deliberately NOT a virtualisation test. The list is not virtualised — see the note on `FileRow`.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileNode, FileNodeCapability } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionContext } from '../app/session/context'
import type { SessionContextValue } from '../app/session/types'
import { putFileNodes, type ReplicaDb, ReplicaProvider, setFileTreeState } from '../sync'
import { clearEngines, type SyncEngine, setEngineFor } from '../sync/engine'
import { freshDb } from '../sync/test-utils'
import { ToastProvider } from '../ui'
import FilesPage from './FilesPage'
import type { FilesClient } from './files-client'

/** One tick per rendered file row — `vi.hoisted` because `vi.mock`'s factory is hoisted too. */
const counter = vi.hoisted(() => ({ rows: 0 }))
vi.mock('../i18n/formatters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n/formatters')>()
  return {
    ...actual,
    formatBytes: (bytes: number) => {
      counter.rows += 1
      return actual.formatBytes(bytes)
    },
  }
})

const CAPABILITY: FileNodeCapability = {
  maxFileNodeDepth: null,
  maxSizeFileNodeName: 255,
  forbiddenNameChars: '/<>:"\\|?*',
  forbiddenNodeNames: ['.', '..'],
  fileNodeQuerySortOptions: ['name', 'size', 'nodeType'],
}

const session = {
  connected: {
    client: {},
    accountId: 'a',
    delegated: [],
    jmapSession: {
      accounts: { a: { accountCapabilities: { 'urn:ietf:params:jmap:filenode': CAPABILITY } } },
    },
  },
} as unknown as SessionContextValue

const client: FilesClient = {
  list: async () => ({ nodes: [], truncated: false }),
  search: async () => [],
  ancestors: async () => [],
  upload: async () => null,
  createFolder: async () => {},
  rename: async () => {},
  move: async () => {},
  destroy: async () => {},
  download: async () => new Blob(),
  searchPrincipals: async () => [],
  setShareWith: async () => {},
}

const ROWS = 20

function node(i: number): FileNode {
  return {
    id: `n${i}`,
    name: `report-${String(i).padStart(2, '0')}.txt`,
    parentId: null,
    nodeType: 'file',
    blobId: `blob-${i}`,
    target: null,
    size: 1024 + i,
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
      mayShare: false,
    },
    shareWith: {},
    role: null,
  }
}

let db: ReplicaDb

beforeEach(() => {
  counter.rows = 0
})

afterEach(async () => {
  clearEngines()
  cleanup()
  await db?.delete()
})

async function mountList(): Promise<void> {
  db = freshDb()
  await putFileNodes(
    db,
    'a',
    Array.from({ length: ROWS }, (_, i) => node(i)),
  )
  await setFileTreeState(db, 'a', { syncedAt: 1, truncated: false })
  setEngineFor('a', {
    accountId: 'a',
    refreshFileTree: async () => true,
  } as unknown as SyncEngine)
  render(
    <SessionContext.Provider value={session}>
      <ToastProvider>
        <ReplicaProvider accountId="a" db={db}>
          <FilesPage client={client} />
        </ReplicaProvider>
      </ToastProvider>
    </SessionContext.Provider>,
  )
  await screen.findByText('report-00.txt')
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(ROWS))
}

describe('re-render cost of the file listing (R-61)', () => {
  it('renders no row again while the search box is being typed into', async () => {
    await mountList()
    counter.rows = 0

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search files' }), 'rep')

    // The letters live in the field, not in the screen — nothing below it has heard about them.
    expect(counter.rows).toBe(0)
  })

  it('renders ONE row again when its checkbox is ticked', async () => {
    await mountList()
    await userEvent.click(screen.getByRole('button', { name: 'List options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Select' }))
    // Entering the mode is a real change to every row; the count that matters starts after it.
    counter.rows = 0

    const boxes = await screen.findAllByRole('checkbox')
    await userEvent.click(boxes[1] as HTMLElement)

    expect(counter.rows).toBe(1)
  })
})
