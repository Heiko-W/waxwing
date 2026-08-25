/**
 * The incoming-share strip for the MAIL rail, at the foot of it (B61).
 *
 * ## Why it is its own component, and why it is at the bottom
 *
 * It used to render above the folder trees, inside the rail's one scroll container. A card
 * arriving mid-interaction — which is the only time it ever arrives, since it comes in on a sync
 * pass — therefore moved every row below it down by the card's height. The E2E suite met that as a
 * click on a folder's ⋯ button opening the folder instead (`element is not stable`, then
 * `<div role="treeitem"> intercepts pointer events`); a reader meets it as a menu that does not
 * open and a folder that opens instead, with no way to tell what happened.
 *
 * Nothing above an interactive row may grow. So the strip is now the LAST thing in the rail —
 * after the trees and after the labels — where an arriving card pushes nothing at all. That is
 * also why this is a component in `sharing/` rather than a few lines in `AccountTrees`: the
 * labels render as its sibling in `MailScreen`, so the strip had to leave the trees to get below
 * them.
 *
 * ## Two wrong turns after that, both measured rather than reasoned about
 *
 * "Below everything" was first built pinned — `position: sticky; inset-block-end: 0`, still inside
 * the scroll column — so the end would not also mean "out of sight". That stops the pushing and
 * replaces it with something worse: an opaque strip floating over the tree is a row nobody can
 * click. The shared-account suite failed six tests with `<section aria-label="New shares"> subtree
 * intercepts pointer events`, which is a reader unable to open Bob's Inbox, not a test artifact.
 *
 * It was then lifted OUT of the scroll column, as a footer beside `QuotaBar`. That overlays
 * nothing — and takes its height out of the scroll VIEWPORT instead: two cards are 236 px of a
 * 669 px rail, which leaves the trees a band short enough that a row can no longer be scrolled
 * fully into it. Playwright then clicks the row's centre, which lands in the strip. The same
 * interception, from a third direction.
 *
 * So it is the LAST BLOCK IN THE FLOW, and nothing else. There it costs the tree neither position
 * nor viewport. The cost it does carry is that a long rail must be scrolled to reveal it — the
 * trade the contacts and calendar rails already take with this same component, and the right one:
 * a missed notice is a notice, a covered row is a folder that cannot be opened.
 */

import { useCallback } from 'react'
import { useSession } from '../app/session/context'
import { useSelectMailbox, useSharedFolderNames } from '../mail/AccountTrees'
import { useActiveAccountId } from '../mail/active-account'
import { IncomingShares } from './IncomingShares'
import type { ShareAnnouncement } from './incoming'
import { useIncomingShares } from './use-incoming-shares'

export interface MailboxShareNoticesProps {
  /** Close the drawer after following a card, on the tiers that have one. */
  readonly onNavigate?: () => void
}

export function MailboxShareNotices({ onNavigate }: MailboxShareNoticesProps) {
  const incoming = useIncomingShares('Mailbox')
  const sharedNames = useSharedFolderNames(incoming.announcements)
  // Resolved the same way the rail resolves it: the stored account if there is one, the session's
  // own otherwise. A bare `useActiveAccountId()` is null before the first switch.
  const { connected } = useSession()
  const stored = useActiveAccountId()
  const selectMailbox = useSelectMailbox(stored ?? connected?.accountId ?? '', onNavigate)

  const openShare = useCallback(
    (announcement: ShareAnnouncement) => {
      // Both halves of the address, because a mailbox id alone is ambiguous: they are per-account
      // and short, and `a` exists in nearly every account.
      selectMailbox(announcement.accountId, announcement.objectId)
      // Read, and therefore done with. Leaving it up after the user has followed it would turn the
      // strip into a list of things they have already dealt with.
      incoming.dismiss(announcement.id)
    },
    [selectMailbox, incoming],
  )

  return (
    <IncomingShares
      announcements={incoming.announcements}
      nameOf={(announcement) =>
        sharedNames[`${announcement.accountId}/${announcement.objectId}`] ?? null
      }
      onOpen={openShare}
      onDismiss={incoming.dismiss}
    />
  )
}
