/**
 * "Carol shared the folder ‘Projekt’ with you — Open / Hide" (S-1).
 *
 * A quiet card at the top of the rail the share belongs to, and everything about that sentence is a
 * decision made against the alternatives:
 *
 * - **Not a modal.** Somebody else's action interrupting the reader's is the wrong trade every time;
 *   a share is news, not a question.
 * - **Not a red badge.** A count implies a backlog to work through. This is one line that is true
 *   until it is read, and then it is gone.
 * - **In the rail the share affects**, not in a global notification area — because the answer to
 *   "where is it then?" is three centimetres below the card.
 * - **Hide destroys the notification server-side**, not locally: RFC 9670 gives a `ShareNotification`
 *   no read flag, so a destroy is what "seen" means, and it is what makes the card stay gone on the
 *   user's other devices too.
 *
 * A REVOKE is announced too and has no Open button — offering one would lead to a `forbidden`. That
 * branch exists because the server sends revokes on the same channel as grants (measured: all-false
 * `newRights` against a populated `oldRights`).
 *
 * ## It says WHAT was shared, and `onOpen` is optional (S-2)
 *
 * The card used to be able to say one noun, "folder", because mail was the only rail that had one.
 * Calendars and address books arrive on the same channel with `objectType: "Calendar"` /
 * `"AddressBook"` (measured — one notification per type), and "Carol shared the folder with you"
 * over a calendar is worse than no card at all. {@link WORDING} is that lookup, written out per type
 * rather than assembled from a noun key, so a translator sees whole sentences.
 *
 * **`onOpen` is optional and calendars/contacts pass nothing**, which is the honest state of the
 * app rather than an oversight. Following the card means opening someone ELSE's calendar or address
 * book, and neither rail can scope itself to a foreign account yet: `sharing/probe.ts` deliberately
 * has no `calendar` area, and the contacts screen is wired to `connected.accountId`. An Open button
 * that led back to the reader's own empty rail would be a promise the app cannot keep — so the card
 * announces the share, and the only action on it is to put it away.
 */

import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, IconButton } from '../ui'
import type { ShareAnnouncement } from './incoming'
import styles from './incoming.module.css'

/** The locale-key stems for one object type: what to say when the name is known, and when it is not. */
interface Wording {
  /** `sharing.incoming.<granted>` — takes `who` and `name`. */
  readonly granted: string
  /** `sharing.incoming.<grantedUnnamed>` — takes `who` alone. */
  readonly grantedUnnamed: string
  /**
   * `sharing.incoming.<revokedUnnamed>` — takes `who` alone.
   *
   * There is no per-type key for a NAMED revoke: `sharing.incoming.revoked` says "withdrew your
   * access to X", which needs no noun and is already true for all four types.
   */
  readonly revokedUnnamed: string
}

/**
 * `ShareNotification.objectType` → what the card says.
 *
 * The keys are the server's own strings, verbatim from the measured notifications. `FileNode`
 * is absent on purpose: nothing subscribes the strip to it yet, and an entry here would claim a
 * surface that does not exist. Anything unrecognised falls back to {@link OTHER}, which says
 * "something" — vague, but never wrong about what it is.
 */
const WORDING: Readonly<Record<string, Wording>> = {
  Mailbox: {
    granted: 'mailbox',
    grantedUnnamed: 'mailboxUnnamed',
    revokedUnnamed: 'revokedUnnamed',
  },
  Calendar: {
    granted: 'calendar',
    grantedUnnamed: 'calendarUnnamed',
    revokedUnnamed: 'revokedCalendarUnnamed',
  },
  AddressBook: {
    granted: 'addressBook',
    grantedUnnamed: 'addressBookUnnamed',
    revokedUnnamed: 'revokedAddressBookUnnamed',
  },
}

const OTHER: Wording = {
  granted: 'object',
  grantedUnnamed: 'objectUnnamed',
  revokedUnnamed: 'revokedObjectUnnamed',
}

/** Which sentence a card uses. Exported for the test that pins each type to its own wording. */
export function wordingFor(objectType: string): Wording {
  return WORDING[objectType] ?? OTHER
}

export interface IncomingSharesProps {
  readonly announcements: readonly ShareAnnouncement[]
  /** The shared object's display name, if the caller can resolve it — the server does not send one. */
  readonly nameOf?: (announcement: ShareAnnouncement) => string | null
  /**
   * Follow the share. **Omitted where nothing can follow it** — see the module note; the card then
   * carries Hide alone rather than a button that leads to the reader's own empty rail.
   */
  readonly onOpen?: ((announcement: ShareAnnouncement) => void) | undefined
  readonly onDismiss: (id: string) => void
}

export function IncomingShares({ announcements, nameOf, onOpen, onDismiss }: IncomingSharesProps) {
  const { t } = useTranslation()
  if (announcements.length === 0) return null

  return (
    // A named region rather than a bare div: it appears without the user asking, so assistive tech
    // needs a way to find it and a way to skip it. NOT a live region — see the module note on why
    // this must not interrupt.
    <section className={styles.strip} aria-label={t('sharing.incoming.region')}>
      {announcements.map((announcement) => {
        const who = announcement.who ?? t('sharing.incoming.someone')
        const name = nameOf?.(announcement) ?? null
        const wording = wordingFor(announcement.objectType)
        const revoked = announcement.change === 'revoked'
        const message =
          name === null
            ? t(`sharing.incoming.${revoked ? wording.revokedUnnamed : wording.grantedUnnamed}`, {
                who,
              })
            : t(`sharing.incoming.${revoked ? 'revoked' : wording.granted}`, { who, name })
        return (
          <div key={announcement.id} className={styles.card}>
            <p className={styles.text}>{message}</p>
            <div className={styles.actions}>
              {announcement.change === 'granted' && onOpen !== undefined && (
                <Button size="sm" variant="ghost" onClick={() => onOpen(announcement)}>
                  {t('sharing.incoming.open')}
                </Button>
              )}
              <IconButton
                label={t('sharing.incoming.dismissOne')}
                size="sm"
                variant="ghost"
                onClick={() => onDismiss(announcement.id)}
              >
                <X />
              </IconButton>
            </div>
          </div>
        )
      })}
    </section>
  )
}
