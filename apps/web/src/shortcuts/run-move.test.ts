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
import { ALL_GRANTED, type MessageRights } from '../mail/rights'
import type { Triage } from '../mail/use-triage'
import { isRunnable, SHORTCUTS, unavailableNow } from './registry'
import type { ShortcutAction, ShortcutContext } from './types'

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
  rights?: MessageRights
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
    // Everything permitted unless a test says otherwise — the shape of the user's own account, and
    // the same reason `rolesReady` is set below: omitted, it would be `undefined` and every rights
    // gate would throw or wave everything through.
    rights: options.rights ?? ALL_GRANTED,
    roles: { archive: 'arch', junk: 'junk', trash: 'trash' },
    // The mailbox liveQuery HAS resolved. Not decoration: these stubs are `as unknown as
    // ShortcutContext`, so an omitted field compiles happily as `undefined` — and `undefined` here
    // makes every `unavailable` return `null`, which would let the "stays silent" tests below pass
    // without exercising a single line of the thing they claim to guard.
    rolesReady: true,
    inTrash: false,
    triage: triageStub(options.triageDispatches),
    reading: readingStub(options.readingDispatches),
    list: options.list ?? listStore(),
    openCompose: vi.fn(),
    focusSearch: vi.fn(),
    openPalette: vi.fn(),
    openHelp: vi.fn(),
    notify: vi.fn(),
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

  // Half the story since G2/B3: the gate still refuses, but the refusal is no longer the END of it —
  // `unavailable` / `unavailableNow` (the describe below) are what turn it into something the user
  // hears. `enabled` itself is deliberately untouched: there is still exactly ONE gate.
  it('the gate still refuses when the account has no archive role at all', () => {
    const { context } = readingContext({ readingDispatches: true, triageDispatches: true })
    const noRoles = { ...context, roles: {} } as unknown as ShortcutContext
    expect(archiveAction && isRunnable(archiveAction, noRoles)).toBe(false)
  })
})

/** A registry entry by id, or a loud failure — `find` returning `undefined` must never pass as `null`. */
function action(id: string): ShortcutAction {
  const found = SHORTCUTS.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no such action: ${id}`)
  return found
}

/**
 * G2/B3 — a chord that cannot fire because the ACCOUNT has no such folder must say so. It used to
 * fall out of the dispatcher's loop and do nothing at all: no move, no toast, no live-region text,
 * which from the keyboard is indistinguishable from a key that is not bound.
 *
 * Two predicates, deliberately: `unavailable` is the account-shape question the `?` cheat-sheet asks
 * while NOTHING is selected, `unavailableNow` adds "and is that the only thing in the way right now"
 * for the dispatcher. Folding the selection into one predicate would have shown Archive as available
 * on an account that has none — on the very surface a user opens after the key did nothing.
 */
describe('an unavailable role names itself instead of failing silently', () => {
  /** The same open-message context, with the role mailboxes (and anything else) overridden. */
  function ctx(over: Partial<ShortcutContext> = {}): ShortcutContext {
    const { context } = readingContext({ readingDispatches: true, triageDispatches: true })
    return { ...context, ...over } as unknown as ShortcutContext
  }

  const NO_ARCHIVE = { junk: 'junk', trash: 'trash' }
  const NO_JUNK = { archive: 'arch', trash: 'trash' }
  const NO_TRASH = { archive: 'arch', junk: 'junk' }

  it('names the missing folder for archive, junk and trash', () => {
    expect(action('triage.archive').unavailable?.(ctx({ roles: NO_ARCHIVE }))).toBe(
      'shortcuts.unavailable.archive',
    )
    expect(action('triage.junk').unavailable?.(ctx({ roles: NO_JUNK }))).toBe(
      'shortcuts.unavailable.junk',
    )
    expect(action('triage.trash').unavailable?.(ctx({ roles: NO_TRASH }))).toBe(
      'shortcuts.unavailable.trash',
    )
  })

  it('stays silent when the account HAS the folder', () => {
    expect(action('triage.archive').unavailable?.(ctx())).toBeNull()
  })

  it('stays silent while the mailbox liveQuery is still unresolved', () => {
    // `roles` is empty both before `useMailboxes()` lands and on an account that truly has no
    // Archive. Without this clause every login would announce a missing folder to an account that
    // has one — the same hazard `MessageList` documents for the swipe.
    const unresolved = ctx({ roles: {}, rolesReady: false })
    expect(action('triage.archive').unavailable?.(unresolved)).toBeNull()
  })

  it('stays silent about a self-move — "Archive while viewing Archive" is a different message', () => {
    const inArchive = ctx({ sourceMailboxId: 'arch' })
    // `enabled` still refuses it (the gate test above); B3 deliberately does not explain it.
    expect(isRunnable(action('triage.archive'), inArchive)).toBe(false)
    expect(action('triage.archive').unavailable?.(inArchive)).toBeNull()
  })

  it('says nothing about `#` inside Trash — there the chord destroys and needs no role', () => {
    expect(action('triage.trash').unavailable?.(ctx({ roles: NO_TRASH, inTrash: true }))).toBeNull()
  })

  it('`v` carries no reason at all — it is the escape hatch the message names', () => {
    // `triage.move` opens the folder picker and needs no role mailbox. A message that says "press V"
    // while V reported itself unavailable would point one refusal at another.
    expect(action('triage.move').unavailable).toBeUndefined()
  })

  describe('…and the DISPATCHER only announces it when the account is the only obstacle', () => {
    const archive = () => action('triage.archive')

    it('announces with something to act on', () => {
      expect(unavailableNow(archive(), ctx({ roles: NO_ARCHIVE }))).toBe(
        'shortcuts.unavailable.archive',
      )
    })

    it('says nothing when NOTHING is selected — "nothing to act on" is the real reason', () => {
      expect(unavailableNow(archive(), ctx({ roles: NO_ARCHIVE, targetIds: [] }))).toBeNull()
    })

    it('says nothing without a source mailbox — a cross-folder search disables `v` too', () => {
      // The message names `v` as the way out, and `v` is dead without a `from`. Announcing here would
      // hand the user a hint that is false in exactly this state.
      const noSource = ctx({ roles: NO_ARCHIVE, sourceMailboxId: null })
      expect(unavailableNow(archive(), noSource)).toBeNull()
    })

    it('says nothing outside the mail area — Settings must not start explaining mailbox roles', () => {
      expect(unavailableNow(archive(), ctx({ roles: NO_ARCHIVE, scope: 'global' }))).toBeNull()
    })

    it('says nothing for an ordinary refusal that carries no reason at all', () => {
      // `l` (labels) has no `unavailable`: silence is right, and the dispatcher must not invent a
      // message for every chord that happens to be disabled.
      expect(unavailableNow(action('triage.label'), ctx({ roles: NO_ARCHIVE }))).toBeNull()
    })
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

describe('rights gate every chord that writes (B34)', () => {
  /** A verdict that denies exactly `op`, granting everything else — the mixed-rights shared account. */
  function denying(op: 'seen' | 'keywords' | 'destroy' | 'move'): MessageRights {
    return {
      ...ALL_GRANTED,
      maySetSeen: op !== 'seen',
      maySetKeywords: op !== 'keywords',
      mayDestroy: op !== 'destroy',
      reason: (asked) => (asked === op ? `rights.unavailable.${asked}` : null),
      removeReason: () => (op === 'move' ? 'rights.unavailable.remove' : null),
      addReason: () => null,
      moveReason: () => (op === 'move' ? 'rights.unavailable.remove' : null),
    }
  }

  const action = (id: string): ShortcutAction => {
    const found = SHORTCUTS.find((candidate) => candidate.id === id)
    if (!found) throw new Error(`no such action: ${id}`)
    return found
  }

  function ctx(rights: MessageRights, over: Partial<ShortcutContext> = {}): ShortcutContext {
    const { context } = readingContext({ readingDispatches: true, triageDispatches: true, rights })
    return { ...context, ...over } as unknown as ShortcutContext
  }

  it('refuses `u` and says why — a keystroke that does nothing silently is defect B3 again', () => {
    const denied = ctx(denying('seen'), { scope: 'list' })
    expect(isRunnable(action('triage.unread'), denied)).toBe(false)
    expect(unavailableNow(action('triage.unread'), denied)).toBe('rights.unavailable.seen')
  })

  it('refuses `s` and says why', () => {
    const denied = ctx(denying('keywords'))
    expect(isRunnable(action('triage.flag'), denied)).toBe(false)
    expect(unavailableNow(action('triage.flag'), denied)).toBe('rights.unavailable.keywords')
  })

  it('refuses `e` when the SOURCE denies removal, though the account has an Archive', () => {
    // The half every pre-existing check missed: rights were only ever consulted for move TARGETS.
    const denied = ctx(denying('move'))
    expect(isRunnable(action('triage.archive'), denied)).toBe(false)
    expect(unavailableNow(action('triage.archive'), denied)).toBe('rights.unavailable.remove')
  })

  it('refuses `#` inside Trash when destroy is denied — there the chord DESTROYS', () => {
    const denied = ctx(denying('destroy'), { inTrash: true })
    expect(isRunnable(action('triage.trash'), denied)).toBe(false)
    expect(unavailableNow(action('triage.trash'), denied)).toBe('rights.unavailable.destroy')
  })

  it('still runs every chord on an account that grants everything', () => {
    // The single-account no-regression pin: the user's own account grants all rights everywhere, so
    // nothing above may cost the ordinary case anything.
    const allowed = ctx(ALL_GRANTED, { scope: 'list' })
    expect(isRunnable(action('triage.unread'), allowed)).toBe(true)
    expect(isRunnable(action('triage.flag'), allowed)).toBe(true)
    expect(isRunnable(action('triage.archive'), allowed)).toBe(true)
    expect(unavailableNow(action('triage.unread'), allowed)).toBeNull()
  })

  it('leaves `l` runnable — it only opens a picker, which explains itself', () => {
    expect(isRunnable(action('triage.label'), ctx(denying('keywords')))).toBe(true)
  })
})
