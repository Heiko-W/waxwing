/**
 * Message-write permissions (M4.4, defect B34) — pure, React-free, one definition.
 *
 * Until M4.4 stage 4 nothing checked `myRights` for a MESSAGE write at all: rights gated folder
 * operations and move TARGETS only. That was harmless while every write silently landed on the
 * user's own account, where the rights are always granted. Stage 4 routes writes to the account they
 * belong to, so the write now really reaches a shared mailbox — and a refusal there is invisible
 * (defect B32: shared engines have a discarding status sink). "The action vanished" is worse than
 * "the action went somewhere else", which is why this exists.
 *
 * THE RULE. A write is permitted iff the account is not read-only AND every mailbox the rule
 * quantifies over grants the governing right:
 *
 * | Operation                       | Right             | Quantified over                          |
 * | ------------------------------- | ----------------- | ---------------------------------------- |
 * | `$seen` on/off                  | `maySetSeen`      | every mailbox of every subject message    |
 * | `$flagged`, labels, any keyword | `maySetKeywords`  | every mailbox of every subject message    |
 * | move `A → B`                    | `mayRemoveItems`(A) ∧ `mayAddItems`(B) | A and B — NOT the subjects' mailboxes |
 * | move with `from === null`       | `mayAddItems`(B)  | B alone — nothing is removed, it is a copy |
 * | destroy                         | `mayRemoveItems`  | every mailbox of every subject message    |
 *
 * NOT `sourceMailboxId`. An Email belongs to a SET of mailboxes, and the naive implementation — gate
 * on the folder the list happens to be showing — is wrong in both directions: it misses a denial in
 * another mailbox the message is also in, and it has no answer at all in a search or label view,
 * where there is no source folder. Joining `mailboxIds` makes those views fall out for free.
 *
 * ALL, not ANY. Stalwart enforces ANY (a write is accepted if *some* containing mailbox grants it).
 * We require ALL, which RFC 8621 §2 specifies and which is strictly the safer direction: this can
 * grey out something the server would have accepted, but it can never offer something the server
 * rejects. `maySetSeen` and `maySetKeywords` are also read separately even though Stalwart maps both
 * onto one ACL — other servers (Cyrus: IMAP `s` vs `w`) do distinguish them.
 *
 * AN AFFORDANCE, NEVER A BOUNDARY. RFC 8621 §9.5 lets a server deny on the strength of a mailbox the
 * client cannot even see, so this can correctly say "no" and can never authoritatively say "yes".
 * The server remains the authority; this only stops the UI from promising what it cannot deliver.
 *
 * WHAT IS UNKNOWN FAILS CLOSED — with one clause that keeps that from costing anything. If a subject
 * row is not hydrated, or names a mailbox the replica does not hold, the verdict is refusal. But
 * before consulting hydration we check the ACCOUNT FLOOR: when every mailbox in the account grants
 * right *k*, no unhydrated row could change the answer, so *k* is granted outright. On the user's own
 * account the server grants everything everywhere, so the floor is true, every verdict is true, and
 * the single-account path is provably unchanged — including a select-all reaching past the loaded
 * window, which would otherwise go dead. Deleting that clause is the regression to watch for.
 *
 * `MailAccount.isReadOnly` is ANDed in, never substituted for the above: Stalwart reports it `false`
 * even for a read-only share (verified against the live fixture), so it is a weak signal that can
 * refuse but never permit.
 */

import type { Id } from '@waxwing/jmap'
import type { EmailRow, MailboxRow } from '../sync'

/** The message operations rights are evaluated for. Moves have their own two-sided helpers. */
export type MessageOp = 'seen' | 'keywords' | 'destroy'

/** i18n keys for every refusal reason; the caller renders them. */
export const RIGHTS_REASON = {
  accountReadOnly: 'rights.unavailable.accountReadOnly',
  seen: 'rights.unavailable.seen',
  keywords: 'rights.unavailable.keywords',
  remove: 'rights.unavailable.remove',
  add: 'rights.unavailable.add',
  destroy: 'rights.unavailable.destroy',
  unknown: 'rights.unavailable.unknown',
} as const

export interface MessageRights {
  readonly maySetSeen: boolean
  readonly maySetKeywords: boolean
  readonly mayDestroy: boolean
  /** True when a `false` above is caused ONLY by an incomplete replica, not by a real denial. */
  readonly unknown: boolean
  /** The i18n key explaining why `op` is refused, or `null` when it is allowed. */
  reason(op: MessageOp): string | null
  /** Source half of a move: may the subjects leave `from`? `null` for a copy (`from === null`). */
  removeReason(from: Id | null): string | null
  /** Target half: does `to` accept messages? `null` when `to` is undefined (not a rights question). */
  addReason(to: Id | undefined): string | null
  /** Both halves, source first. */
  moveReason(from: Id | null, to: Id | undefined): string | null
}

export interface RightsInput {
  /** The subject rows; `undefined` while the query is unresolved. Holes are unhydrated ids. */
  readonly rows: readonly (EmailRow | undefined)[] | undefined
  /** How many ids were asked for — `rows.length !== total` means the answer is partial. */
  readonly total: number
  /** Every mailbox of the acting account; `undefined` while the liveQuery is unresolved. */
  readonly mailboxes: readonly MailboxRow[] | undefined
  /** `MailAccount.isReadOnly` for the acting account. */
  readonly accountReadOnly: boolean
}

type RightKey = 'maySetSeen' | 'maySetKeywords' | 'mayRemoveItems' | 'mayAddItems'

/** Everything granted — the degrade outside a ReplicaProvider, and the default in component tests. */
export const ALL_GRANTED: MessageRights = {
  maySetSeen: true,
  maySetKeywords: true,
  mayDestroy: true,
  unknown: false,
  reason: () => null,
  removeReason: () => null,
  addReason: () => null,
  moveReason: () => null,
}

export function messageRights(input: RightsInput): MessageRights {
  const { rows, total, mailboxes, accountReadOnly } = input

  const byId = new Map<Id, MailboxRow>((mailboxes ?? []).map((mailbox) => [mailbox.id, mailbox]))

  /** Does EVERY mailbox in the account grant `key`? Then no unhydrated row can change the verdict. */
  const floor = (key: RightKey): boolean =>
    mailboxes?.every((mailbox) => mailbox.myRights[key]) ?? false

  /** Every subject row present, and as many as were asked for. */
  const hydrated =
    rows !== undefined && rows.length === total && rows.every((row) => row !== undefined)

  /** `key` granted in every mailbox of every subject. A mailbox the replica lacks counts as denied. */
  const everySubject = (key: RightKey): boolean =>
    (rows ?? []).every((row) =>
      row === undefined
        ? false
        : Object.keys(row.mailboxIds).every(
            (mailboxId) => byId.get(mailboxId)?.myRights[key] === true,
          ),
    )

  const allow = (key: RightKey): boolean => {
    if (accountReadOnly) return false
    // Optimistic while the mailbox query is unresolved — the same shape the role-mailbox readiness
    // gate uses, so a control does not flicker "unavailable" for a tick on every mount.
    if (mailboxes === undefined) return true
    if (floor(key)) return true
    return hydrated && everySubject(key)
  }

  const maySetSeen = allow('maySetSeen')
  const maySetKeywords = allow('maySetKeywords')
  const mayDestroy = allow('mayRemoveItems')

  // A refusal is "unknown" only when the replica is incomplete AND the account floor did not already
  // settle it — that distinction is what the caller renders as "still checking" rather than "denied".
  const unknown =
    !accountReadOnly &&
    mailboxes !== undefined &&
    !hydrated &&
    !(floor('maySetSeen') && floor('maySetKeywords') && floor('mayRemoveItems'))

  const reasonFor = (granted: boolean, specific: string): string | null => {
    if (granted) return null
    if (accountReadOnly) return RIGHTS_REASON.accountReadOnly
    if (unknown) return RIGHTS_REASON.unknown
    return specific
  }

  /**
   * A SINGLE named mailbox — the source or target of a move.
   *
   * Unlike the `mailboxIds` join above, an id the replica does not hold is treated as GRANTED here,
   * and the asymmetry is deliberate. There, an unknown mailbox is a real risk: the message might be
   * in a folder that denies, and we would be permitting a write across it. Here the caller has named
   * one specific mailbox, and not holding its row is a gap in what we know, not evidence of a
   * denial — refusing on it would block ordinary moves whenever the tree has not synced yet, and it
   * would make this predicate disagree with the surfaces that DO hold the row and can judge properly.
   */
  const mailboxGrants = (mailboxId: Id, key: RightKey): boolean => {
    const row = byId.get(mailboxId)
    return row === undefined ? true : row.myRights[key] === true
  }

  const removeReason = (from: Id | null): string | null => {
    if (from === null) return null // a copy removes nothing
    if (accountReadOnly) return RIGHTS_REASON.accountReadOnly
    if (mailboxes === undefined) return null
    return mailboxGrants(from, 'mayRemoveItems') ? null : RIGHTS_REASON.remove
  }

  const addReason = (to: Id | undefined): string | null => {
    if (to === undefined) return null // structurally absent target — the caller's own gate covers it
    if (accountReadOnly) return RIGHTS_REASON.accountReadOnly
    if (mailboxes === undefined) return null
    return mailboxGrants(to, 'mayAddItems') ? null : RIGHTS_REASON.add
  }

  return {
    maySetSeen,
    maySetKeywords,
    mayDestroy,
    unknown,
    reason: (op) =>
      op === 'seen'
        ? reasonFor(maySetSeen, RIGHTS_REASON.seen)
        : op === 'keywords'
          ? reasonFor(maySetKeywords, RIGHTS_REASON.keywords)
          : reasonFor(mayDestroy, RIGHTS_REASON.destroy),
    removeReason,
    addReason,
    moveReason: (from, to) => removeReason(from) ?? addReason(to),
  }
}
