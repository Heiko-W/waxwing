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
import { mailHrefKeepingQuery } from '../app/route'
import { SEARCH_INPUT_ID } from '../mail/search/SearchBox'
import type { ShortcutAction, ShortcutContext } from './types'

/**
 * May this action run right now? THE gate — the key dispatcher and the ⌘K palette both call it, and
 * neither re-derives it. Two gates over one registry is how the palette came to offer "Archive" on the
 * Settings screen (the scope said no, `enabled()` alone said yes) and silently archived a message the
 * user could not see.
 */
export function isRunnable(action: ShortcutAction, context: ShortcutContext): boolean {
  return inScope(action, context) && action.enabled(context)
}

/** Is the chord ours in the scope the user is currently in? The first half of {@link isRunnable}. */
function inScope(action: ShortcutAction, context: ShortcutContext): boolean {
  return action.scopes.includes(context.scope) || action.scopes.includes('global')
}

/**
 * The i18n key the key DISPATCHER should announce when a chord refused, or `null` for silence.
 *
 * Two questions, deliberately kept apart. `action.unavailable` answers "can this account EVER do
 * this?" — selection-independent, because the cheat-sheet asks it while nothing is selected. This one
 * adds "…and is the account's shape the ONLY thing standing in the way right now?".
 *
 * Both extra clauses hold for every action that carries an `unavailable` today (all three are moves),
 * and — not a coincidence — both also disable `v`, so the message may name `v` as the way out and
 * still be true in every case where it fires. Without them the app would lecture about a missing
 * Archive folder to a user who has simply selected nothing, where "nothing to act on" is the real,
 * ordinary, self-correcting reason and silence is right. The scope check is the other half: `e` on the
 * Settings screen must stay as mute as it is today, not start explaining mailbox roles.
 */
export function unavailableNow(action: ShortcutAction, context: ShortcutContext): string | null {
  if (!inScope(action, context)) return null
  if (context.targetIds.length === 0 || context.sourceMailboxId === null) return null
  return action.unavailable?.(context) ?? null
}

/** The mailbox a move/navigation should be filed under: the list's window, else the open message's. */
function routeMailboxId(context: ShortcutContext): Id | undefined {
  return context.route.params.mailboxId ?? context.sourceMailboxId ?? undefined
}

/**
 * A mail URL that keeps the current query string. The rule and its reasoning now live in
 * `app/route` as {@link mailHrefKeepingQuery} — this is a thin binding to the shortcut context.
 *
 * It moved because keeping it private here is how the two "back to the list" paths came to
 * disagree: `u` kept the query, while the on-screen Back button called `mailPath()` bare and dropped
 * it. One rule, one place, both callers.
 */
function mailHref(context: ShortcutContext, mailboxId: Id | undefined, emailId?: Id): string {
  return mailHrefKeepingQuery(context.route.search, mailboxId, emailId)
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

/**
 * A move is only possible with a known source mailbox, a target role mailbox — and a target that is
 * not the source. That last clause is not tidiness: `useTriage` refuses a self-move (its patch would
 * order the mail out of the only mailbox it is in), so without it `e` while viewing Archive passed
 * this gate, dispatched nothing, showed nothing, and `runMove` still cleared the selection. Exactly
 * the "archived nothing, said nothing" shape 6da2350 exists to kill — and the chord was offered in
 * ⌘K too, since `isRunnable` gates both surfaces from here. `MoveDialog` and `canDropMessages`
 * already make the same comparison.
 */
function canMove(context: ShortcutContext, role: Id | undefined): boolean {
  return (
    context.targetIds.length > 0 &&
    role !== undefined &&
    context.sourceMailboxId !== null &&
    role !== context.sourceMailboxId &&
    // B34: the same two-sided verdict the buttons use — the source must permit removal and the
    // target must accept. A chord that refused differently from the button beside it would be two
    // answers to one question.
    context.rights.moveReason(context.sourceMailboxId, role) === null
  )
}

/**
 * {@link canMove}'s ACCOUNT-SHAPE clause on its own: this account has no such role mailbox, so the
 * chord can never fire here — as opposed to `canMove`'s three other clauses, every one of which is
 * momentary and fixes itself the moment the user selects a row.
 *
 * `rolesReady` is what keeps this quiet on the first render tick: `context.roles` is empty both before
 * `useMailboxes()` resolves and on an account that genuinely has no Archive, so without the flag every
 * login would announce a missing folder to accounts that have one.
 *
 * Deliberately NOT covered: the self-move (`role === context.sourceMailboxId` — "Archive while viewing
 * Archive"). That is arguably worth a word too, but it is a different message and a different
 * judgement call; it stays exactly as silent as it is today. Same for the transient
 * `bodyReady === false` refusal of `r`/`a`/`f` — though "a tick" is now optimistic: since the
 * quoting fix, `bodyReady` also waits for the message's inline `cid:` images to finish
 * downloading, which on a slow link is long enough for a keypress to feel ignored. Still silent,
 * because the buttons carry the same state visibly; revisit if it is ever reported.
 */
function missingRole(context: ShortcutContext, role: Id | undefined, key: string): string | null {
  return context.rolesReady && role === undefined ? key : null
}

/**
 * Why a move chord cannot fire: the account has no such folder, or the acting account denies the
 * move (B34). The rights answer comes second because a missing folder is the more specific thing to
 * say — and it is the only one of the two that a different account would fix.
 */
function moveUnavailable(
  context: ShortcutContext,
  role: Id | undefined,
  key: string,
): string | null {
  const missing = missingRole(context, role, key)
  if (missing !== null) return missing
  if (context.sourceMailboxId === null || role === undefined) return null
  return context.rights.moveReason(context.sourceMailboxId, role)
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
    run: (context) => {
      context.navigate(mailHref(context, context.route.params.mailboxId))
      // …and take FOCUS with it (WCAG 2.4.3). Navigating alone unmounts the reading pane out from
      // under the focused element, so focus falls to <body>: the next Tab restarts at the top of the
      // document and a screen reader loses its place. It went unnoticed because the chords keep
      // working from <body> — the dispatcher is document-level — so everything a sighted keyboard
      // user tries still does something.
      //
      // After the navigation, not before: the grid is the element being returned TO, and the list
      // re-renders as the route changes.
      queueMicrotask(() => context.list.grid?.focus())
    },
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
    unavailable: (context) =>
      moveUnavailable(context, context.roles.archive, 'shortcuts.unavailable.archive'),
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
        ? // in Trash the chord means DESTROY — only from the open message, and only if permitted
          context.reading !== null && context.rights.reason('destroy') === null
        : canMove(context, context.roles.trash),
    // Inside Trash the chord means DESTROY and needs no role mailbox at all, so there is nothing an
    // account could be missing — its only refusal there is "no message open", which is ordinary.
    unavailable: (context) =>
      context.inTrash
        ? context.rights.reason('destroy')
        : moveUnavailable(context, context.roles.trash, 'shortcuts.unavailable.trash'),
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
    unavailable: (context) =>
      moveUnavailable(context, context.roles.junk, 'shortcuts.unavailable.junk'),
    run: (context) => runMove(context, 'junk'),
  },
  {
    id: 'triage.unread',
    titleKey: 'shortcuts.actions.triage.unread',
    keys: ['u'],
    scopes: ['list'],
    group: 'triage',
    enabled: (context) => context.targetIds.length > 0 && context.rights.reason('seen') === null,
    // No hint: `shortcuts.unavailable.hint` points at the folder picker, and there is no picker that
    // grants a permission. A refusal with a way forward and one without must not read alike.
    unavailable: (context) => context.rights.reason('seen'),
    run: (context) => context.triage.setSeen([...context.targetIds], false),
  },
  {
    id: 'triage.flag',
    titleKey: 'shortcuts.actions.triage.flag',
    keys: ['s'],
    scopes: ['list', 'reading'],
    group: 'triage',
    enabled: (context) =>
      context.targetIds.length > 0 && context.rights.reason('keywords') === null,
    unavailable: (context) => context.rights.reason('keywords'),
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
    id: 'triage.undo',
    titleKey: 'shortcuts.actions.triage.undo',
    keys: ['z'],
    scopes: ['list', 'reading'],
    group: 'triage',
    // Always offered: whether an undo is PENDING is not knowable from the context (the toasts live
    // in their own provider), and a chord that appeared and vanished with a five-second timer would
    // be worse than one that occasionally does nothing. `run` reports honestly instead.
    enabled: () => true,
    run: (context) => {
      if (!context.runNewestToastAction()) context.notify('shortcuts.unavailable.undo')
    },
  },
  {
    id: 'triage.label',
    titleKey: 'shortcuts.actions.triage.label',
    keys: ['l'],
    scopes: ['list', 'reading'],
    group: 'triage',
    // Deliberately NOT rights-gated (B34): it only opens a picker, exactly like `v`. The picker
    // explains its own refusal, and gating the opener would hide the explanation.
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
    scopes: ['list', 'reading'],
    group: 'triage',
    // Not `reading !== null`: in the list scope that is always false, so a bare scope widening would
    // have made `v` an inert key there AND hidden it from ⌘K — `isRunnable` gates both from this one
    // predicate. `sourceMailboxId !== null` is `canMove`'s non-role half: without a source, `move`
    // keeps the other memberships, which is a copy rather than a move.
    enabled: (context) => context.targetIds.length > 0 && context.sourceMailboxId !== null,
    // No `unavailable`, and there must never be one: `v` needs no role mailbox — it opens the folder
    // picker — which is exactly what makes it the escape hatch the archive/junk/trash message names.
    // Reporting it unavailable would leave the user with a refusal that points at another refusal.
    // Mirrors `triage.label` (`l`) exactly, including its selection precedence: an explicit selection
    // wins over the open message. Only OPENS the picker — the dispatch, the selection clear and any
    // advance belong to whoever the dialog reports back to.
    run: (context) => {
      const reading = context.reading
      if (context.scope === 'reading' && !context.hasSelection && reading !== null) {
        reading.openMove()
        return
      }
      context.list.requestMove([...context.targetIds])
    },
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
    id: 'reading.print',
    titleKey: 'shortcuts.actions.reading.print',
    // The browser's own Ctrl/Cmd+P already prints whatever is on screen, and this cannot override
    // it. `Mod+p` is registered anyway so the action appears in the cheat sheet and the palette —
    // discovering that printing works at all is the point, not the chord.
    keys: ['Mod+p'],
    scopes: ['reading'],
    group: 'application',
    enabled: (context) => context.reading !== null,
    run: (context) => context.reading?.print(),
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
