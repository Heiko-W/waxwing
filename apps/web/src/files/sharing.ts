/**
 * Who a file is shared with, and what they may do (M5.18, RFC 9670).
 *
 * The reasoning that used to live here — why three named roles rather than six checkboxes, why a
 * foreign combination is preserved as `custom` rather than snapped to the nearest role, why
 * `withGrant`/`withoutGrant` must carry every other grantee across — moved to `../sharing/roles.ts`
 * when mail folders needed the same model over a different set of keys (S-3). This file is now what
 * is left once that is factored out: the FileNode vocabulary, and the same six functions under the
 * same names, so nothing that imports them had to change.
 */

import type { FileNodeRights } from '@waxwing/jmap'
import { makeRoleModel, type RoleSpec } from '../sharing/roles'

export type { ShareRole, ShareRoleOrCustom } from '../sharing/roles'
export { SHARE_ROLES } from '../sharing/roles'

import type { ShareRole, ShareRoleOrCustom } from '../sharing/roles'

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
const SPEC: RoleSpec<FileNodeRights> = {
  none: NONE,
  roles: {
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
  },
}

export const fileRoles = makeRoleModel(SPEC)

/** The full six-boolean grant for a role. */
export function rightsFor(role: ShareRole): FileNodeRights {
  return fileRoles.rightsFor(role)
}

/** Which role these rights are, or `custom`. */
export function roleOf(rights: Partial<FileNodeRights> | null | undefined): ShareRoleOrCustom {
  return fileRoles.roleOf(rights)
}

/** Everyone this node is shared with, in a stable order for rendering. */
export function grantees(
  shareWith: Record<string, Partial<FileNodeRights>> | null | undefined,
): readonly { readonly principalId: string; readonly role: ShareRoleOrCustom }[] {
  return fileRoles.grantees(shareWith)
}

/** `shareWith` with `principalId` granted `role`. The rest are carried across untouched. */
export function withGrant(
  shareWith: Record<string, Partial<FileNodeRights>> | null | undefined,
  principalId: string,
  role: ShareRole,
): Record<string, FileNodeRights> {
  return fileRoles.withGrant(shareWith, principalId, role)
}

/** `shareWith` without `principalId`. Same warning as {@link withGrant}: the rest must survive. */
export function withoutGrant(
  shareWith: Record<string, Partial<FileNodeRights>> | null | undefined,
  principalId: string,
): Record<string, Partial<FileNodeRights>> {
  return fileRoles.withoutGrant(shareWith, principalId)
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
