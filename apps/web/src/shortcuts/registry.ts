/**
 * THE registry (M3.8, FR-UI-04) — Gmail/Fastmail-style defaults as pure data.
 *
 * One array, three consumers: the global key dispatcher (first match wins, so order is priority
 * order), the `?` cheat-sheet (generated from here, therefore never out of date) and the ⌘K palette
 * (its item list IS the subset whose `enabled(ctx)` holds). Adding a shortcut means adding a row here
 * and two i18n strings — nothing else.
 *
 * `u` deliberately carries TWO entries: "back to the list" while a message is open, "mark unread" in
 * the list. Their scopes are disjoint, so the chord is never ambiguous, and both meanings the plan
 * asks for land on the one key a Gmail user reaches for.
 */

import type { Id } from '@waxwing/jmap'
import { mailPath } from '../app/route'
import { SEARCH_INPUT_ID } from '../mail/search/SearchBox'
import type { ShortcutAction, ShortcutContext } from './types'

/**
 * May this action run right now? THE gate — the key dispatcher and the ⌘K palette both call it, and
 * neither re-derives it. Two gates over one registry is how the palette came to offer "Archive" on the
 * Settings screen (the scope said no, `enabled()` alone said yes) and silently archived a message the
 * user could not see.
 */
export function isRunnable(action: ShortcutAction, context: ShortcutContext): boolean {
  if (!action.scopes.includes(context.scope) && !action.scopes.includes('global')) return false
  return action.enabled(context)
}

/** The mailbox a move/navigation should be filed under: the list's window, else the open message's. */
function routeMailboxId(context: ShortcutContext): Id | undefined {
  return context.route.params.mailboxId ?? context.sourceMailboxId ?? undefined
}

/**
 * A mail URL that KEEPS the current query string. `?q=` (search) and `?label=` are what the list is
 * showing; `MessageList.open()` preserves them for a click, and `j`/`k`/`u`/auto-advance must too —
 * dropping them snaps the list back to the plain folder, which changes the window key and therefore
 * resets the focus and the selection out from under the user mid-triage.
 */
function mailHref(context: ShortcutContext, mailboxId: Id | undefined, emailId?: Id): string {
  const qs = context.route.search.toString()
  return mailPath(mailboxId, emailId) + (qs ? `?${qs}` : '')
}

/**
 * Keep a mouse-free triage session moving: when the chord consumed exactly the OPEN message, land on
 * the next message in the list window (or back on the list if it was the last one). Without this the
 * reading pane is dead after every `e` and the session stalls.
 */
export function advanceAfterTriage(context: ShortcutContext, consumed: readonly Id[]): void {
  const openId = context.openEmailId
  if (openId === undefined) return
  if (consumed.length !== 1 || consumed[0] !== openId) return

  const { ids } = context.list
  const index = ids.indexOf(openId)
  const next = index >= 0 ? ids[index + 1] : undefined
  const mailboxId = routeMailboxId(context)
  if (next === undefined) {
    context.navigate(mailHref(context, mailboxId))
    return
  }
  // Anchor the roving focus on the message we are ABOUT to show BY ID — never by index. `index + 1`
  // is read off the window as it stands before the move; the triage above prunes the consumed row
  // optimistically, and if that lands first every row shifts up and the same index points one row too
  // far. Then `x` ticks a message the reader is not looking at and `#` trashes THAT one. Measured at
  // 3/30 against the live fixture (M3.9) — and the comment that used to sit here claimed this was
  // anchored by id while the code below it did the index thing.
  context.list.focusToId(next)
  context.navigate(mailHref(context, mailboxId, next))
}

/** A move is only possible with a known source mailbox and a target role mailbox. */
function canMove(context: ShortcutContext, role: Id | undefined): boolean {
  return context.targetIds.length > 0 && role !== undefined && context.sourceMailboxId !== null
}

/**
 * Run a move over the current targets. With a message open and nothing selected, this goes through
 * the reading pane's OWN handler (identical action, but it also closes that view's dialogs and keeps
 * its `from` mailbox) — otherwise straight through {@link Triage} over the selection/focused row.
 *
 * The reading pane's handler can REFUSE, and that is the whole reason both seams return a boolean.
 * `MessageView` resolves its role mailboxes through its own `useMailboxByRole` instances, which are
 * `undefined` for the first tick(s) after it mounts. The E2E's only barrier before `e` is the `<h2>`
 * — rendered by a different liveQuery, and satisfied a couple of milliseconds EARLIER. Press `e` in
 * that window and the old code archived nothing, said nothing, and advanced the pane regardless, so
 * the reader saw "it moved on" and believed the mail was filed. ~7% of runs against the live fixture
 * (M3.9); worse the faster you triage, which is the one thing this layer exists for. The mouse never
 * had the hole — `MessageView`'s buttons carry `disabled={archiveBox === undefined}`.
 *
 * So a refusal falls through to the SHORTCUT layer's own triage, whose mailboxes resolved with the
 * app shell long before any row could be focused. That keeps `use-triage`'s promise — a click and a
 * keystroke are the same action — instead of merely documenting it. If BOTH refuse (the account
 * genuinely has no such mailbox) nothing moves, and then the pane must not advance either: an
 * advance over a move that never dispatched is worse than inaction, because it looks like success.
 */
function runMove(context: ShortcutContext, kind: 'archive' | 'junk' | 'trash'): void {
  const consumed = [...context.targetIds]
  const reading = context.reading
  let moved: boolean
  if (!context.hasSelection && context.openEmailId !== undefined && reading !== null) {
    moved = reading[kind]() || context.triage[kind](consumed, context.sourceMailboxId)
  } else {
    moved = context.triage[kind](consumed, context.sourceMailboxId)
    context.list.select({ type: 'clear' })
  }
  if (moved) advanceAfterTriage(context, consumed)
}

/** Move the roving focus; with a message open, follow it into the reading pane (Gmail parity). */
function runStep(context: ShortcutContext, delta: number): void {
  const { ids, focusIndex } = context.list
  if (ids.length === 0) return
  const next = Math.max(0, Math.min(focusIndex + delta, ids.length - 1))
  context.list.moveFocus(delta)
  if (context.openEmailId === undefined) return
  const id = ids[next]
  if (id !== undefined) context.navigate(mailHref(context, routeMailboxId(context), id))
}

export const SHORTCUTS: readonly ShortcutAction[] = [
  {
    id: 'nav.next',
    titleKey: 'shortcuts.actions.nav.next',
    keys: ['j'],
    scopes: ['list', 'reading'],
    group: 'navigation',
    allowRepeat: true,
    paletteHidden: true,
    enabled: (context) => context.list.ids.length > 0,
    run: (context) => runStep(context, 1),
  },
  {
    id: 'nav.prev',
    titleKey: 'shortcuts.actions.nav.prev',
    keys: ['k'],
    scopes: ['list', 'reading'],
    group: 'navigation',
    allowRepeat: true,
    paletteHidden: true,
    enabled: (context) => context.list.ids.length > 0,
    run: (context) => runStep(context, -1),
  },
  {
    id: 'nav.open',
    titleKey: 'shortcuts.actions.nav.open',
    keys: ['o'],
    scopes: ['list'],
    group: 'navigation',
    enabled: (context) => context.focusedEmailId !== undefined,
    run: (context) => {
      const id = context.focusedEmailId
      if (id === undefined) return
      // The mounted grid opens it exactly the way a click does (a draft goes back to the composer,
      // a cross-folder search result is filed under the mailbox it actually lives in).
      const grid = context.list.grid
      if (grid !== null) {
        grid.open(id)
        return
      }
      const mailboxId = routeMailboxId(context)
      if (mailboxId !== undefined) context.navigate(mailHref(context, mailboxId, id))
    },
  },
  {
    id: 'nav.back',
    titleKey: 'shortcuts.actions.nav.back',
    keys: ['u'],
    scopes: ['reading'],
    group: 'navigation',
    enabled: (context) => context.openEmailId !== undefined,
    run: (context) => context.navigate(mailHref(context, context.route.params.mailboxId)),
  },
  {
    id: 'list.select',
    titleKey: 'shortcuts.actions.list.select',
    keys: ['x'],
    // LIST ONLY. `x` acts on the roving row, which is independent of the open message — in the reading
    // scope it would tick a row the user cannot see (on a narrow viewport the list is not even
    // rendered), and that invisible selection would then take over what `e` archives.
    scopes: ['list'],
    group: 'triage',
    enabled: (context) => context.focusedEmailId !== undefined,
    run: (context) => {
      const id = context.focusedEmailId
      // Gmail parity: `x` toggles and stays put (it does not advance) — that is what makes
      // `x j x j` a usable multi-select.
      if (id !== undefined) context.list.select({ type: 'toggle', id })
    },
  },
  {
    id: 'triage.archive',
    titleKey: 'shortcuts.actions.triage.archive',
    keys: ['e'],
    scopes: ['list', 'reading'],
    group: 'triage',
    enabled: (context) => canMove(context, context.roles.archive),
    run: (context) => runMove(context, 'archive'),
  },
  {
    id: 'triage.trash',
    titleKey: 'shortcuts.actions.triage.trash',
    keys: ['#'],
    scopes: ['list', 'reading'],
    group: 'triage',
    enabled: (context) =>
      context.inTrash
        ? context.reading !== null // in Trash the chord means DESTROY — only from the open message
        : canMove(context, context.roles.trash),
    run: (context) => {
      // Already in Trash: "delete" can only mean permanently — go through the existing confirmation.
      if (context.inTrash) {
        context.reading?.requestDelete()
        return
      }
      runMove(context, 'trash')
    },
  },
  {
    id: 'triage.junk',
    titleKey: 'shortcuts.actions.triage.junk',
    keys: ['!'],
    scopes: ['list', 'reading'],
    group: 'triage',
    enabled: (context) => canMove(context, context.roles.junk),
    run: (context) => runMove(context, 'junk'),
  },
  {
    id: 'triage.unread',
    titleKey: 'shortcuts.actions.triage.unread',
    keys: ['u'],
    scopes: ['list'],
    group: 'triage',
    enabled: (context) => context.targetIds.length > 0,
    run: (context) => context.triage.setSeen([...context.targetIds], false),
  },
  {
    id: 'triage.flag',
    titleKey: 'shortcuts.actions.triage.flag',
    keys: ['s'],
    scopes: ['list', 'reading'],
    group: 'triage',
    enabled: (context) => context.targetIds.length > 0,
    // A TOGGLE, like the star button it shares a seam with (Gmail's `s` toggles too): flag, unless
    // every target already is — then unflag. A key that can only ever set a flag, next to a button
    // that toggles it, is exactly the drift `useTriage` exists to prevent.
    run: (context) => {
      const reading = context.reading
      if (!context.hasSelection && context.openEmailId !== undefined && reading !== null) {
        reading.toggleFlag()
        return
      }
      context.triage.setFlagged([...context.targetIds], !context.targetsAllFlagged)
    },
  },
  {
    id: 'triage.label',
    titleKey: 'shortcuts.actions.triage.label',
    keys: ['l'],
    scopes: ['list', 'reading'],
    group: 'triage',
    enabled: (context) => context.targetIds.length > 0,
    run: (context) => {
      const reading = context.reading
      if (context.scope === 'reading' && !context.hasSelection && reading !== null) {
        reading.openLabels()
        return
      }
      context.list.requestLabels([...context.targetIds])
    },
  },
  {
    id: 'triage.move',
    titleKey: 'shortcuts.actions.triage.move',
    keys: ['v'],
    scopes: ['reading'],
    group: 'triage',
    enabled: (context) => context.reading !== null,
    run: (context) => context.reading?.openMove(),
  },
  {
    id: 'compose.new',
    titleKey: 'shortcuts.actions.compose.new',
    // ⌘/Ctrl+N is a best-effort SECOND chord: most browsers reserve it for a new window and never
    // deliver it to the page. `c` is the documented primary.
    keys: ['c', 'Mod+n'],
    scopes: ['global'],
    group: 'compose',
    enabled: () => true,
    run: (context) => context.openCompose(),
  },
  {
    id: 'compose.reply',
    titleKey: 'shortcuts.actions.compose.reply',
    keys: ['r'],
    scopes: ['reading'],
    group: 'compose',
    enabled: (context) => context.reading?.bodyReady === true,
    run: (context) => context.reading?.compose('reply'),
  },
  {
    id: 'compose.replyAll',
    titleKey: 'shortcuts.actions.compose.replyAll',
    keys: ['a'],
    scopes: ['reading'],
    group: 'compose',
    enabled: (context) => context.reading?.bodyReady === true,
    run: (context) => context.reading?.compose('replyAll'),
  },
  {
    id: 'compose.forward',
    titleKey: 'shortcuts.actions.compose.forward',
    keys: ['f'],
    scopes: ['reading'],
    group: 'compose',
    enabled: (context) => context.reading?.bodyReady === true,
    run: (context) => context.reading?.compose('forward'),
  },
  {
    id: 'app.search',
    titleKey: 'shortcuts.actions.app.search',
    keys: ['/'],
    scopes: ['global'],
    group: 'application',
    // Only where there IS a search box. The dispatcher `preventDefault()`s before it runs an action,
    // so an always-enabled `/` would eat the key on Settings and Contacts — and with it the browser's
    // own Quick Find — to then do nothing at all.
    enabled: () => document.getElementById(SEARCH_INPUT_ID) !== null,
    run: (context) => context.focusSearch(),
  },
  {
    id: 'app.palette',
    titleKey: 'shortcuts.actions.app.palette',
    keys: ['Mod+k'],
    scopes: ['global'],
    group: 'application',
    paletteHidden: true,
    enabled: () => true,
    run: (context) => context.openPalette(),
  },
  {
    id: 'app.help',
    titleKey: 'shortcuts.actions.app.help',
    keys: ['?'],
    scopes: ['global'],
    group: 'application',
    enabled: () => true,
    run: (context) => context.openHelp(),
  },
]
