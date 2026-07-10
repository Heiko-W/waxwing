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
