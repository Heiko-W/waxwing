/**
 * The three folder properties RFC 8621 stores on the server and Waxwing used to keep to itself:
 * `sortOrder`, `isSubscribed` and `role` (JMAP gap analysis M-5 and M-6).
 *
 * Everything here is a pure function of the flat, `sortOrder`/name-sorted mailbox list
 * {@link import('../sync').useMailboxes} yields — the same input {@link buildFolderTree} takes — so
 * the arithmetic can be tested without a DOM, which matters because the pointer drag that drives it
 * cannot be (jsdom has no layout; ADR-026).
 *
 * ## What the server actually accepts (measured, not read off the RFC)
 *
 * Against the fixture — **Stalwart v0.16.18, 21.08.2026, account `carol@waxwing.test`** — a
 * `Mailbox/set update` on a freshly created folder answered:
 *
 * | role | answer |
 * |---|---|
 * | `archive`, `important`, `snoozed`, `scheduled`, `memos` | accepted |
 * | `drafts`, `inbox`, `junk`, `sent`, `trash` | `invalidProperties` — *"A mailbox with role 'x' already exists."* |
 * | `all`, `flagged`, `subscribed`, `templates`, `notes`, `outbox`, `spam`, `starred` | `invalidProperties` — *"Invalid property or value."* |
 *
 * Two rules follow, and both are enforced here rather than left to the server:
 *
 * 1. **A role is unique per account.** Re-measured on a *custom* role too: a second folder asking
 *    for `archive` while one already had it was refused with the same message. So the list on offer
 *    is {@link ASSIGNABLE_ROLES} MINUS the roles already spoken for.
 * 2. **The IANA registry is not the menu.** `templates` is in RFC 8621's world and is refused here.
 *    There is no capability that advertises the accepted set, so {@link ASSIGNABLE_ROLES} is a
 *    measured constant — re-measure it before adding to it.
 *
 * Also measured, because both change what the UI may assume: the server **lower-cases** a role on
 * the way in (`ARCHIVE` is stored as `archive`), and `role: null` clears one.
 */

import type { MailboxRow } from '../sync'
import { PINNED_ROLES } from './folder-tree'

/**
 * The roles a user may put on a folder of their own, in the order they are offered.
 *
 * Measured against Stalwart v0.16.18 (see the module note) — NOT the IANA registry, which contains
 * values this server refuses. `inbox`/`drafts`/`sent`/`junk`/`trash` are deliberately absent even
 * though the server would take them on a free account: they are the folders the server creates for
 * itself, and re-pointing "where my drafts go" from a sidebar is a foot-gun with no way back that a
 * user would recognise.
 */
export const ASSIGNABLE_ROLES = ['archive', 'important', 'snoozed', 'scheduled', 'memos'] as const

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

const ASSIGNABLE = new Set<string>(ASSIGNABLE_ROLES)
const PINNED = new Set<string>(PINNED_ROLES)

/**
 * May this folder's role be changed at all?
 *
 * Only a folder that carries no role, or one of the roles we ourselves hand out. A server-created
 * `inbox`/`drafts`/`sent`/`junk`/`trash` is left alone (see {@link ASSIGNABLE_ROLES}), and a folder
 * the user may not rename may not be re-purposed either — `mayRename` is the right that governs a
 * `Mailbox/set update` on the folder itself (RFC 8621 §2 has no `mayMove`/`mayConfigure`).
 */
export function mayChangeRole(mailbox: MailboxRow): boolean {
  if (!mailbox.myRights.mayRename) return false
  return mailbox.role === null || ASSIGNABLE.has(mailbox.role)
}

/**
 * The roles that may be offered for `subjectId`: the assignable set minus every role another
 * mailbox in this account already holds. The subject's OWN role stays in the list — otherwise the
 * select could not show what the folder currently is.
 */
export function assignableRoles(
  mailboxes: readonly MailboxRow[],
  subjectId: string,
): readonly AssignableRole[] {
  const taken = new Set(
    mailboxes
      .filter((mailbox) => mailbox.id !== subjectId && mailbox.role !== null)
      .map((mailbox) => mailbox.role as string),
  )
  return ASSIGNABLE_ROLES.filter((role) => !taken.has(role))
}

// ── Reordering ────────────────────────────────────────────────────────────────────────────────

/**
 * Move `items[from]` to `to`, clamped, returning the SAME array when nothing moved.
 *
 * The twin of `moveItem` in `settings/sieve/rule-model.ts`, deliberately copied rather than
 * imported: Settings is a lazy route chunk (`AppShell.tsx`), and importing from it would pull the
 * Sieve compiler into the mail bundle for the sake of eight lines. ADR-026 is the pattern being
 * reused here, not the module.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (from === to || from < 0 || from >= items.length) return items
  const target = Math.min(items.length - 1, Math.max(0, to))
  if (target === from) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return items
  next.splice(target, 0, moved)
  return next
}

/**
 * The index a row dropped at `pointerY` should take, given the mid-height of every row it may land
 * among. Split out for the same reason its twin is: jsdom has no layout, so every
 * `getBoundingClientRect()` there is zero and the geometry can only be tested by passing it in.
 */
export function dropIndex(midpoints: readonly number[], pointerY: number): number {
  let index = 0
  for (const midpoint of midpoints) {
    if (pointerY > midpoint) index += 1
  }
  return Math.min(Math.max(index, 0), Math.max(midpoints.length - 1, 0))
}

/** Order the flat list the way the replica does — `sortOrder`, then name (RFC 8621 §2). */
function inDisplayOrder(mailboxes: readonly MailboxRow[]): MailboxRow[] {
  return [...mailboxes].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

/**
 * The folders that share a parent AND whose order is actually decided by `sortOrder`, in display
 * order.
 *
 * Two exclusions, both deliberate:
 *
 * - **A different parent.** `sortOrder` is a hint among siblings; moving a folder elsewhere is a
 *   re-parent, which the tree already offers (FR-MBX-03).
 * - **The standard folders.** `orderRoots` places Inbox, Drafts, Sent, Archive, Junk and Trash by
 *   role and never looks at their `sortOrder`. Counting them here would write a `sortOrder` to the
 *   Inbox that is then ignored, and would announce "folder 3 of 4" for a group of two.
 */
export function orderableSiblings(
  mailboxes: readonly MailboxRow[],
  parentId: string | null,
): MailboxRow[] {
  return inDisplayOrder(
    mailboxes.filter((mailbox) => mailbox.parentId === parentId && !isStandardFolder(mailbox)),
  )
}

/**
 * Move `id` to position `toIndex` among its siblings and restamp that group's `sortOrder`.
 *
 * Returns the WHOLE list, re-sorted, so the caller can rebuild the tree from it and show the new
 * order before anything has been written. `sortOrder` is restamped 1-based, not 0-based, on
 * purpose: a folder the server creates arrives at 0, so "some sibling is above 0" is exactly the
 * signal {@link nextSortOrder} needs to tell a hand-ordered group from an untouched one.
 */
export function reorderSiblings(
  mailboxes: readonly MailboxRow[],
  id: string,
  toIndex: number,
): readonly MailboxRow[] {
  const subject = mailboxes.find((mailbox) => mailbox.id === id)
  if (subject === undefined) return mailboxes
  const siblings = orderableSiblings(mailboxes, subject.parentId)
  const from = siblings.findIndex((mailbox) => mailbox.id === id)
  const moved = moveItem(siblings, from, toIndex)
  if (moved === siblings) return mailboxes
  const stamped = new Map(moved.map((mailbox, index) => [mailbox.id, index + 1]))
  return inDisplayOrder(
    mailboxes.map((mailbox) => {
      const sortOrder = stamped.get(mailbox.id)
      return sortOrder === undefined || sortOrder === mailbox.sortOrder
        ? mailbox
        : { ...mailbox, sortOrder }
    }),
  )
}

/** The `sortOrder` values that actually changed — the payload of one `Mailbox/set update`. */
export function changedSortOrders(
  before: readonly MailboxRow[],
  after: readonly MailboxRow[],
): ReadonlyArray<{ readonly id: string; readonly sortOrder: number }> {
  const was = new Map(before.map((mailbox) => [mailbox.id, mailbox.sortOrder]))
  return after
    .filter((mailbox) => was.get(mailbox.id) !== mailbox.sortOrder)
    .map((mailbox) => ({ id: mailbox.id, sortOrder: mailbox.sortOrder }))
}

/**
 * The `sortOrder` a newly created folder should be given so it lands at the END of a group the user
 * has already put in an order of their own — or `undefined` for a group nobody has touched, which
 * leaves the server's 0 and the alphabetical tie-break in place.
 *
 * Without this a hand-ordered group silently teleports every new folder to the top: {@link
 * reorderSiblings} stamps 1…n, a created folder arrives at 0, and 0 sorts first.
 */
export function nextSortOrder(siblings: readonly MailboxRow[]): number | undefined {
  const highest = siblings.reduce((max, mailbox) => Math.max(max, mailbox.sortOrder), 0)
  return highest === 0 ? undefined : highest + 1
}

// ── Subscription ──────────────────────────────────────────────────────────────────────────────

/**
 * Is this one of the six folders the tree pins to the top by role (Inbox, Drafts, Sent, Archive,
 * Junk, Trash)?
 *
 * Such a folder is neither reorderable — `orderRoots` places it by role and ignores its
 * `sortOrder`, so an order written for it would be accepted by the server and then not shown — nor
 * hideable: RFC 8621 §2 says the standard mailboxes should stay subscribed, and a sidebar that can
 * lose its own Inbox is not a sidebar.
 */
export function isStandardFolder(mailbox: Pick<MailboxRow, 'role'>): boolean {
  return mailbox.role !== null && PINNED.has(mailbox.role)
}

/**
 * The folders the sidebar shows: everything except what the user has unsubscribed from — and its
 * children, which would otherwise re-surface at the top level as orphans (see
 * {@link buildFolderTree}, which is deliberately forgiving about an unresolvable `parentId`).
 *
 * ### The measurement that shapes the rule
 *
 * `isSubscribed: false` is **overloaded on this server**, and hiding on it alone would be a defect,
 * not a feature. Measured on the fixture: `alice` holds a share on `carol`'s account, and
 * `Mailbox/get` for that account answers `isSubscribed: false` for carol's Inbox — the one and only
 * mailbox alice can see there. That is RFC 8621 §2 behaving as written ("SHOULD default to false
 * for Mailboxes in shared accounts"), and a client that hides on the flag alone empties the whole
 * delegated account (M4.4) the moment this lands.
 *
 * So the flag is read as a user PREFERENCE only where it is demonstrably being used as one: an
 * account in which at least one mailbox IS subscribed. Where nothing is subscribed, the server is
 * describing a grant rather than a choice, and everything stays visible.
 *
 * `keepId` — the folder currently open — is never hidden, nor are its ancestors: being inside an
 * invisible folder is the one state this must not produce.
 */
export function visibleMailboxes(
  mailboxes: readonly MailboxRow[],
  keepId?: string | null,
): readonly MailboxRow[] {
  if (!mailboxes.some((mailbox) => mailbox.isSubscribed)) return mailboxes

  const hidden = new Set(
    mailboxes
      .filter((mailbox) => !mailbox.isSubscribed && !isStandardFolder(mailbox))
      .map((mailbox) => mailbox.id),
  )
  if (hidden.size === 0) return mailboxes

  const index = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]))
  // The open folder and every ancestor it hangs from stay, whatever the flag says.
  const seen = new Set<string>()
  let current = keepId ?? null
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    hidden.delete(current)
    current = index.get(current)?.parentId ?? null
  }

  const isHidden = (mailbox: MailboxRow): boolean => {
    const chain = new Set<string>()
    let node: MailboxRow | undefined = mailbox
    while (node !== undefined && !chain.has(node.id)) {
      if (hidden.has(node.id)) return true
      chain.add(node.id)
      node = node.parentId === null ? undefined : index.get(node.parentId)
    }
    return false
  }
  return mailboxes.filter((mailbox) => !isHidden(mailbox))
}
