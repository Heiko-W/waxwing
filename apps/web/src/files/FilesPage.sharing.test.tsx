/**
 * Other people's files, in the same screen as your own (S-4).
 *
 * Until this, the Files screen was hard-wired to `connected.accountId`: a folder someone shared
 * with you appeared in your session, was fully readable over JMAP, and had no way in from the
 * client at all. It now grows a "Shared with me" section at the root, the way iCloud Drive and the
 * mail rail both do it — no account switcher, no separate screen.
 *
 * What the section may NOT do is the point of the first test, and it rests on a measurement against
 * Stalwart v0.16.18 (2026-08-21): a share of ANY single object makes the whole owning account
 * appear in the session with all seventeen capabilities, `urn:ietf:params:jmap:filenode` included.
 * Alice shared one ADDRESS BOOK with carol and `FileNode/get` on her account still answered
 * `forbidden`. So the capability list cannot decide this and never could; `connected.delegated`
 * carries the probe's answer, and a section is drawn from that or not at all.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileNode, FileNodeCapability, Id } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionContext } from '../app/session/context'
import type { DelegatedAccount, SessionContextValue } from '../app/session/types'
import { putFileNodes, type ReplicaDb, ReplicaProvider, setFileTreeState } from '../sync'
import { clearEngines, type SyncEngine, setEngineFor } from '../sync/engine'
import { freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import FilesPage from './FilesPage'
import type { FilesClient } from './files-client'

const CAPABILITY: FileNodeCapability = {
  maxFileNodeDepth: null,
  maxSizeFileNodeName: 255,
  forbiddenNameChars: '/<>:"\\|?*',
  forbiddenNodeNames: ['.', '..'],
  fileNodeQuerySortOptions: ['name', 'size', 'nodeType'],
}

function node(id: string, name: string): FileNode {
  return {
    id,
    name,
    parentId: null,
    nodeType: 'file',
    blobId: `blob-${id}`,
    target: null,
    size: 8,
    type: 'text/plain',
    created: '2026-08-01T00:00:00Z',
    modified: '2026-08-01T00:00:00Z',
    accessed: '2026-08-01T00:00:00Z',
    changed: '2026-08-01T00:00:00Z',
    executable: false,
    isSubscribed: true,
    myRights: {
      mayRead: true,
      mayAddChildren: false,
      mayRename: false,
      mayDelete: false,
      mayModifyContent: false,
      mayShare: false,
    },
    shareWith: {},
    role: null,
  }
}

/** Carol, as the probe reported her: files served, mail and contacts refused. */
function carol(over: Partial<DelegatedAccount['areas']> = {}): DelegatedAccount {
  return {
    id: 'd',
    name: 'carol@waxwing.test',
    isPersonal: false,
    isReadOnly: false,
    areas: { mail: 'denied', contacts: 'denied', files: 'granted', ...over },
  }
}

function session(delegated: readonly DelegatedAccount[]): SessionContextValue {
  return {
    connected: {
      client: {},
      accountId: 'b',
      delegated,
      jmapSession: {
        accounts: { b: { accountCapabilities: { 'urn:ietf:params:jmap:filenode': CAPABILITY } } },
      },
    },
  } as unknown as SessionContextValue
}

/** One client per account, so a listing can be traced back to the account it was asked of. */
function clients(byAccount: Readonly<Record<Id, readonly FileNode[]>>) {
  const asked: Id[] = []
  const clientFor = (accountId: Id): FilesClient =>
    ({
      list: async () => {
        asked.push(accountId)
        return { nodes: byAccount[accountId] ?? [], truncated: false }
      },
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
    }) satisfies FilesClient
  return { clientFor, asked }
}

/**
 * The OWN account ('b') is the one the sync engine replicates, so its files are seeded into Dexie
 * (D-4); carol's ('d') are not, and come from `clientFor('d')` over the wire. That split is the
 * subject of these tests as much as the section is: reading the replica for somebody else's account
 * would show the reader their own files under carol's name.
 */
const SELF = 'b'
let db: ReplicaDb

afterEach(async () => {
  clearEngines()
  cleanup()
  await db?.delete()
})

function render_(
  delegated: readonly DelegatedAccount[],
  byAccount: Record<Id, readonly FileNode[]>,
) {
  const { clientFor, asked } = clients(byAccount)
  db = freshDb()
  void (async () => {
    await putFileNodes(db, SELF, [...(byAccount[SELF] ?? [])])
    await setFileTreeState(db, SELF, { syncedAt: 1, truncated: false })
  })().catch(() => {})
  setEngineFor(SELF, {
    accountId: SELF,
    refreshFileTree: async () => true,
  } as unknown as SyncEngine)
  const view = render(
    <SessionContext.Provider value={session(delegated)}>
      <ToastProvider>
        <ReplicaProvider accountId={SELF} db={db}>
          <FilesPage clientFor={clientFor} />
        </ReplicaProvider>
      </ToastProvider>
    </SessionContext.Provider>,
  )
  return { asked, view }
}

function mount(delegated: readonly DelegatedAccount[], byAccount: Record<Id, readonly FileNode[]>) {
  return { asked: render_(delegated, byAccount).asked }
}

const OWN = { b: [node('n1', 'my-notes.txt')], d: [node('n2', 'projekt.pdf')] }

describe('the "Shared with me" section', () => {
  it('THE ONE: an account the probe found no files in gets no row', async () => {
    // The measured false positive: carol is in the session with every capability, because she
    // shared something — but not files. Deciding from `accountCapabilities` drew this row.
    mount([carol({ files: 'denied' })], OWN)
    await screen.findByText('my-notes.txt')
    expect(screen.queryByRole('region', { name: 'Shared with me' })).not.toBeInTheDocument()
    expect(screen.queryByText('carol@waxwing.test')).not.toBeInTheDocument()
  })

  it('lists an account the server did serve, and opens it', async () => {
    const user = userEvent.setup()
    const { asked } = mount([carol()], OWN)
    await screen.findByText('my-notes.txt')

    const region = screen.getByRole('region', { name: 'Shared with me' })
    const open = await within(region).findByRole('button', {
      name: /Open the files carol@waxwing\.test shared with you/,
    })
    await user.click(open)

    // The listing is now carol's, asked of carol's account — not a filtered view of the user's own.
    await waitFor(() => expect(screen.getByText('projekt.pdf')).toBeInTheDocument())
    expect(asked).toContain('d')
    expect(screen.queryByText('my-notes.txt')).not.toBeInTheDocument()
  })

  it('says whose files these are, and offers the way back', async () => {
    const user = userEvent.setup()
    mount([carol()], OWN)
    await screen.findByText('my-notes.txt')
    await user.click(screen.getByRole('button', { name: /Open the files carol/ }))

    // The heading is the account, so the reader is never in doubt about which root they are in —
    // and the trail starts one step further back, at their own.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('carol@waxwing.test'),
    )
    const crumbs = screen.getByRole('navigation', { name: 'Folder path' })
    await user.click(within(crumbs).getByRole('button', { name: 'Files' }))

    await waitFor(() => expect(screen.getByText('my-notes.txt')).toBeInTheDocument())
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Files')
  })

  it('is not repeated inside a folder or over a search', async () => {
    const user = userEvent.setup()
    mount([carol()], OWN)
    await screen.findByText('my-notes.txt')
    expect(screen.getByRole('region', { name: 'Shared with me' })).toBeInTheDocument()

    // A place has one spot in a hierarchy. Searching spans the whole account, so a "Shared with me"
    // heading over the hits would be claiming those hits came from somewhere they did not.
    await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'notes')
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Shared with me' })).not.toBeInTheDocument(),
    )
  })

  it('has no a11y violations with a shared account on screen', async () => {
    const { view } = render_([carol()], OWN)
    await screen.findByText('my-notes.txt')
    await expectNoA11yViolations(view.container)
  })
})

// ── The two hazards that only exist BECAUSE two accounts share one screen ────────────────────

/** Same node, different account: an image row, so the row offers Preview and Download. */
function image(id: string, name: string): FileNode {
  return { ...node(id, name), type: 'image/png' }
}

function folder(id: string, name: string, parentId: Id | null = null): FileNode {
  return { ...node(id, name), nodeType: 'directory', type: null, blobId: null, parentId }
}

describe('the object-URL cache across accounts (R-22)', () => {
  let seq = 0
  beforeEach(() => {
    seq = 0
    URL.createObjectURL = vi.fn(() => `blob:test/${++seq}`)
    URL.revokeObjectURL = vi.fn()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Stalwart hands out short, PER-ACCOUNT node ids, so `n1` exists in almost every account — and
   * the blob id behind it is just as short. The cache was keyed on the node id alone, so after
   * previewing your own `n1` the same key answered for carol's, and her file was shown, and
   * downloaded, as your bytes.
   */
  it('does not serve one account’s bytes for another account’s file of the same id', async () => {
    const user = userEvent.setup()
    const downloaded: string[] = []
    const byAccount: Record<Id, readonly FileNode[]> = {
      b: [image('n1', 'my-photo.png')],
      d: [image('n1', 'carol-photo.png')],
    }
    const clientFor = (accountId: Id): FilesClient =>
      ({
        list: async () => ({ nodes: byAccount[accountId] ?? [], truncated: false }),
        search: async () => [],
        ancestors: async () => [],
        upload: async () => null,
        createFolder: async () => {},
        rename: async () => {},
        move: async () => {},
        destroy: async () => {},
        download: async (target: FileNode) => {
          downloaded.push(`${accountId}:${target.name}`)
          return new Blob([`${accountId}:${target.name}`])
        },
        searchPrincipals: async () => [],
        setShareWith: async () => {},
      }) satisfies FilesClient

    db = freshDb()
    void (async () => {
      await putFileNodes(db, SELF, [...(byAccount[SELF] ?? [])])
      await setFileTreeState(db, SELF, { syncedAt: 1, truncated: false })
    })().catch(() => {})
    setEngineFor(SELF, {
      accountId: SELF,
      refreshFileTree: async () => true,
    } as unknown as SyncEngine)
    render(
      <SessionContext.Provider value={session([carol()])}>
        <ToastProvider>
          <ReplicaProvider accountId={SELF} db={db}>
            <FilesPage clientFor={clientFor} />
          </ReplicaProvider>
        </ToastProvider>
      </SessionContext.Provider>,
    )

    await screen.findByText('my-photo.png')
    await user.click(screen.getByRole('button', { name: 'Preview my-photo.png' }))
    const mine = await screen.findByRole('img', { name: 'my-photo.png' })
    const mineSrc = mine.getAttribute('src')

    await user.click(screen.getByRole('button', { name: /Open the files carol/ }))
    await screen.findByText('carol-photo.png')
    await user.click(screen.getByRole('button', { name: 'Preview carol-photo.png' }))
    const hers = await screen.findByRole('img', { name: 'carol-photo.png' })

    // Her file was fetched from HER account, and it is not the URL made for yours.
    expect(downloaded).toEqual(['b:my-photo.png', 'd:carol-photo.png'])
    expect(hers.getAttribute('src')).not.toBe(mineSrc)
  })
})

describe('a late listing from a folder that has been left (R-23)', () => {
  it('does not overwrite the listing of the folder on screen', async () => {
    const user = userEvent.setup()
    // A holder rather than a bare `let`: TypeScript narrows a variable only assigned
    // inside a closure to `null` at every use site.
    const release: { fn: (() => void) | null } = { fn: null }
    const carolNodes: Record<string, FileNode[]> = {
      root: [folder('r1', 'Reports')],
      r1: [image('n7', 'inner.png')],
    }
    const clientFor = (accountId: Id): FilesClient =>
      ({
        list: async (parentId: Id | null) => {
          if (accountId !== 'd') return { nodes: [], truncated: false }
          if (parentId === 'r1') {
            // The slow one. It answers only once the test says so — after the reader has walked
            // back out, which is exactly the ordering the finding describes.
            await new Promise<void>((resolve) => {
              release.fn = resolve
            })
            return { nodes: carolNodes.r1 ?? [], truncated: false }
          }
          return { nodes: carolNodes.root ?? [], truncated: false }
        },
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
      }) satisfies FilesClient

    db = freshDb()
    void (async () => {
      await putFileNodes(db, SELF, [node('own', 'my-notes.txt')])
      await setFileTreeState(db, SELF, { syncedAt: 1, truncated: false })
    })().catch(() => {})
    setEngineFor(SELF, {
      accountId: SELF,
      refreshFileTree: async () => true,
    } as unknown as SyncEngine)
    render(
      <SessionContext.Provider value={session([carol()])}>
        <ToastProvider>
          <ReplicaProvider accountId={SELF} db={db}>
            <FilesPage clientFor={clientFor} />
          </ReplicaProvider>
        </ToastProvider>
      </SessionContext.Provider>,
    )

    await screen.findByText('my-notes.txt')
    await user.click(screen.getByRole('button', { name: /Open the files carol/ }))
    await screen.findByText('Reports')

    // Into the slow folder…
    await user.click(screen.getByRole('button', { name: 'Reports' }))
    await waitFor(() => expect(release.fn).not.toBeNull())
    // …and straight back out, which answers first.
    const crumbs = screen.getByRole('navigation', { name: 'Folder path' })
    await user.click(within(crumbs).getByRole('button', { name: 'carol@waxwing.test' }))
    await screen.findByText('Reports')

    // Now the folder answers, into a screen that has moved on.
    release.fn?.()
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('carol@waxwing.test'),
    )
    await waitFor(() => expect(screen.getByText('Reports')).toBeInTheDocument())
    expect(screen.queryByText('inner.png')).not.toBeInTheDocument()
  })
})
