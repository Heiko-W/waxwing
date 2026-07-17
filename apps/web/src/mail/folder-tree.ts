/**
 * Folder-tree assembly (M1.5, FR-MBX-01). {@link useMailboxes} yields a FLAT, sortOrder/name-sorted
 * list; this pure function turns it into the display hierarchy: the standard role mailboxes pinned
 * at the top in a fixed, human order, then custom folders, each with its children nested by
 * `parentId`. It is defensive about a live-syncing replica — a child whose parent has not synced yet
 * (or a `parentId` cycle) is surfaced as a root rather than lost or looping.
 */

import type { MailboxRow } from '../sync'

/** The role mailboxes pinned at the top of the tree, in display order (FR-MBX-01). */
export const PINNED_ROLES = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'] as const

const ROLE_RANK = new Map<string, number>(PINNED_ROLES.map((role, index) => [role, index]))

export interface FolderNode {
  readonly mailbox: MailboxRow
  readonly children: FolderNode[]
  /** 0 for a root, +1 per level — drives indentation and the `aria-level` of the treeitem. */
  readonly depth: number
  /** 1-based position among its displayed same-level siblings (`aria-posinset`). */
  readonly posinset: number
  /** Number of displayed same-level siblings (`aria-setsize`). */
  readonly setsize: number
}

/** Build the display tree from the flat, pre-sorted mailbox list. */
export function buildFolderTree(mailboxes: readonly MailboxRow[]): FolderNode[] {
  const ids = new Set(mailboxes.map((mailbox) => mailbox.id))
  // Group children by their EFFECTIVE parent: a parentId that doesn't resolve locally (not yet
  // synced) is treated as a root so the folder still appears.
  const childrenOf = new Map<string | null, MailboxRow[]>()
  for (const mailbox of mailboxes) {
    const parent = mailbox.parentId !== null && ids.has(mailbox.parentId) ? mailbox.parentId : null
    const siblings = childrenOf.get(parent) ?? []
    siblings.push(mailbox)
    childrenOf.set(parent, siblings)
  }

  const seen = new Set<string>()
  const build = (parentId: string | null, depth: number): FolderNode[] =>
    (childrenOf.get(parentId) ?? [])
      .filter((mailbox) => !seen.has(mailbox.id)) // guard against a parentId cycle
      .map((mailbox) => {
        seen.add(mailbox.id)
        // posinset/setsize are assigned in the final pass (roots are reordered below).
        return { mailbox, children: build(mailbox.id, depth + 1), depth, posinset: 0, setsize: 0 }
      })

  const roots = orderRoots(build(null, 0))
  // A pure parentId cycle (or a component disconnected from every root) is unreachable from `null`;
  // surface each such mailbox as its own root so no folder silently vanishes from the tree.
  const orphanRoots: FolderNode[] = []
  for (const mailbox of mailboxes) {
    if (seen.has(mailbox.id)) continue
    seen.add(mailbox.id)
    orphanRoots.push({ mailbox, children: build(mailbox.id, 1), depth: 0, posinset: 0, setsize: 0 })
  }
  // Assign aria-posinset/setsize over the FINAL displayed order (roots reordered + orphans appended).
  return assignPositions([...roots, ...orphanRoots])
}

/** Stamp each node's 1-based `posinset` and its level's `setsize` for the displayed sibling order. */
function assignPositions(nodes: FolderNode[]): FolderNode[] {
  const setsize = nodes.length
  return nodes.map((node, index) => ({
    ...node,
    posinset: index + 1,
    setsize,
    children: assignPositions(node.children),
  }))
}

/** Pinned role roots first (in {@link PINNED_ROLES} order), then everything else in its incoming order. */
function orderRoots(roots: FolderNode[]): FolderNode[] {
  const pinned: FolderNode[] = []
  const rest: FolderNode[] = []
  for (const node of roots) {
    const role = node.mailbox.role
    if (role !== null && ROLE_RANK.has(role)) pinned.push(node)
    else rest.push(node)
  }
  pinned.sort((a, b) => rank(a.mailbox.role) - rank(b.mailbox.role))
  return [...pinned, ...rest]
}

function rank(role: string | null): number {
  return role !== null ? (ROLE_RANK.get(role) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
}

/**
 * The label to show for a mailbox: a localized role name for the standard roles (FR-MBX-01), else
 * the server-provided name. Takes `t` so this module stays free of the i18n runtime.
 */
export function folderDisplayName(
  mailbox: Pick<MailboxRow, 'role' | 'name'>,
  t: (key: string) => string,
): string {
  if (mailbox.role !== null && ROLE_RANK.has(mailbox.role)) return t(`mailbox.role.${mailbox.role}`)
  return mailbox.name
}

/**
 * The account limits a re-parent has to respect. `maxMailboxDepth: null` means UNLIMITED (RFC 8621
 * §1.4) — never conflate it with 0, and never let `undefined` reach here: the session capability is
 * typed `UnsignedInt | null` but is not validated at the wire (`isMailCapability` checks only two
 * other fields), so a server that omits it hands us `undefined` and TypeScript cannot see it. The
 * caller narrows with `typeof === 'number'`; this module only ever sees a number or `null`.
 */
export interface MoveLimits {
  readonly maxMailboxDepth: number | null
  readonly mayCreateTopLevelMailbox: boolean
}

/** Index `id → mailbox` once; the guards below walk parent chains repeatedly. */
function byId(mailboxes: readonly MailboxRow[]): Map<string, MailboxRow> {
  return new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]))
}

/**
 * Is `candidateId` the subject itself, or one of its descendants? Moving a folder into its own
 * subtree detaches that subtree from the root — {@link buildFolderTree} would quietly re-surface it
 * as an orphan root, so the mistake *renders fine* and only diverges when the server rejects it.
 *
 * Walks UP from the candidate rather than down from the subject: a chain is bounded by the mailbox
 * count, a subtree walk would need its own cycle guard. Tolerates a `parentId` cycle, as
 * {@link buildFolderTree} does — a replica mid-sync is allowed to be briefly impossible.
 */
export function isSelfOrDescendant(
  mailboxes: readonly MailboxRow[],
  subjectId: string,
  candidateId: string,
): boolean {
  if (candidateId === subjectId) return true
  const index = byId(mailboxes)
  const seen = new Set<string>([candidateId])
  let current = index.get(candidateId)?.parentId ?? null
  while (current !== null) {
    if (current === subjectId) return true
    if (seen.has(current)) return false // cycle — it never reaches the subject
    seen.add(current)
    current = index.get(current)?.parentId ?? null
  }
  return false
}

/**
 * The HEIGHT of the subject's subtree: 0 for a leaf, 1 with children, 2 with grandchildren.
 *
 * This — not the subject's own depth — is what a depth limit has to budget for: moving a folder
 * moves everything under it, and it is the DEEPEST descendant that hits the ceiling first.
 */
export function subtreeDepth(mailboxes: readonly MailboxRow[], subjectId: string): number {
  const childrenOf = new Map<string, MailboxRow[]>()
  for (const mailbox of mailboxes) {
    if (mailbox.parentId === null) continue
    const siblings = childrenOf.get(mailbox.parentId) ?? []
    siblings.push(mailbox)
    childrenOf.set(mailbox.parentId, siblings)
  }
  const walk = (id: string, seen: Set<string>): number => {
    let deepest = 0
    for (const child of childrenOf.get(id) ?? []) {
      if (seen.has(child.id)) continue // cycle guard, as buildFolderTree has
      seen.add(child.id)
      deepest = Math.max(deepest, walk(child.id, seen) + 1)
    }
    return deepest
  }
  return walk(subjectId, new Set([subjectId]))
}

/** 0-based ancestor count: a top-level mailbox has 0. Cycle-tolerant. */
function ancestorCount(index: Map<string, MailboxRow>, id: string): number {
  let count = 0
  const seen = new Set<string>([id])
  let current = index.get(id)?.parentId ?? null
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    count += 1
    current = index.get(current)?.parentId ?? null
  }
  return count
}

/**
 * Every parent the subject may legally move to, in display order, `null` (top level) first.
 *
 * This is where the correctness of FR-MBX-03 lives: `moveMailbox` writes `parentId` optimistically
 * and unconditionally, so an illegal move looks *successful* locally and only comes back as a
 * generic `invalid` conflict after a round-trip. Every rule below is therefore a precondition the
 * UI must enforce, not a hint.
 */
export function legalParents(
  mailboxes: readonly MailboxRow[],
  subjectId: string,
  limits: MoveLimits,
): readonly (string | null)[] {
  const index = byId(mailboxes)
  const subject = index.get(subjectId)
  // A re-parent is a Mailbox/set update on the SUBJECT — there is no `mayMove` right, so `mayRename`
  // is the one that governs it (RFC 8621 §2).
  if (subject === undefined || !subject.myRights.mayRename) return []

  const height = subtreeDepth(mailboxes, subjectId)
  const withinDepth = (candidate: MailboxRow | null): boolean => {
    if (limits.maxMailboxDepth === null) return true // unlimited
    // 1-based, per RFC 8621: a top-level mailbox has depth 1. The subject lands one level under the
    // candidate, and its deepest descendant a further `height` down.
    const resulting = (candidate === null ? 0 : ancestorCount(index, candidate.id) + 1) + height + 1
    return resulting <= limits.maxMailboxDepth
  }
  const nameTaken = (parentId: string | null): boolean =>
    mailboxes.some(
      (other) =>
        other.id !== subjectId &&
        other.parentId === parentId &&
        other.name.toLowerCase() === subject.name.toLowerCase(),
    )

  const out: (string | null)[] = []
  if (
    limits.mayCreateTopLevelMailbox &&
    subject.parentId !== null && // already there — a no-op, not a move
    withinDepth(null) &&
    !nameTaken(null)
  ) {
    out.push(null)
  }
  for (const node of visibleRows(buildFolderTree(mailboxes), () => false)) {
    const candidate = node.mailbox
    if (candidate.id === subject.parentId) continue // no-op
    if (isSelfOrDescendant(mailboxes, subjectId, candidate.id)) continue
    // `mayCreateChild` is asked of the TARGET — it is the target that gains a child. (The tree's
    // "New subfolder" item asks it of the clicked mailbox, which is the same question there.)
    if (!candidate.myRights.mayCreateChild) continue
    if (!withinDepth(candidate)) continue
    if (nameTaken(candidate.id)) continue
    out.push(candidate.id)
  }
  return out
}

/** Flatten the tree to the currently-visible rows, skipping the subtrees of collapsed folders. */
export function visibleRows(
  tree: readonly FolderNode[],
  isCollapsed: (id: string) => boolean,
): FolderNode[] {
  const out: FolderNode[] = []
  const walk = (nodes: readonly FolderNode[]): void => {
    for (const node of nodes) {
      out.push(node)
      if (node.children.length > 0 && !isCollapsed(node.mailbox.id)) walk(node.children)
    }
  }
  walk(tree)
  return out
}
