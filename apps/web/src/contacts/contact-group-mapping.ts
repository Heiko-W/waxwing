/**
 * Lossless {@link ContactCard} ⇄ group-draft mapping (M4.2, stage 6a). A contact GROUP is a
 * ContactCard with `kind: 'group'` (RFC 9553 §2.1.4 / RFC 9610); its membership is the `members`
 * set — a `Record<uid, true>` of the JSContact **`uid`** of each member card (RFC 9553 §2.1.6), NOT
 * their JMAP `id`. This module is the group analogue of {@link ./contact-card-mapping}, kept
 * deliberately small because a group only edits two things — its name and its member set.
 *
 * The two invariants of {@link ./contact-card-mapping} still hold:
 *
 *  1. **Nothing the form does not know about is dropped.** {@link groupToNextCard} folds the draft
 *     onto `base` (`{ ...base, name, members }`), so `uid`, `addressBookIds`, `vCardProps`, `keywords`
 *     and every other unmapped `Card` property ride through untouched.
 *  2. **A minimal patch.** {@link diffGroupPatch} emits `name` / `members` only when they actually
 *     changed (compared with the SHARED {@link deepEqual} of {@link ./contact-card-mapping}), each
 *     replaced whole or `null`-removed (RFC 8620 §5.3) — the shape {@link enqueueUpdateContactCard}
 *     forwards verbatim. A rename is a one-key patch; a membership edit is a one-key patch.
 *
 * Pure and id-source-injectable, so a test pins the create shape, the rename patch and the
 * add/remove-member patch deterministically.
 */

import type { ContactCard, Id, PatchObject } from '@waxwing/jmap'
import type { BooleanSet, Name } from '@waxwing/jscontact'
import { deepEqual } from './contact-card-mapping'
import { contactDisplayName } from './contact-fields'

/** A client-generated, collision-free key source (injectable for deterministic tests). */
export type IdSource = () => Id

/** The editable surface of a group: a display name and an ORDERED list of member uids. */
export interface GroupDraft {
  readonly name: string
  /** Member JSContact `uid`s (order preserved for the UI; the stored `members` set is unordered). */
  readonly memberUids: readonly string[]
}

/** A card is a group iff its `kind` is `'group'` (RFC 9553 §2.1.4). */
export function isGroupCard(card: Partial<ContactCard>): boolean {
  return card.kind === 'group'
}

/** The member uids of a group card, in stored order (`[]` for a non-group or empty group). */
export function groupMemberUids(card: Partial<ContactCard>): string[] {
  return Object.keys(card.members ?? {})
}

/** A group card → its editable draft (name + member uids). */
export function groupToDraft(card: Partial<ContactCard>): GroupDraft {
  return { name: groupName(card), memberUids: groupMemberUids(card) }
}

/** The group's display name — its `name.full`, falling back to the shared display-name helper. */
export function groupName(card: Partial<ContactCard>): string {
  return (card.name?.full ?? contactDisplayName(card)).trim()
}

/** A `members` set from an ordered uid list, or `undefined` when empty (an empty set is not written). */
function toMembers(uids: readonly string[]): BooleanSet | undefined {
  const out: Record<string, true> = {}
  for (const uid of uids) {
    if (uid !== '') out[uid] = true
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The `name` object for a draft, reusing the original when the text is unchanged (so an imported
 * group's `sortAs` / components / ordering survive a membership-only edit) and otherwise writing a
 * `full`-only name. `undefined` when the name is cleared.
 */
function draftToName(name: string, original: Name | undefined): Name | undefined {
  const trimmed = name.trim()
  if (
    original !== undefined &&
    (original.full ?? contactDisplayName({ name: original })).trim() === trimmed
  ) {
    return original
  }
  if (trimmed === '') return undefined
  return { '@type': 'Name', full: trimmed }
}

/** Fold a draft onto `base`, overriding only `name` and `members` (everything else rides through). */
export function groupToNextCard(draft: GroupDraft, base: ContactCard): ContactCard {
  const result: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) }
  const name = draftToName(draft.name, base.name)
  const members = toMembers(draft.memberUids)
  if (name === undefined) delete result.name
  else result.name = name
  if (members === undefined) delete result.members
  else result.members = members
  return result as unknown as ContactCard
}

/**
 * A brand-new group card from a draft. `id` is a placeholder ({@link enqueueCreateContactCard}
 * overwrites it with the creation id); `uid` is the STABLE JSContact identity other cards' `members`
 * sets reference, so it is minted here and never rewritten.
 */
export function createGroupCard(draft: GroupDraft, bookId: Id, newId: IdSource): ContactCard {
  const uid = newId()
  const seed: ContactCard = {
    '@type': 'Card',
    version: '1.0',
    uid,
    id: newId(),
    addressBookIds: { [bookId]: true },
    kind: 'group',
  }
  return groupToNextCard(draft, seed)
}

/** Top-level properties a group edit owns — the only keys {@link diffGroupPatch} may emit. */
const CONTROLLED_PROPS = ['name', 'members'] as const

/**
 * A minimal {@link PatchObject} between the original group card and the draft's reconstruction: at
 * most one entry each for `name` and `members`, present only when changed, replaced whole (or `null`
 * to remove). A rename is `{ name }`; a membership edit is `{ members }`; both changed is both keys.
 */
export function diffGroupPatch(original: ContactCard, draft: GroupDraft): PatchObject {
  const next = groupToNextCard(draft, original)
  const patch: PatchObject = {}
  const originalRecord = original as unknown as Record<string, unknown>
  const nextRecord = next as unknown as Record<string, unknown>
  for (const key of CONTROLLED_PROPS) {
    const before = originalRecord[key]
    const after = nextRecord[key]
    if (before === undefined && after === undefined) continue
    if (deepEqual(before, after)) continue
    patch[key] = after === undefined ? null : after
  }
  return patch
}
