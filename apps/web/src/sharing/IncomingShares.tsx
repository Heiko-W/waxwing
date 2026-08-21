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
 */

import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, IconButton } from '../ui'
import type { ShareAnnouncement } from './incoming'
import styles from './incoming.module.css'

export interface IncomingSharesProps {
  readonly announcements: readonly ShareAnnouncement[]
  /** The shared object's display name, if the caller can resolve it — the server does not send one. */
  readonly nameOf?: (announcement: ShareAnnouncement) => string | null
  readonly onOpen: (announcement: ShareAnnouncement) => void
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
        const suffix = announcement.change === 'revoked' ? 'revoked' : 'mailbox'
        const message =
          name === null
            ? t(`sharing.incoming.${suffix}Unnamed`, { who })
            : t(`sharing.incoming.${suffix}`, { who, name })
        return (
          <div key={announcement.id} className={styles.card}>
            <p className={styles.text}>{message}</p>
            <div className={styles.actions}>
              {announcement.change === 'granted' && (
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
