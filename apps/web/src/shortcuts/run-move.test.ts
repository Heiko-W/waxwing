/**
 * The regression suite for the silent-drop bug (M3.9) — `registry.test.ts` next door only proves the
 * registry's SHAPE (unique ids, parseable chords, resolvable titles); nothing exercised what a chord
 * actually DOES, which is how this survived M3.8.
 *
 * The bug, proven at ~7% against the live fixture: `e` on a just-opened message took the reading-pane
 * branch, MessageView's own `useMailboxByRole('archive')` had not resolved yet, `moveWithUndo`
 * returned quietly at `if (to === undefined) return` — and `runMove` advanced the pane REGARDLESS.
 * The reader got the "it moved on, so it filed" confirmation for mail that never left the Inbox: no
 * toast, no Undo, nothing in the outbox. The mouse never had it — MessageView's buttons carry
 * `disabled={archiveBox === undefined}` — so a click and a keystroke had silently stopped being the
 * same action, which is the one invariant `use-triage.ts` claims in its own header.
 */

import type { Id } from '@waxwing/jmap'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_LIST_STATE, type ListStore } from '../mail/list-store'
import type { ReadingHandlers } from '../mail/reading-store'
import type { Triage } from '../mail/use-triage'
import { isRunnable, SHORTCUTS } from './registry'
import type { ShortcutContext } from './types'

const IDS: Id[] = ['m1', 'm2', 'm3']

function listStore(overrides: Partial<ListStore> = {}): ListStore {
  return {
    ...EMPTY_LIST_STATE,
    ids: IDS,
    sourceMailboxId: 'inbox',
    setWindow: vi.fn(),
    select: vi.fn(),
    moveFocus: vi.fn(),
    focusIndexTo: vi.fn(),
    focusToId: vi.fn(),
    requestLabels: vi.fn(),
    requestMove: vi.fn(),
    setGridHandle: vi.fn(),
    ...overrides,
  } as ListStore
}

/** A triage seam whose moves report `dispatched`. */
function triageStub(dispatched: boolean): Triage {
  return {
    archive: vi.fn(() => dispatched),
    junk: vi.fn(() => dispatched),
    trash: vi.fn(() => dispatched),
    moveTo: vi.fn(() => dispatched),
    setSeen: vi.fn(),
    setFlagged: vi.fn(),
  }
}

/** MessageView's registered handlers, whose `archive()` reports whether it dispatched. */
function readingStub(dispatched: boolean): ReadingHandlers {
  return {
    emailId: 'm1',
    mailboxId: 'inbox',
    bodyReady: true,
    compose: vi.fn(),
    archive: vi.fn(() => dispatched),
    junk: vi.fn(() => dispatched),
    trash: vi.fn(() => dispatched),
    toggleFlag: vi.fn(),
    markUnread: vi.fn(),
    openMove: vi.fn(),
    openLabels: vi.fn(),
    requestDelete: vi.fn(),
  }
}

interface Ctx {
  context: ShortcutContext
  navigate: ReturnType<typeof vi.fn>
}

/** A message is OPEN (reading scope) and nothing is selected — the state the flake reproduced in. */
function readingContext(options: {
  readingDispatches: boolean
  triageDispatches: boolean
  list?: ListStore
}): Ctx {
  const navigate = vi.fn()
  const context = {
    scope: 'reading',
    route: {
      id: 'mail',
      params: { mailboxId: 'inbox', emailId: 'm1' },
      search: new URLSearchParams(),
    },
    navigate,
    back: vi.fn(),
    targetIds: ['m1'],
    sourceMailboxId: 'inbox',
    openEmailId: 'm1',
    focusedEmailId: 'm1',
    hasSelection: false,
    targetsAllFlagged: false,
    roles: { archive: 'arch', junk: 'junk', trash: 'trash' },
    inTrash: false,
    triage: triageStub(options.triageDispatches),
    reading: readingStub(options.readingDispatches),
    list: options.list ?? listStore(),
    openCompose: vi.fn(),
    focusSearch: vi.fn(),
    openPalette: vi.fn(),
    openHelp: vi.fn(),
  } as unknown as ShortcutContext
  return { context, navigate }
}

const archiveAction = SHORTCUTS.find((a) => a.id === 'triage.archive')

describe('runMove — a keystroke must never advance over a move that did not happen', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has an archive action bound to `e`', () => {
    expect(archiveAction).toBeDefined()
    expect(archiveAction?.keys).toContain('e')
  })

  it('falls through to the shortcut triage when the reading pane refuses (its liveQuery is unresolved)', () => {
    const { context, navigate } = readingContext({
      readingDispatches: false,
      triageDispatches: true,
    })
    archiveAction?.run(context)

    // It asked the reading pane first (that path keeps the view's own `from` and closes its dialogs)…
    expect(context.reading?.archive).toHaveBeenCalledTimes(1)
    // …and, on refusal, used the shortcut layer's own triage, resolved with the app shell long before
    // any row could be focused. THIS is the archive the user asked for; without it, it is lost.
    expect(context.triage.archive).toHaveBeenCalledWith(['m1'], 'inbox')
    // The move happened, so advancing is honest.
    expect(navigate).toHaveBeenCalled()
  })

  it('does NOT advance the reading pane when BOTH seams refuse (the account has no Archive)', () => {
    const { context, navigate } = readingContext({
      readingDispatches: false,
      triageDispatches: false,
    })
    archiveAction?.run(context)

    expect(context.reading?.archive).toHaveBeenCalledTimes(1)
    expect(context.triage.archive).toHaveBeenCalledTimes(1)
    // The bug in one assertion: nothing moved, so the pane must stay put. Advancing here is worse
    // than doing nothing — it is the visual confirmation of a filing that never occurred.
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not call the shortcut triage a second time when the reading pane already moved it', () => {
    const { context, navigate } = readingContext({
      readingDispatches: true,
      triageDispatches: true,
    })
    archiveAction?.run(context)

    expect(context.reading?.archive).toHaveBeenCalledTimes(1)
    // Falling through here would archive twice (and raise two toasts).
    expect(context.triage.archive).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalled()
  })

  it('anchors the roving focus BY ID, never by an index computed before the move', () => {
    const list = listStore()
    const { context } = readingContext({ readingDispatches: true, triageDispatches: true, list })
    archiveAction?.run(context)

    // `m1` is open; the next message is `m2`. An index would be `1` — correct only until the
    // optimistic prune drops `m1` and every row shifts up, at which point index 1 is `m3`: `x` would
    // then tick a message the reader is not looking at, and `#` would trash THAT one.
    expect(list.focusToId).toHaveBeenCalledWith('m2')
    expect(list.focusIndexTo).not.toHaveBeenCalled()
  })

  it('the gate refuses when the Archive folder IS the one on screen (a self-move moves nothing)', () => {
    // `useTriage` refuses `to === from` — the patch would order the mail out of the only mailbox it
    // is in. Without this clause `e` while viewing Archive passed the gate, dispatched nothing, said
    // nothing, and `runMove` cleared the selection anyway; ⌘K offered it too, since `isRunnable`
    // gates both surfaces from here.
    const { context } = readingContext({ readingDispatches: true, triageDispatches: true })
    const inArchive = { ...context, sourceMailboxId: 'arch' } as unknown as ShortcutContext
    expect(archiveAction && isRunnable(archiveAction, inArchive)).toBe(false)
    // Positive control in the same shape: from any other folder it is runnable.
    expect(archiveAction && isRunnable(archiveAction, context)).toBe(true)
  })

  it('the gate still refuses when the account has no archive role at all', () => {
    const { context } = readingContext({ readingDispatches: true, triageDispatches: true })
    const noRoles = { ...context, roles: {} } as unknown as ShortcutContext
    expect(archiveAction && isRunnable(archiveAction, noRoles)).toBe(false)
  })
})

const moveAction = SHORTCUTS.find((a) => a.id === 'triage.move')

describe('the `v` move chord — the non-pointer path WCAG 2.2 SC 2.5.7 requires', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is bound to `v` and runs in BOTH the list and the reading scope', () => {
    // It used to be reading-only, so a folder move was reachable only with a message open — there
    // was no keyboard route to it from the list at all, and none for the drag in 5b to mirror.
    expect(moveAction?.keys).toContain('v')
    expect(moveAction?.scopes).toEqual(expect.arrayContaining(['list', 'reading']))
  })

  it('opens the LIST picker in the list scope, without touching the reading pane', () => {
    const { context } = readingContext({ readingDispatches: true, triageDispatches: true })
    const listScope = {
      ...context,
      scope: 'list',
      targetIds: ['m1', 'm2'],
    } as unknown as ShortcutContext
    moveAction?.run(listScope)

    expect(listScope.list.requestMove).toHaveBeenCalledWith(['m1', 'm2'])
    expect(listScope.reading?.openMove).not.toHaveBeenCalled()
  })

  it('still opens the reading pane picker when a message is open and nothing is selected', () => {
    const { context } = readingContext({ readingDispatches: true, triageDispatches: true })
    moveAction?.run(context)

    expect(context.reading?.openMove).toHaveBeenCalledTimes(1)
    expect(context.list.requestMove).not.toHaveBeenCalled()
  })

  it('prefers an explicit selection over the open message, exactly as `l` does', () => {
    const { context } = readingContext({ readingDispatches: true, triageDispatches: true })
    const selected = {
      ...context,
      hasSelection: true,
      targetIds: ['m2', 'm3'],
    } as unknown as ShortcutContext
    moveAction?.run(selected)

    expect(selected.list.requestMove).toHaveBeenCalledWith(['m2', 'm3'])
    expect(selected.reading?.openMove).not.toHaveBeenCalled()
  })

  it('is inert without a source mailbox — a move with no `from` is a COPY', () => {
    // `move(ids, null, to)` keeps every other membership, so the mail would be added to the target
    // and stay where it was. The reading pane's Move button gates on the same value.
    const { context } = readingContext({ readingDispatches: true, triageDispatches: true })
    const noSource = { ...context, sourceMailboxId: null } as unknown as ShortcutContext
    expect(moveAction && isRunnable(moveAction, noSource)).toBe(false)
  })

  it('is inert with nothing to act on', () => {
    const { context } = readingContext({ readingDispatches: true, triageDispatches: true })
    const empty = { ...context, targetIds: [] } as unknown as ShortcutContext
    expect(moveAction && isRunnable(moveAction, empty)).toBe(false)
  })
})
