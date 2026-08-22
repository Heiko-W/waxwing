import type { Id } from '@waxwing/jmap'
import { beforeEach, describe, expect, it } from 'vitest'
import type { MailboxRow } from '../sync'
import {
  canDropMailbox,
  canDropMessages,
  clearActiveDrag,
  type DragSubject,
  draggedMessageIds,
  getActiveDrag,
  setActiveDrag,
} from './dnd'
import { legalParents, type MoveLimits } from './folder-tree'

const RIGHTS = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
  mayShare: false,
}

function row(id: string, over: Partial<MailboxRow> = {}): MailboxRow {
  return {
    accountId: 'a',
    id,
    name: id,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: RIGHTS,
    isSubscribed: true,
    ...over,
  }
}

describe('draggedMessageIds — what a drag actually carries', () => {
  it('takes the whole selection when the dragged row is IN it', () => {
    const selected = new Set<Id>(['a', 'b', 'c'])
    expect([...draggedMessageIds(selected, 'b')].sort()).toEqual(['a', 'b', 'c'])
  })

  it('takes ONLY the dragged row when it is outside the selection', () => {
    // The rule `targetIds` gets wrong for a pointer: it returns the selection first and
    // unconditionally, so dragging unselected `x` with a,b,c ticked would fly a,b,c into the folder
    // while `x` — the row under the cursor, the one the user is looking at — stayed put.
    const selected = new Set<Id>(['a', 'b', 'c'])
    expect(draggedMessageIds(selected, 'x')).toEqual(['x'])
  })

  it('takes the dragged row when nothing is selected at all', () => {
    expect(draggedMessageIds(new Set<Id>(), 'x')).toEqual(['x'])
  })
})

/** A message drag out of `a`'s inbox — the account `row()` builds its mailboxes under. */
const messageDrag = (over: Partial<Extract<DragSubject, { kind: 'messages' }>> = {}) =>
  ({ kind: 'messages', accountId: 'a', ids: ['m1'], from: 'inbox', ...over }) as Extract<
    DragSubject,
    { kind: 'messages' }
  >

describe('canDropMessages — the gate the write path does not have', () => {
  it('refuses a mailbox we may not add to', () => {
    // `triage.moveTo` dispatches unconditionally, so without this the drop renders as success and
    // the server reverts it a round-trip later.
    expect(
      canDropMessages(row('t', { myRights: { ...RIGHTS, mayAddItems: false } }), messageDrag()),
    ).toBe(false)
  })

  it('refuses the folder the messages are already in', () => {
    expect(canDropMessages(row('inbox'), messageDrag())).toBe(false)
  })

  it('accepts an ordinary target', () => {
    expect(canDropMessages(row('archive'), messageDrag())).toBe(true)
  })

  it('refuses a target in ANOTHER account, rights or not (M4.4)', () => {
    // Newly reachable in M4.4: the grouped sidebar shows the primary's folders beside a shared
    // account's list, so this drop can be attempted. The ids are short and per-account, so without
    // the account gate `archive` names a real primary folder and the drop looks perfectly legal.
    expect(canDropMessages(row('archive', { accountId: 'shared' }), messageDrag())).toBe(false)
  })
})

describe('canDropMailbox — same account, then the legality oracle (M4.4)', () => {
  const folderDrag = {
    kind: 'mailbox',
    accountId: 'a',
    id: 'child',
    legal: new Set(['other']),
  } as Extract<DragSubject, { kind: 'mailbox' }>

  it('accepts a legal parent in the same account', () => {
    expect(canDropMailbox(row('other'), folderDrag)).toBe(true)
  })

  it('refuses a parent legalParents did not name', () => {
    expect(canDropMailbox(row('elsewhere'), folderDrag)).toBe(false)
  })

  it('refuses a same-id parent in another account', () => {
    expect(canDropMailbox(row('other', { accountId: 'shared' }), folderDrag)).toBe(false)
  })
})

describe('the active drag subject', () => {
  beforeEach(() => clearActiveDrag())

  it('is null when nothing is being dragged', () => {
    expect(getActiveDrag()).toBeNull()
  })

  it('round-trips a subject and clears', () => {
    setActiveDrag({ kind: 'messages', accountId: 'a', ids: ['m1'], from: 'inbox' })
    expect(getActiveDrag()).toEqual({
      kind: 'messages',
      accountId: 'a',
      ids: ['m1'],
      from: 'inbox',
    })
    clearActiveDrag()
    expect(getActiveDrag()).toBeNull()
  })

  it('carries a folder drag legality Set that legalParents produced', () => {
    // Delegation only — folder-tree.test.ts owns the rules themselves. What matters HERE is that the
    // drag holds legalParents' verdict rather than a parallel check of its own: a drop that could
    // reach a parent the dialog filters out would be a NEW SC 2.5.7 violation, not a feature.
    const mailboxes = [
      row('inbox', { role: 'inbox' }),
      row('parent'),
      row('child', { parentId: 'parent' }),
      row('grandchild', { parentId: 'child' }),
      row('other'),
    ]
    const limits: MoveLimits = { maxMailboxDepth: null, mayCreateTopLevelMailbox: true }
    const legal = new Set(
      legalParents(mailboxes, 'child', limits).filter((p): p is string => p !== null),
    )
    setActiveDrag({ kind: 'mailbox', accountId: 'a', id: 'child', legal })

    const drag = getActiveDrag()
    expect(drag?.kind).toBe('mailbox')
    if (drag?.kind !== 'mailbox') throw new Error('unreachable')
    expect(drag.legal.has('other')).toBe(true) // a legal sibling
    expect(drag.legal.has('child')).toBe(false) // itself
    expect(drag.legal.has('grandchild')).toBe(false) // its own descendant
    expect(drag.legal.has('parent')).toBe(false) // where it already is
    // `null` is filtered out: the tree has no node for "top level" to drop onto.
    expect([...drag.legal].every((id) => typeof id === 'string')).toBe(true)
  })
})
