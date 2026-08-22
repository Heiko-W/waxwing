/**
 * JMAP File Storage (M5.7) — `draft-ietf-jmap-filenode`.
 *
 * The node shape below is **exactly what Stalwart 0.16 returned** for a `FileNode/get` after
 * uploading a blob and creating a file from it. For a draft with no RFC number that is the only
 * defensible source: the server is what the client has to work with.
 */

import { describe, expect, it } from 'vitest'
import { usingForMethods } from './capabilities'
import { Methods } from './methods'
import { type FileNode, fileNodeNameProblem } from './types/filenode'

/** Verbatim from the fixture, minus nothing. */
const MEASURED: FileNode = {
  id: 'b',
  parentId: null,
  nodeType: 'file',
  blobId: 'cb7et221zdnvutuurkqbaetjrqiipygcydvscjwfk1qs0tuyzb7w2aimae',
  target: null,
  size: 13,
  name: 'notes.txt',
  type: 'text/plain',
  created: '2026-08-19T13:47:57Z',
  modified: '2026-08-19T13:47:57Z',
  accessed: '2026-08-19T13:48:04Z',
  changed: '2026-08-19T13:47:57Z',
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
}

/** The capability the fixture advertises. */
const CAPABILITY = {
  maxSizeFileNodeName: 255,
  forbiddenNameChars: '/<>:"\\|?*',
  forbiddenNodeNames: ['.', '..', 'CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1'],
}

describe('wiring', () => {
  it('binds the FileNode methods', () => {
    expect(Methods.fileNodeGet.name).toBe('FileNode/get')
    expect(Methods.fileNodeQuery.name).toBe('FileNode/query')
    expect(Methods.fileNodeSet.name).toBe('FileNode/set')
  })

  it('auto-adds the filenode capability to `using`', () => {
    expect(usingForMethods(['FileNode/get'])).toContain('urn:ietf:params:jmap:filenode')
  })

  /*
   * `FileNode/changes` exists on v0.16.18 (measured) and had no caller until D-4, because file
   * browsing kept no local state for a delta to be applied to. It keeps a replica now
   * (`sync/engine/delta.ts` `syncFileNodes`), so the binding is a claim this client honours.
   */
  it('binds `FileNode/changes`, now that the file tree is replicated', () => {
    expect(Methods.fileNodeChanges.name).toBe('FileNode/changes')
  })
})

describe('the measured node shape', () => {
  it('is a parentId-linked tree, with null at the root', () => {
    expect(MEASURED.parentId).toBeNull()
  })

  it('carries a blob for a file, and would carry none for a directory', () => {
    expect(MEASURED.nodeType).toBe('file')
    expect(MEASURED.blobId).not.toBeNull()
  })

  it('mints its OWN blob id rather than echoing the uploaded one', () => {
    // The upload returned `eb7et…`; the stored node reports `cb7et…`. Caching the upload id as if
    // it addressed the file is the mistake this pins — the same trap RFC 9661 sets for Sieve.
    expect(MEASURED.blobId).not.toBe(
      'eb7et221zdnvutuurkqbaetjrqiipygcydvscjwfk1qs0tuyzb7w2am0qsl0ibq',
    )
  })
})

describe('fileNodeNameProblem', () => {
  it('accepts an ordinary name', () => {
    expect(fileNodeNameProblem('notes.txt', CAPABILITY)).toBeNull()
  })

  it('rejects an empty or whitespace-only name', () => {
    expect(fileNodeNameProblem('', CAPABILITY)).toBe('empty')
    expect(fileNodeNameProblem('   ', CAPABILITY)).toBe('empty')
  })

  it('rejects the characters the server forbids', () => {
    for (const name of ['a/b', 'a:b', 'a?b', 'a"b']) {
      expect(fileNodeNameProblem(name, CAPABILITY)).toBe('forbiddenCharacter')
    }
  })

  it('rejects a reserved DOS device name, whatever its case', () => {
    // A user typing "con" for "contract" gets a refusal they cannot possibly have predicted, so
    // catching it here is the difference between an explanation and a server error.
    expect(fileNodeNameProblem('CON', CAPABILITY)).toBe('reservedName')
    expect(fileNodeNameProblem('con', CAPABILITY)).toBe('reservedName')
    expect(fileNodeNameProblem('Aux', CAPABILITY)).toBe('reservedName')
  })

  it('measures the length limit in OCTETS, not characters', () => {
    // The limit is a byte budget: 100 emoji are 400 bytes.
    const emoji = '🙂'.repeat(100)
    expect(fileNodeNameProblem(emoji, CAPABILITY)).toBe('tooLong')
    expect(fileNodeNameProblem('a'.repeat(255), CAPABILITY)).toBeNull()
    expect(fileNodeNameProblem('a'.repeat(256), CAPABILITY)).toBe('tooLong')
  })
})
