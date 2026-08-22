/**
 * Named roles over an arbitrary JMAP `shareWith` rights map (S-1 … S-4, S-2, RFC 9670).
 *
 * **Three of them fit most types and a fourth exists for exactly one.** The three are View / Edit /
 * Manage; the fourth, `freeBusy`, is the calendar's "availability only" and is described where it is
 * declared. Which roles a type offers is data in its {@link RoleSpec.order} — a global list would
 * have made "add a fourth" mean "add it everywhere", which is how the mail folder would have grown
 * a grant that says nothing.
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
 * signal to write a fourth role, not to bend one of these three. `calendar-roles.ts` is that signal taken
 * up: `mayReadFreeBusy` alone is a grant people ask for by name, so the calendar spec lists four.
 *
 * **Foreign combinations are preserved, not corrected.** An object shared by another client can
 * carry rights no role here produces. {@link RoleModel.roleOf} calls that `custom` and the UI leaves
 * it alone. Snapping it to the nearest role would silently change what someone else may do, which is
 * the kind of "helpful" that loses data.
 */

/**
 * What a grantee may do, as a name rather than N booleans.
 *
 * **Four names, and no object type offers all four.** `freeBusy` exists for the calendar alone: on
 * `Calendar.shareWith`, `mayReadFreeBusy` on its own is a real, familiar grant — "they may see that
 * I am busy, not what I am doing" — and it is the level iCloud and Google both expose by name. It
 * is not a variant of "View" and must never be collapsed into it: someone with `freeBusy` cannot
 * read a single title, and someone with "View" can read all of them.
 *
 * Which of the four a given type offers is DATA, in that type's {@link RoleSpec.order} — see
 * {@link RoleModel.roles}. There is no type that offers `freeBusy` and, say, not `manager`; the
 * order is nevertheless per spec rather than a global constant, because it is also the order the
 * picker lists and the list `roleOf` compares against, and a role a type does not have must not be
 * offerable there.
 */
export type ShareRole = 'freeBusy' | 'viewer' | 'editor' | 'manager'

/** A role, or the marker for rights that match none of them. */
export type ShareRoleOrCustom = ShareRole | 'custom'

/**
 * The three that fit a file node, a mail folder and an address book — least to most, so the safe
 * choice is the first one.
 *
 * `as const` rather than `readonly ShareRole[]`, and that is load-bearing: a spec annotated
 * `RoleSpec<R, BasicShareRole>` is then obliged to define exactly these three and no `freeBusy`
 * placeholder. Widening the type here would put a fourth, meaningless grant into every spec.
 */
export const SHARE_ROLES = ['viewer', 'editor', 'manager'] as const satisfies readonly ShareRole[]

/** The three roles {@link SHARE_ROLES} offers, as a type. */
export type BasicShareRole = (typeof SHARE_ROLES)[number]

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
export interface RoleSpec<R extends RightsMap<R>, Role extends ShareRole = ShareRole> {
  readonly none: R
  /**
   * The roles this type offers, least to most.
   *
   * It is BOTH the order the picker lists and the order {@link RoleModel.roleOf} compares in, which
   * is why it is one list rather than two. Least-first matters twice over: the picker's default is
   * the first entry, and `roleOf` returns the first match — so where two roles happened to produce
   * the same grant, the narrower name would win.
   */
  readonly order: readonly Role[]
  readonly roles: Readonly<Record<Role, R>>
}

/** One grantee, as the UI lists them. */
export interface Grantee {
  readonly principalId: string
  readonly role: ShareRoleOrCustom
}

/** The role model for one object type. */
export interface RoleModel<R extends RightsMap<R>, Role extends ShareRole = ShareRole> {
  /** The roles this type offers, least to most — {@link RoleSpec.order}, for the picker to render. */
  readonly roles: readonly Role[]
  /** The full grant for a role — a fresh object, never the spec's own. */
  rightsFor(role: Role): R
  /** Which role these rights are, or `custom`. */
  roleOf(rights: Partial<R> | null | undefined): ShareRoleOrCustom
  /** Everyone this object is shared with, in a stable order for rendering. */
  grantees(shareWith: Record<string, Partial<R>> | null | undefined): readonly Grantee[]
  /** `shareWith` with `principalId` granted `role`. */
  withGrant(
    shareWith: Record<string, Partial<R>> | null | undefined,
    principalId: string,
    role: Role,
  ): Record<string, R>
  /** `shareWith` without `principalId`. */
  withoutGrant(
    shareWith: Record<string, Partial<R>> | null | undefined,
    principalId: string,
  ): Record<string, Partial<R>>
}

export function makeRoleModel<R extends RightsMap<R>, Role extends ShareRole>(
  spec: RoleSpec<R, Role>,
): RoleModel<R, Role> {
  const keys = Object.keys(spec.none) as (keyof R & string)[]

  return {
    roles: spec.order,

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
      // `spec.order`, not a module-level list: a mail folder must never be reported as `freeBusy`
      // and a calendar must be able to be. The spec is the only thing that knows which.
      for (const role of spec.order) {
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
