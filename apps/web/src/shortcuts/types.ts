/**
 * The shortcut registry's data model (M3.8, FR-UI-04).
 *
 * A shortcut is PURE DATA: a chord, the scopes it may fire in, and two functions over a
 * {@link ShortcutContext} — `enabled` (may it run right now?) and `run`. Nothing here knows about
 * React or the DOM, which is what lets the SAME registry drive three surfaces at once: the global
 * key dispatcher, the `?` cheat-sheet (generated, therefore never stale) and the ⌘K command palette
 * (whose item list is exactly the enabled actions).
 *
 * `run` never touches the sync engine — it calls the very seams the on-screen buttons call
 * (`useTriage` → `useMessageActions`, the composer store, the router), so a keystroke and a click
 * are the same action by construction.
 */

import type { Id } from '@waxwing/jmap'
import type { RouteMatch } from '../app/route'
import type { ListStore } from '../mail/list-store'
import type { ReadingHandlers } from '../mail/reading-store'
import type { Triage } from '../mail/use-triage'

/** Where a chord is allowed to fire. Recomputed from the route on every keystroke. */
export type ShortcutScope =
  | 'global' // anywhere the user is not typing (palette, help, compose, search)
  | 'list' // the message list is the subject (mail route, no message open)
  | 'reading' // a message is open (mail route, `params.emailId` set)

/** Cheat-sheet grouping — also the palette's section order. */
export type ShortcutGroup = 'navigation' | 'triage' | 'compose' | 'application'

/** Cheat-sheet / palette section order. */
export const GROUP_ORDER: readonly ShortcutGroup[] = [
  'navigation',
  'triage',
  'compose',
  'application',
]

/** The role mailboxes a shortcut may need to resolve a move target. */
export interface RoleMailboxes {
  readonly inbox?: Id
  readonly archive?: Id
  readonly junk?: Id
  readonly trash?: Id
  readonly drafts?: Id
  readonly sent?: Id
}

/**
 * Everything a shortcut may read or call. Rebuilt on every render of the provider and held in a ref,
 * so the single window listener never goes stale without ever re-subscribing.
 */
export interface ShortcutContext {
  readonly scope: ShortcutScope
  readonly route: RouteMatch
  navigate(to: string, options?: { readonly replace?: boolean }): void
  back(): void

  /** The email(s) the chord acts on. Precedence: selection → open message → focused row. */
  readonly targetIds: readonly Id[]
  /** The `from` of a move; `null` when unknown (a cross-folder search selection) → moves disabled. */
  readonly sourceMailboxId: Id | null
  readonly openEmailId: Id | undefined
  readonly focusedEmailId: Id | undefined
  readonly hasSelection: boolean
  /** True when EVERY target already carries `$flagged` — so `s` knows to unflag rather than flag. */
  readonly targetsAllFlagged: boolean

  readonly roles: RoleMailboxes
  /**
   * Has the mailbox liveQuery resolved? {@link ShortcutContext.roles} is empty BOTH before it lands
   * and on an account that genuinely lacks the role, and confusing the two is the whole hazard:
   * without this flag every fast `e` after a fresh load would announce "this account has no Archive"
   * on an account that has one. `MessageList` gates its swipe on this same value, for this same reason.
   */
  readonly rolesReady: boolean
  /** True when the acted-on messages live in Trash (there, "delete" means destroy). */
  readonly inTrash: boolean

  /** The SAME seams the buttons use. */
  readonly triage: Triage
  /** The open message's action-bar callbacks; `null` when no message is open. */
  readonly reading: ReadingHandlers | null
  readonly list: ListStore

  openCompose(): void
  focusSearch(): void
  openPalette(): void
  openHelp(): void

  /**
   * Say something the user can actually perceive — a toast, which is also this app's aria-live
   * announcement (its two regions are always mounted, see `ui/Toast`). INJECTED by `ShortcutProvider`
   * rather than read from a hook, so this file's promise survives: the registry may answer a chord out
   * loud without knowing that React, the DOM or a toast host exist.
   */
  notify(messageKey: string): void
}

export interface ShortcutAction {
  /** Stable, dot-namespaced. The palette item id and the recents key — NEVER renamed. */
  readonly id: string
  /** i18n key in `common` (e.g. `shortcuts.actions.triage.archive`); `en` + `de` required. */
  readonly titleKey: string
  /** Chords, primary first (see `keys.ts` for the grammar): `['e']`, `['c', 'Mod+n']`. */
  readonly keys: readonly string[]
  readonly scopes: readonly ShortcutScope[]
  readonly group: ShortcutGroup
  /** Runnable right now? Gates BOTH the key dispatch and the palette's item list. Pure and cheap. */
  enabled(context: ShortcutContext): boolean
  run(context: ShortcutContext): void
  /**
   * Why this chord can NEVER fire on THIS ACCOUNT — an i18n key — or `null` when it is merely inert
   * for an ordinary, momentary reason (nothing selected, empty list, body still loading). Optional:
   * only the three role-mailbox moves carry one.
   *
   * Deliberately independent of the selection. The `?` cheat-sheet consumes it with nothing selected
   * at all, so a predicate that folded in "is anything selected" would show Archive as perfectly
   * available on an account that has no Archive — precisely the state a user is in when they open the
   * sheet after the key did nothing. Whether the reason is worth SAYING right now is a separate
   * question, asked in `unavailableNow` (registry.ts) and nowhere else.
   *
   * NOT a tri-state `enabled`. `enabled` gates two surfaces and there is deliberately exactly one
   * gate; this adds no second one — it only explains a refusal that has already happened.
   */
  unavailable?(context: ShortcutContext): string | null
  /** `j`/`k` only — everything else ignores auto-repeat (a held `e` must not archive 40 messages). */
  readonly allowRepeat?: boolean
  /** Hide from the command palette (a "next message" palette entry is meaningless). */
  readonly paletteHidden?: boolean
}
