/**
 * The parts of an event this screen can show but not yet edit (T11).
 *
 * `locations` had been asked of the server since M5.6 and displayed nowhere, so an event created in
 * another client looked emptier here than it was — and a reader had no way to tell "no location"
 * from "a location Waxwing does not show". The walkthrough found a meeting with a room and an
 * attendee and neither appeared anywhere in the app.
 *
 * **Participants used to be here and have MOVED (K-3).** They are editable now, on their own page
 * of the editor's navigation stack, so listing them again down here would be the same names twice
 * — once as a fact and once as a control. The reason they were read-only is gone: iMIP works on
 * this server, with `sendSchedulingMessages: true`, so a list of names does invite somebody.
 *
 * **A location is still read-only, and for its own reason.** Writing it back means patching a
 * `locations` map whose other members (coordinates, links, `relativeTo`) this client does not
 * model, so the cheap version of that feature is the one that quietly drops them.
 *
 * What matters until then is that saving does not DESTROY it, and it does not: an update sends a
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

export function EventFacts({ event }: { readonly event: CalendarEvent }) {
  const { t } = useTranslation()
  const locations = locationNames(event)

  // Nothing to say is said by saying nothing: an empty "Location: —" row is a field the dialog
  // does not have, dressed up as one it does.
  if (locations.length === 0) return null

  return (
    <dl className={styles.facts}>
      <dt className={styles.factLabel}>{t('calendar.event.location')}</dt>
      <dd className={styles.factValue}>{locations.join(', ')}</dd>
    </dl>
  )
}
