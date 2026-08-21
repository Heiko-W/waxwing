/**
 * Three named roles over an arbitrary JMAP `shareWith` rights map (S-1 … S-4, RFC 9670).
 *
 * Every shareable JMAP object — `FileNode`, `Mailbox`, `Calendar`, `AddressBook` — spells its grant
 * the same way: `shareWith` is principal id → a flat map of independent booleans. The number of
 * booleans differs (six on a file node, ten on a mailbox), the shape does not, and the reason not to
 * show them as checkboxes does not either: most combinations are nonsense (`mayDelete` without
 * `mayRead` deletes what you cannot see), and the one right whose consequences leave the owner's
 * hands — `mayShare`, which lets the grantee grant — would sit in the list looking like any other.
 *
 * So this file holds the *pattern* and each object type supplies its own {@link RoleSpec}: which
 * keys exist and what each role means for them. It was lifted verbatim out of `files/sharing.ts`
 * (which now binds it to the file-node spec and re-exports the same names it always had) rather
 * than written afresh, because that code was the one sharing UI in the app that worked.
 *
 * **The pattern does not fit everywhere, and pretending otherwise is the failure mode.** A mailbox
 * needs "view" to withhold `maySetSeen` — a reader who cannot help marking the owner's post as read
 * is not a viewer — and needs `maySubmit` false in *all three* roles (ADR-020). That is expressed as
 * data in `mailbox.ts`, not as an exception here; a spec whose roles do not describe a type is a
 * signal to write a fourth role, not to bend one of these three.
 *
 * **Foreign combinations are preserved, not corrected.** An object shared by another client can
 * carry rights no role here produces. {@link RoleModel.roleOf} calls that `custom` and the UI leaves
 * it alone. Snapping it to the nearest role would silently change what someone else may do, which is
 * the kind of "helpful" that loses data.
 */

/** What a grantee may do, as a name rather than N booleans. */
export type ShareRole = 'viewer' | 'editor' | 'manager'

/** A role, or the marker for rights that match none of them. */
export type ShareRoleOrCustom = ShareRole | 'custom'

/** The order they are offered in — least to most, so the safe choice is the first one. */
export const SHARE_ROLES: readonly ShareRole[] = ['viewer', 'editor', 'manager']

/**
 * Any JMAP rights object: a flat record of independent booleans.
 *
 * Written as a self-referential mapped type rather than `Record<string, boolean>` on purpose.
 * `FileNodeRights` and `MailboxRights` are INTERFACES, and TypeScript gives an interface no implicit
 * index signature — so `R extends Record<string, boolean>` rejects both of the two types this file
 * exists to serve. `{ [K in keyof R]: boolean }` asks the question that was actually meant: are all
 * of R's own properties booleans?
 */
export type RightsMap<R = Record<string, boolean>> = { [K in keyof R]: boolean }

/**
 * One object type's answer to "what do the three roles mean here".
 *
 * `none` is the all-false grant and doubles as the KEY LIST: {@link RoleModel.roleOf} compares over
 * exactly its keys, so a key missing from `none` is a right this client neither grants nor notices.
 * That is why each spec writes every measured key out in full instead of spreading a partial.
 */
export interface RoleSpec<R extends RightsMap<R>> {
  readonly none: R
  readonly roles: Readonly<Record<ShareRole, R>>
}

/** One grantee, as the UI lists them. */
export interface Grantee {
  readonly principalId: string
  readonly role: ShareRoleOrCustom
}

/** The role model for one object type. */
export interface RoleModel<R extends RightsMap<R>> {
  /** The full grant for a role — a fresh object, never the spec's own. */
  rightsFor(role: ShareRole): R
  /** Which role these rights are, or `custom`. */
  roleOf(rights: Partial<R> | null | undefined): ShareRoleOrCustom
  /** Everyone this object is shared with, in a stable order for rendering. */
  grantees(shareWith: Record<string, Partial<R>> | null | undefined): readonly Grantee[]
  /** `shareWith` with `principalId` granted `role`. */
  withGrant(
    shareWith: Record<string, Partial<R>> | null | undefined,
    principalId: string,
    role: ShareRole,
  ): Record<string, R>
  /** `shareWith` without `principalId`. */
  withoutGrant(
    shareWith: Record<string, Partial<R>> | null | undefined,
    principalId: string,
  ): Record<string, Partial<R>>
}

export function makeRoleModel<R extends RightsMap<R>>(spec: RoleSpec<R>): RoleModel<R> {
  const keys = Object.keys(spec.none) as (keyof R & string)[]

  return {
    rightsFor(role) {
      return { ...spec.roles[role] }
    },

    /*
     * Compared as a WHOLE rather than by "does it have mayRead": partial rights set by another
     * client are a real case (the server normalises an incomplete grant by filling the rest with
     * `false`, so they arrive here complete but arbitrary — measured on Stalwart v0.16.18, where a
     * `Mailbox/set` of `{ mayReadItems: true }` reads back as all ten keys), and the answer for them
     * must be `custom`.
     */
    roleOf(rights) {
      if (rights === null || rights === undefined) return 'custom'
      const full = { ...spec.none, ...rights } as R
      for (const role of SHARE_ROLES) {
        const candidate = spec.roles[role]
        if (keys.every((key) => full[key] === candidate[key])) return role
      }
      return 'custom'
    },

    grantees(shareWith) {
      return Object.entries(shareWith ?? {})
        .map(([principalId, rights]) => ({ principalId, role: this.roleOf(rights) }))
        .sort((left, right) => left.principalId.localeCompare(right.principalId))
    },

    /*
     * Returns a NEW map: every other grantee is carried across untouched, because a `Foo/set`
     * replaces the whole property and anyone dropped from it silently loses their access.
     */
    withGrant(shareWith, principalId, role) {
      return { ...(shareWith ?? {}), [principalId]: this.rightsFor(role) } as Record<string, R>
    },

    /** Same warning as {@link RoleModel.withGrant}: the rest must survive. */
    withoutGrant(shareWith, principalId) {
      const next = { ...(shareWith ?? {}) }
      delete next[principalId]
      return next
    },
  }
}
