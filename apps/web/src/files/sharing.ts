/**
 * Who a file is shared with, and what they may do (M5.18, RFC 9670).
 *
 * `FileNode.shareWith` is a map from principal id to six independent booleans. Six checkboxes is
 * what that shape suggests and the wrong thing to build: the combinations are mostly nonsense
 * (`mayDelete` without `mayRead` deletes what you cannot see), and the one right whose
 * consequences leave the owner's hands — `mayShare`, which lets the grantee grant — would sit in
 * the list looking like any other. Three named roles say what the user means.
 *
 * **Foreign combinations are preserved, not corrected.** A node shared by another client can carry
 * rights no role here produces. `roleOf` calls that `custom` and the UI leaves it alone. Snapping
 * it to the nearest role would silently change what someone else can do to a file, which is the
 * kind of "helpful" that loses data.
 */

import type { FileNodeRights } from '@waxwing/jmap'

/** What a grantee may do, as a name rather than six booleans. */
export type ShareRole = 'viewer' | 'editor' | 'manager'

/** A role, or the marker for rights that match none of them. */
export type ShareRoleOrCustom = ShareRole | 'custom'

/** The order they are offered in — least to most, so the safe choice is the first one. */
export const SHARE_ROLES: readonly ShareRole[] = ['viewer', 'editor', 'manager']

const NONE: FileNodeRights = {
  mayRead: false,
  mayAddChildren: false,
  mayRename: false,
  mayDelete: false,
  mayModifyContent: false,
  mayShare: false,
}

/**
 * The rights each role grants.
 *
 * `mayShare` belongs to `manager` alone. It is the right that hands out rights, so a grantee who
 * has it can widen access the owner never approved — and there is no notification that would tell
 * them. Naming the role "manager" is the honest label for that.
 */
const ROLE_RIGHTS: Record<ShareRole, FileNodeRights> = {
  viewer: { ...NONE, mayRead: true },
  editor: {
    ...NONE,
    mayRead: true,
    mayAddChildren: true,
    mayRename: true,
    mayDelete: true,
    mayModifyContent: true,
  },
  manager: {
    mayRead: true,
    mayAddChildren: true,
    mayRename: true,
    mayDelete: true,
    mayModifyContent: true,
    mayShare: true,
  },
}

/** The full six-boolean grant for a role. */
export function rightsFor(role: ShareRole): FileNodeRights {
  return { ...ROLE_RIGHTS[role] }
}

/**
 * Which role these rights are, or `custom`.
 *
 * Compared as a whole rather than by "does it have mayRead": partial rights set by another client
 * are a real case (the server normalises an incomplete grant by filling the rest with `false`, so
 * they arrive here complete but arbitrary), and the answer for them must be `custom`.
 */
export function roleOf(rights: Partial<FileNodeRights> | null | undefined): ShareRoleOrCustom {
  if (rights === null || rights === undefined) return 'custom'
  const full: FileNodeRights = { ...NONE, ...rights }
  for (const role of SHARE_ROLES) {
    const candidate = ROLE_RIGHTS[role]
    const same = (Object.keys(NONE) as (keyof FileNodeRights)[]).every(
      (key) => full[key] === candidate[key],
    )
    if (same) return role
  }
  return 'custom'
}

/** Everyone this node is shared with, in a stable order for rendering. */
export function grantees(
  shareWith: Record<string, Partial<FileNodeRights>> | null | undefined,
): readonly { readonly principalId: string; readonly role: ShareRoleOrCustom }[] {
  return Object.entries(shareWith ?? {})
    .map(([principalId, rights]) => ({ principalId, role: roleOf(rights) }))
    .sort((left, right) => left.principalId.localeCompare(right.principalId))
}

/**
 * `shareWith` with `principalId` granted `role`.
 *
 * Returns a NEW map: every other grantee is carried across untouched, because a `FileNode/set`
 * replaces the whole property and anyone dropped from it silently loses their access.
 */
export function withGrant(
  shareWith: Record<string, Partial<FileNodeRights>> | null | undefined,
  principalId: string,
  role: ShareRole,
): Record<string, FileNodeRights> {
  return { ...(shareWith ?? {}), [principalId]: rightsFor(role) } as Record<string, FileNodeRights>
}

/** `shareWith` without `principalId`. Same warning as {@link withGrant}: the rest must survive. */
export function withoutGrant(
  shareWith: Record<string, Partial<FileNodeRights>> | null | undefined,
  principalId: string,
): Record<string, Partial<FileNodeRights>> {
  const next = { ...(shareWith ?? {}) }
  delete next[principalId]
  return next
}

/**
 * Whether this node can be shared at all.
 *
 * `mayShare` on the node is the server's answer for the CURRENT user — an owner has it, a grantee
 * usually does not. Offering the button anyway would produce a refusal the user cannot act on.
 */
export function mayShare(rights: FileNodeRights): boolean {
  return rights.mayShare
}
