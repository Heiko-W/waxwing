/**
 * The parts of an event this screen can show but not yet edit (T11).
 *
 * `locations` and `participants` have been asked of the server since M5.6 and displayed nowhere, so
 * an event created in another client looked emptier here than it was — and a reader had no way to
 * tell "no location" from "a location Waxwing does not show". The walkthrough found a meeting with
 * a room and an attendee and neither appeared anywhere in the app.
 *
 * **Read-only on purpose, and the two halves have different reasons.** Attendees mean iTIP —
 * invitations, replies, cancellations — and a list of names that never invites anybody is the more
 * expensive kind of wrong. A location alone would be easy, but writing it back means patching a
 * `locations` map whose other members (coordinates, links, `relativeTo`) this client does not model,
 * so the cheap version of that feature is the one that quietly drops them. Both belong to the event
 * editor that is still to be written, not to this dialog.
 *
 * What matters until then is that saving does not DESTROY them, and it does not: an update sends a
 * JMAP patch naming only the fields the editor owns, so anything it cannot show it also cannot
 * touch (see `draftToEvent`, and the test that pins it).
 */

import type { CalendarEvent } from '@waxwing/jmap'
import { useTranslation } from 'react-i18next'
import styles from './calendar.module.css'

/** The location names an event carries, in the order the server listed them. */
export function locationNames(event: CalendarEvent): string[] {
  return Object.values(event.locations ?? {})
    .map((location) => location?.name ?? '')
    .filter((name) => name.trim() !== '')
}

/**
 * The participants an event carries, by the best name each one has.
 *
 * Falls back from `name` to `email`: a participant added by a client that only knew an address has
 * no display name, and "someone@example.test" is information where a blank line is not.
 */
export function participantNames(event: CalendarEvent): string[] {
  return Object.values(event.participants ?? {})
    .map((participant) => participant?.name ?? participant?.email ?? '')
    .filter((name) => name.trim() !== '')
}

export function EventFacts({ event }: { readonly event: CalendarEvent }) {
  const { t } = useTranslation()
  const locations = locationNames(event)
  const participants = participantNames(event)

  // Nothing to say is said by saying nothing: an empty "Location: —" row is a field the dialog
  // does not have, dressed up as one it does.
  if (locations.length === 0 && participants.length === 0) return null

  return (
    <dl className={styles.facts}>
      {locations.length > 0 && (
        <>
          <dt className={styles.factLabel}>{t('calendar.event.location')}</dt>
          <dd className={styles.factValue}>{locations.join(', ')}</dd>
        </>
      )}
      {participants.length > 0 && (
        <>
          <dt className={styles.factLabel}>{t('calendar.event.participants')}</dt>
          <dd className={styles.factValue}>{participants.join(', ')}</dd>
        </>
      )}
    </dl>
  )
}
