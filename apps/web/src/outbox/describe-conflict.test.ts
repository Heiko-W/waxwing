import { describe, expect, it } from 'vitest'
import type { ConflictCode, OutboxConflict, OutboxRow } from '../sync'
import type { OutboxIntent } from '../sync/engine'
import { describeConflict } from './describe-conflict'

const ALL_CODES: ConflictCode[] = [
  'messageGone',
  'folderGone',
  'folderNotEmpty',
  'forbidden',
  'quota',
  'tooLarge',
  'invalid',
  'stateConflict',
  'sendRejected',
  'sendInterrupted',
  'serverRejected',
]

function row(intent: OutboxIntent, code: ConflictCode): OutboxRow {
  const conflict: OutboxConflict = { code, errorType: null, detail: null, ids: [], at: 1 }
  return {
    accountId: 'a',
    id: 'i1',
    type: intent.kind,
    payload: intent,
    ifInState: null,
    status: 'error',
    attempts: 1,
    createdAt: 1,
    lastError: null,
    notBefore: null,
    conflict,
  }
}

const move: OutboxIntent = { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' }
const flag: OutboxIntent = { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true }
const send = { kind: 'sendEmail', localId: 'd1', source: null } as unknown as OutboxIntent
const folders = new Map([['inbox', 'Inbox']])

describe('describeConflict', () => {
  it('offers "Keep in <folder>" when a move was undone back into a named folder', () => {
    expect(describeConflict(row(move, 'folderGone'), folders)).toEqual({
      titleKey: 'outbox.conflict.moveFolderGone',
      params: { folder: 'Inbox' },
      action: 'keepHere',
    })
  })

  it('degrades to a plain dismiss when the origin folder has no known name', () => {
    // No name for it (an unsynced/removed folder, or a move with no source folder).
    expect(describeConflict(row(move, 'folderGone'), new Map())).toEqual({
      titleKey: 'outbox.conflict.moveFolderGone',
      params: {},
      action: 'dismiss',
    })
    const fromNowhere: OutboxIntent = { ...move, from: null }
    expect(describeConflict(row(fromNowhere, 'folderGone'), folders).action).toBe('dismiss')
  })

  it('never offers Retry for a gone message or folder (it could only fail again)', () => {
    expect(describeConflict(row(flag, 'messageGone'))).toEqual({
      titleKey: 'outbox.conflict.messageGone',
      params: {},
      action: 'dismiss',
    })
    const rename: OutboxIntent = { kind: 'renameMailbox', id: 'mb1', name: 'x' }
    expect(describeConflict(row(rename, 'folderGone')).action).toBe('dismiss')
  })

  it('offers Retry for the codes a later attempt could plausibly resolve', () => {
    for (const code of ['forbidden', 'quota', 'tooLarge', 'invalid', 'stateConflict'] as const) {
      expect(describeConflict(row(flag, code)).action).toBe('retry')
    }
    const remove: OutboxIntent = { kind: 'deleteMailbox', id: 'mb1' }
    expect(describeConflict(row(remove, 'folderNotEmpty'))).toEqual({
      titleKey: 'outbox.conflict.folderNotEmpty',
      params: {},
      action: 'retry',
    })
  })

  it('never offers an action on a send — the composer notifier owns it (no double-send)', () => {
    expect(describeConflict(row(send, 'sendRejected'))).toEqual({
      titleKey: 'compose.sendErrorGeneric',
      params: {},
      action: 'none',
    })
    expect(describeConflict(row(send, 'sendInterrupted'))).toEqual({
      titleKey: 'compose.sendErrorInterrupted',
      params: {},
      action: 'none',
    })
    // Even a code that WOULD be retryable elsewhere stays actionless on a send row.
    expect(describeConflict(row(send, 'quota')).action).toBe('none')
  })

  it('is exhaustive: every ConflictCode yields a real key on every intent kind', () => {
    const intents: OutboxIntent[] = [
      move,
      flag,
      { kind: 'destroyEmails', emailIds: ['e1'] },
      { kind: 'createMailbox', creationId: 'tmp', props: { name: 'n', parentId: null } },
      { kind: 'renameMailbox', id: 'mb1', name: 'n' },
      { kind: 'moveMailbox', id: 'mb1', parentId: null },
      { kind: 'deleteMailbox', id: 'mb1' },
      send,
    ]
    for (const intent of intents) {
      for (const code of ALL_CODES) {
        const description = describeConflict(row(intent, code), folders)
        expect(description.titleKey).toMatch(/^(outbox\.conflict\.|compose\.sendError)/)
        expect(description.titleKey).not.toContain('undefined')
      }
    }
  })

  it('falls back to serverRejected on a legacy row with no conflict record', () => {
    const legacy = { ...row(flag, 'invalid'), conflict: null }
    expect(describeConflict(legacy)).toEqual({
      titleKey: 'outbox.conflict.serverRejected',
      params: {},
      action: 'retry',
    })
  })
})
