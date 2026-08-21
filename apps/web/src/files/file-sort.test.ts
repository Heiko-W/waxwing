/**
 * The order a folder is shown in (D-3), and the order it is ASKED for.
 *
 * Two claims, and the point of the module is that they are separable. What goes on the wire is
 * gated on `fileNodeQuerySortOptions`, because a `FileNode/query` argument this server refuses does
 * not fail that method — it fails the whole request (the HTTP 400 that took the Files screen out
 * once already, see `files-client.ts`). What the reader sees is computed here, every time, so a
 * server that ignores a comparator or orders `file10` before `file2` changes the wire and nothing
 * on screen.
 */

import type { FileNode, FileNodeCapability } from '@waxwing/jmap'
import { describe, expect, it } from 'vitest'
import { DEFAULT_FILE_SORT, offeredSortKeys, serverSort, sortNodes } from './file-sort'

function node(name: string, over: Partial<FileNode> = {}): FileNode {
  return {
    id: name,
    parentId: null,
    nodeType: 'file',
    blobId: 'b',
    target: null,
    size: 10,
    name,
    type: 'text/plain',
    created: '2026-08-21T08:00:00Z',
    modified: '2026-08-21T08:00:00Z',
    accessed: '2026-08-21T08:00:00Z',
    changed: '2026-08-21T08:00:00Z',
    executable: false,
    isSubscribed: false,
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

const dir = (name: string): FileNode =>
  node(name, { nodeType: 'directory', blobId: null, type: null })

const capability = (options: string[]): FileNodeCapability => ({
  maxFileNodeDepth: null,
  maxSizeFileNodeName: 255,
  forbiddenNameChars: '/<>:"\\|?*',
  forbiddenNodeNames: ['.', '..', 'CON'],
  fileNodeQuerySortOptions: options,
})

describe('what may be offered', () => {
  it('offers exactly what the session advertises', () => {
    expect(offeredSortKeys(capability(['name', 'size', 'nodeType']))).toEqual([
      'name',
      'size',
      'nodeType',
    ])
  })

  it('drops a key the server has not claimed', () => {
    // Measured on 0.16.18 as all three — but a hoster on an older build, or a different server
    // entirely, is exactly the case where offering the third one costs the whole request.
    expect(offeredSortKeys(capability(['name']))).toEqual(['name'])
  })

  it('ignores a property the server invents that this screen cannot render', () => {
    expect(offeredSortKeys(capability(['name', 'created']))).toEqual(['name'])
  })

  it('falls back to name where there is no capability at all', () => {
    expect(offeredSortKeys(null)).toEqual(['name'])
  })
})

describe('what goes on the wire', () => {
  it('sends the chosen property when it is advertised', () => {
    expect(serverSort({ key: 'size', ascending: false }, capability(['name', 'size']))).toEqual([
      { property: 'size', isAscending: false },
    ])
  })

  it('falls back to name rather than sending a property the server refuses', () => {
    // The whole reason this function exists. Not "the sort is ignored" — the REQUEST is rejected,
    // and with it the `FileNode/get` riding along in the same batch.
    expect(serverSort({ key: 'size', ascending: true }, capability(['name']))).toEqual([
      { property: 'name', isAscending: true },
    ])
  })

  it('is never empty, so the truncation point is never the server’s whim', () => {
    expect(serverSort(DEFAULT_FILE_SORT, null)).toHaveLength(1)
  })
})

describe('the order the reader sees', () => {
  it('puts folders first', () => {
    const sorted = sortNodes([node('a-file'), dir('z-folder')], DEFAULT_FILE_SORT)
    expect(sorted.map((n) => n.name)).toEqual(['z-folder', 'a-file'])
  })

  it('keeps folders first when the order is reversed', () => {
    // Reversing is a question about the files, not about the shape of the tree: burying the
    // folders under them makes the way DOWN the tree the thing that moved.
    const sorted = sortNodes([node('a-file'), dir('z-folder')], { key: 'name', ascending: false })
    expect(sorted.map((n) => n.name)).toEqual(['z-folder', 'a-file'])
  })

  it('counts, rather than comparing digit by digit', () => {
    // `scan10` before `scan2` is what a plain code-point sort gives, and a folder of numbered
    // scans is where it is most obviously wrong.
    const sorted = sortNodes([node('scan10.png'), node('scan2.png')], DEFAULT_FILE_SORT)
    expect(sorted.map((n) => n.name)).toEqual(['scan2.png', 'scan10.png'])
  })

  it('sorts by size when asked, largest first', () => {
    const sorted = sortNodes([node('small', { size: 10 }), node('big', { size: 900 })], {
      key: 'size',
      ascending: false,
    })
    expect(sorted.map((n) => n.name)).toEqual(['big', 'small'])
  })

  it('breaks a size tie by name instead of leaving it to chance', () => {
    // Two same-sized files would otherwise swap places between loads for no reason the reader
    // can see, which reads as the list refreshing itself at random.
    const sorted = sortNodes([node('b.txt', { size: 10 }), node('a.txt', { size: 10 })], {
      key: 'size',
      ascending: true,
    })
    expect(sorted.map((n) => n.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('leaves the input array alone', () => {
    const input = [node('b'), node('a')]
    sortNodes(input, DEFAULT_FILE_SORT)
    expect(input.map((n) => n.name)).toEqual(['b', 'a'])
  })
})
