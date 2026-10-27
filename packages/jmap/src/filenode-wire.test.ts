/**
 * Both dialects of `FileNode`, as measured on one fixture on 2026-10-27: Stalwart 0.16.27 and 1.0.0.
 * The nodes below are verbatim from `FileNode/get` on each — a directory `Docs` holding `a.txt` — not
 * what the draft says they should look like.
 */

import { describe, expect, it } from 'vitest'
import {
  FULL_FILE_RIGHTS,
  fileNodeWire,
  NO_FILE_RIGHTS,
  newDirectory,
  newFile,
  normalizeFileNode,
  normalizeFileNodes,
} from './filenode-wire'

const RIGHTS = {
  mayRead: true,
  mayAddChildren: true,
  mayRename: true,
  mayDelete: true,
  mayModifyContent: true,
  mayShare: true,
}

/** 0.16.27: every property present, absent values as `null`, a directory with `size: null`. */
const V016_DIRECTORY = {
  id: 'b',
  parentId: null,
  nodeType: 'directory',
  blobId: null,
  target: null,
  size: null,
  name: 'Docs',
  type: null,
  created: '2026-10-27T15:49:05Z',
  modified: '2026-10-27T15:49:05Z',
  accessed: '2026-10-27T15:49:05Z',
  changed: '2026-10-27T15:49:05Z',
  executable: null,
  isSubscribed: true,
  myRights: RIGHTS,
  shareWith: {},
  role: null,
}

const V016_FILE = {
  ...V016_DIRECTORY,
  id: 'c',
  parentId: 'b',
  nodeType: 'file',
  blobId: 'cdofutw9qjalagasibjmgmbha7lpsz9ruy0ukjiklql0gaaoqizvkaimai',
  size: 12,
  name: 'a.txt',
  type: 'text/plain',
  executable: false,
}

/** 1.0.0: typed, absent values missing, `shareWith: null`, a seventh right. */
const V1_DIRECTORY = {
  id: 'b',
  parentId: null,
  '@type': 'Directory',
  name: 'Docs',
  created: '2026-10-27T15:49:05Z',
  modified: '2026-10-27T15:49:05Z',
  accessed: '2026-10-27T15:49:05Z',
  changed: '2026-10-27T15:49:05Z',
  isSubscribed: true,
  myRights: { ...RIGHTS, maySetMetadata: true },
  shareWith: null,
  role: null,
}

const V1_FILE = {
  id: 'c',
  parentId: 'b',
  '@type': 'File',
  blobId: 'cdofutw9qjalagasibjmgmbha7lpsz9ruy0ukjiklql0gaaoqizvkaimai',
  size: 12,
  name: 'a.txt',
  mediaType: 'text/plain',
  created: '2026-10-27T15:49:05Z',
  modified: '2026-10-27T15:49:05Z',
  accessed: '2026-10-27T15:49:05Z',
  changed: '2026-10-27T15:49:05Z',
  executable: false,
}

describe('fileNodeWire', () => {
  it('reads the typed form off the capability 1.0 advertises', () => {
    expect(fileNodeWire({ supportedNodeTypes: ['Directory', 'File', 'SymLink'] })).toBe('typed')
  })

  it('treats a capability without it as 0.16 — the key is the signal, its content is not', () => {
    expect(fileNodeWire({ maxFileNodeDepth: 64 })).toBe('legacy')
    expect(fileNodeWire({ supportedNodeTypes: 'Directory' })).toBe('legacy')
  })

  it('does not throw on a missing capability', () => {
    expect(fileNodeWire(undefined)).toBe('legacy')
    expect(fileNodeWire(null)).toBe('legacy')
  })
})

describe('normalizeFileNode', () => {
  it('leaves a 0.16 file as it was', () => {
    expect(normalizeFileNode(V016_FILE)).toEqual(V016_FILE)
  })

  it('maps 1.0’s typed file onto the shape the app reads', () => {
    const node = normalizeFileNode(V1_FILE)
    expect(node.nodeType).toBe('file')
    expect(node.type).toBe('text/plain')
    expect(node.blobId).toBe(V1_FILE.blobId)
    expect(node.size).toBe(12)
    expect(node).not.toHaveProperty('@type')
    expect(node).not.toHaveProperty('mediaType')
  })

  it('gives a 1.0 directory the values 0.16 sent for the properties it leaves out', () => {
    const node = normalizeFileNode(V1_DIRECTORY)
    expect(node.nodeType).toBe('directory')
    expect(node.blobId).toBeNull()
    expect(node.type).toBeNull()
    expect(node.target).toBeNull()
    expect(node.executable).toBe(false)
    // `null` on the wire, `{}` in the app: a share dialog iterates this.
    expect(node.shareWith).toEqual({})
  })

  it('carries the seventh right through instead of dropping it', () => {
    expect(normalizeFileNode(V1_DIRECTORY).myRights).toEqual({ ...RIGHTS, maySetMetadata: true })
  })

  it('maps every kind 1.0 can name', () => {
    expect(normalizeFileNode({ '@type': 'SymLink', id: 's', name: 'l' }).nodeType).toBe('symlink')
    expect(normalizeFileNode({ '@type': 'Directory', id: 'd', name: 'd' }).nodeType).toBe(
      'directory',
    )
  })

  it('classifies a node with no kind marker by the one thing both dialects agree on', () => {
    expect(normalizeFileNode({ id: 'x', name: 'x', blobId: 'blob' }).nodeType).toBe('file')
    expect(normalizeFileNode({ id: 'x', name: 'x' }).nodeType).toBe('directory')
  })

  it('does not turn a share map of principals into something else', () => {
    const shared = { ...V1_DIRECTORY, shareWith: { c: { ...RIGHTS, maySetMetadata: false } } }
    expect(normalizeFileNode(shared).shareWith).toEqual({
      c: { ...RIGHTS, maySetMetadata: false },
    })
  })
})

describe('what is written', () => {
  it('creates a 0.16 directory by name, as it always did', () => {
    expect(newDirectory('legacy', { name: 'Docs', parentId: null })).toEqual({
      nodeType: 'directory',
      name: 'Docs',
      parentId: null,
    })
  })

  it('creates a 1.0 directory typed — "@type is required on creation"', () => {
    expect(newDirectory('typed', { name: 'Docs', parentId: 'p' })).toEqual({
      '@type': 'Directory',
      name: 'Docs',
      parentId: 'p',
    })
  })

  it('creates a 0.16 file with `type`, and no kind — byte for byte what v0.25 sent', () => {
    expect(
      newFile('legacy', { name: 'a.txt', parentId: null, blobId: 'blob', mediaType: 'text/plain' }),
    ).toEqual({ name: 'a.txt', parentId: null, blobId: 'blob', type: 'text/plain' })
  })

  it('creates a 1.0 file with `mediaType`, or it is stored as an anonymous binary', () => {
    const created = newFile('typed', {
      name: 'a.txt',
      parentId: null,
      blobId: 'blob',
      mediaType: 'text/plain',
    })
    expect(created).toEqual({
      '@type': 'File',
      name: 'a.txt',
      parentId: null,
      blobId: 'blob',
      mediaType: 'text/plain',
    })
    // The refused spelling must not ride along: 1.0 answers `type` with "Invalid property".
    expect(created).not.toHaveProperty('type')
  })
})

describe('rights: on 1.0 only a directory carries them', () => {
  // Measured: the owner's `SharedDir` has all seven, `inside.txt` and `top.txt` have no `myRights`
  // at all; the grantee sees `SharedDir` read-only and `inside.txt` with none.
  const READ_ONLY = { ...NO_FILE_RIGHTS, mayRead: true, maySetMetadata: false }
  const folder = { ...V1_DIRECTORY, id: 'd', myRights: READ_ONLY }
  const inside = { ...V1_FILE, id: 'i', parentId: 'd' }
  const top = { ...V1_FILE, id: 't', parentId: null }

  it('lets a file take its folder’s rights — and not more', () => {
    const [, file] = normalizeFileNodes([folder, inside], NO_FILE_RIGHTS)
    expect(file?.myRights).toEqual(READ_ONLY)
  })

  it('resolves the folder even when it comes AFTER the file in the batch', () => {
    const [file] = normalizeFileNodes([inside, folder], NO_FILE_RIGHTS)
    expect(file?.myRights).toEqual(READ_ONLY)
  })

  it('carries rights down more than one level', () => {
    const sub = { ...V1_DIRECTORY, id: 's', parentId: 'd', myRights: undefined }
    const deep = { ...V1_FILE, id: 'x', parentId: 's' }
    const nodes = normalizeFileNodes([folder, sub, deep], NO_FILE_RIGHTS)
    expect(nodes.map((node) => node.myRights)).toEqual([READ_ONLY, READ_ONLY, READ_ONLY])
  })

  it('gives a node whose folder is not in the batch the rights the caller names', () => {
    expect(normalizeFileNodes([top], FULL_FILE_RIGHTS)[0]?.myRights).toEqual(FULL_FILE_RIGHTS)
    expect(normalizeFileNodes([inside], NO_FILE_RIGHTS)[0]?.myRights).toEqual(NO_FILE_RIGHTS)
  })

  it('leaves 0.16 alone — every node there carries its own', () => {
    const own = { ...RIGHTS, mayDelete: false }
    const [node] = normalizeFileNodes([{ ...V016_FILE, myRights: own }], FULL_FILE_RIGHTS)
    expect(node?.myRights).toEqual(own)
  })

  it('survives a parent chain that loops', () => {
    const a = { ...V1_FILE, id: 'a', parentId: 'b' }
    const b = { ...V1_FILE, id: 'b', parentId: 'a' }
    const nodes = normalizeFileNodes([a, b], NO_FILE_RIGHTS)
    expect(nodes.map((node) => node.myRights)).toEqual([NO_FILE_RIGHTS, NO_FILE_RIGHTS])
  })
})
