/**
 * Incoming shares — reading `ShareNotification` and turning it into something a person can act on
 * (S-1, RFC 9670 §3).
 *
 * Before this, `ShareNotification/*` had **no caller anywhere outside `packages/jmap`**: the server
 * has been telling Waxwing "carol just gave you her Projekt folder" since the day sharing was
 * typed, and nothing read the message. The only way to learn about a share was for the person who
 * made it to send an email saying so.
 *
 * ## What the server actually sends — measured against v0.16.18, 2026-08-21
 *
 * ```
 * { id, created, objectType: "Mailbox", objectAccountId: "d", objectId: "a",
 *   oldRights: {…}, newRights: {…}, name: "",
 *   changedBy: { principalId, name, email } }
 * ```
 *
 * Three of those fields do not behave as their names promise, and each one costs a design decision:
 *
 * 1. **`name` is the empty string, not the folder's name.** Every notification the fixture produced
 *    carried `""` — for mailboxes and for calendars alike. So the card cannot lead with the object's
 *    name from here; {@link describeShare} takes it as OPTIONAL and the caller supplies the name it
 *    already knows (the sidebar has the mailbox rows), falling back to a wording that needs none.
 *
 * 2. **`changedBy` can name the wrong person.** A share carol made through `Mailbox/set` arrived
 *    attributed to `{ principalId: "d333333", name: "Recovery admin account" }` — the same fixture,
 *    the same session, and a `Calendar/set` from that very account was attributed to Carol
 *    correctly. So `changedBy` is right for calendars and wrong for mailboxes on this build.
 *    {@link describeShare} therefore prefers a name the CALLER resolved from `objectAccountId` (the
 *    session lists shared accounts by name) and uses `changedBy` only as a fallback — and drops it
 *    entirely when it names an administrative account, because "Recovery admin account shared a
 *    folder with you" is worse than "Someone did".
 *
 * 3. **A revoke is a notification too.** `newRights` all-false with `oldRights` non-empty is access
 *    being TAKEN AWAY, and it arrives on the same channel as a grant. Announcing it as "Carol shared
 *    a folder with you" and offering an Open button that leads to a `forbidden` is the one outcome
 *    worth writing a branch for.
 *
 * Nothing here renders. `IncomingShares.tsx` is the surface; this is the part that can be tested
 * against the shapes the server really sends.
 */

import type { Id, JmapClient, ShareNotification } from '@waxwing/jmap'
import { Methods } from '@waxwing/jmap'

/** What a card says, resolved down to the two questions a reader has: who, and what happened. */
export interface ShareAnnouncement {
  readonly id: Id
  /** The account the shared object lives in — where "Open" has to navigate. */
  readonly accountId: Id
  /** The object's own id within that account. */
  readonly objectId: Id
  readonly objectType: string
  /** `granted` = access appeared; `revoked` = it was taken away. */
  readonly change: 'granted' | 'revoked'
  /** Whoever the change is attributable to, or `null` when nothing trustworthy names them. */
  readonly who: string | null
  /** ISO timestamp, for ordering. */
  readonly created: string
}

/**
 * Principal ids/names that are the server's own plumbing rather than a colleague.
 *
 * Stalwart attributes a mailbox ACL change to its recovery admin (see the module note). Naming that
 * account in a card would be actively misleading — it says a person did something they did not do.
 */
function isAdministrative(changedBy: ShareNotification['changedBy']): boolean {
  const email = changedBy.email?.trim().toLowerCase() ?? ''
  const name = changedBy.name?.trim().toLowerCase() ?? ''
  return email === 'admin' || name.includes('recovery admin')
}

/** Did this notification grant access, or take it away? */
function changeOf(notification: ShareNotification): 'granted' | 'revoked' {
  const now = Object.values(notification.newRights ?? {})
  // No rights left at all — or every one of them false — is a revoke. An empty `newRights` with an
  // empty `oldRights` cannot happen (the server would have nothing to report), so "nothing now"
  // reads as "something before".
  return now.length > 0 && now.some(Boolean) ? 'granted' : 'revoked'
}

/**
 * One notification, reduced to what a card needs.
 *
 * `accountName` is the caller's answer to "whose account is this" — resolved from the session, which
 * lists every shared account by name and is the ONLY source here that is reliably right (see the
 * module note on `changedBy`).
 */
export function describeShare(
  notification: ShareNotification,
  accountName: string | null = null,
): ShareAnnouncement {
  const attributed = isAdministrative(notification.changedBy)
    ? null
    : (notification.changedBy.name?.trim() ?? notification.changedBy.email?.trim() ?? null)
  const who = accountName?.trim() ?? (attributed === '' ? null : attributed)
  return {
    id: notification.id,
    accountId: notification.objectAccountId,
    objectId: notification.objectId,
    objectType: notification.objectType,
    change: changeOf(notification),
    who: who === '' ? null : who,
    created: notification.created,
  }
}

/** Newest first — a card that has just appeared belongs at the top. */
export function byNewestFirst(left: ShareAnnouncement, right: ShareAnnouncement): number {
  return right.created.localeCompare(left.created)
}

export interface IncomingSharesClient {
  /** Every outstanding notification on this account. */
  list(): Promise<readonly ShareNotification[]>
  /** Marks notifications as seen by destroying them — the RFC's only way to dismiss one. */
  dismiss(ids: readonly Id[]): Promise<void>
}

export function makeIncomingSharesClient(
  client: JmapClient,
  /** The user's OWN account: notifications live where the grantee is, not where the object is. */
  accountId: Id,
): IncomingSharesClient {
  return {
    async list() {
      /*
       * `/get` with `ids: null`, not `/query` + `/get`.
       *
       * A `ShareNotification/query` works (measured — it even reports `canCalculateChanges: true`),
       * but the set is inherently tiny: it holds only what the user has not yet dismissed, and
       * dismissing is a destroy. Paging a list whose natural length is nought to three costs a round
       * trip to save nothing.
       */
      const responses = await client.call([
        [Methods.shareNotificationGet.name, { accountId, ids: null }, 's0'],
      ])
      return responses.get<{ list: ShareNotification[] }>('s0').list
    },

    async dismiss(ids) {
      if (ids.length === 0) return
      /*
       * DESTROY is what "I have seen this" means here — RFC 9670 §3 gives a notification no read
       * flag, and the server creates a fresh one for the next change. So dismissing is not hiding a
       * card locally: it is telling the server, which is why it survives a reload and why every
       * other tab and device stops showing it too.
       */
      await client.call([
        [Methods.shareNotificationSet.name, { accountId, destroy: [...ids] }, 's0'],
      ])
    },
  }
}
