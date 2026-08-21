/**
 * The calendars themselves (K-1, FR-CAL-01): make one, rename it, colour it, hide it, delete it.
 *
 * `Calendar/set` had been typed since M5.6 and had **no caller at all**, so a reader could see
 * their calendars and do nothing whatever with them. The consequence that justifies the work is not
 * the create button, though — it is the tick:
 *
 * **Hiding is server state, not a local filter.** `isVisible` goes to the server, so a calendar
 * switched off here is switched off in the calendar app on the phone as well, and the range query
 * stops asking for it (`eventsInRange(from, to, visibleIds)` — a parameter that existed since M5.6
 * and had no caller either). A local filter would have looked identical on this screen and been a
 * lie everywhere else.
 *
 * **Shape, and why it is Apple's.** One row is a checkbox tinted with the calendar's colour and the
 * calendar's name — no per-row toolbar, no gear, nothing else competing for the row. That is the
 * iOS calendar list and the macOS sidebar both. Editing hides behind a `⋯` at the end of the row,
 * which is the one place this departs from "a dot, a tick and a name": iOS puts an ⓘ there for
 * exactly this purpose, and a list whose only route to renaming is a long-press is a list where
 * renaming does not exist for a keyboard.
 *
 * **Rights decide what is on the row, not whether it is refused afterwards.** A calendar the reader
 * cannot write to has no `⋯` at all; a calendar that is the account default, or that
 * `myRights.mayDelete` denies, has a `⋯` without a Delete. Offering a control that the server will
 * refuse is how a UI teaches people to distrust it.
 *
 * **Delete asks first, and it is the only control on this screen that does.** An event is deleted
 * with an Undo in the toast, because the inverse of destroying an event is creating it. A calendar
 * has no inverse: measured, Stalwart refuses to destroy a non-empty calendar at all unless the
 * client sends `onDestroyRemoveEvents: true`, and then it takes every event with it. `create` plus
 * n × `CalendarEvent/set` would be a re-enactment with new ids, new uids and no attendee history —
 * so the honest control is a question beforehand, naming the calendar and counting what goes with
 * it.
 */

import type { Calendar } from '@waxwing/jmap'
import { CalendarPlus, MoreHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Checkbox, IconButton, Menu } from '../ui'
import styles from './calendar.module.css'

/**
 * Is this calendar drawn?
 *
 * **Only `false` hides it.** `undefined` means the property was not asked for, or the server does
 * not send it — and reading that as "hidden" empties the whole screen on any server that does not
 * implement `isVisible`. The rule is one-sided on purpose (see `Calendar.isVisible`).
 */
export function isCalendarVisible(calendar: Calendar): boolean {
  return calendar.isVisible !== false
}

/** The ids whose events the range query should ask for. */
export function visibleCalendarIds(calendars: readonly Calendar[]): string[] {
  return calendars.filter(isCalendarVisible).map((calendar) => calendar.id)
}

/** May the reader change this calendar's name and colour? */
export function mayEdit(calendar: Calendar): boolean {
  return calendar.myRights?.mayWriteAll === true
}

/**
 * May the reader delete this calendar?
 *
 * The default calendar is excluded **by this client**, not by the server: measured against Stalwart
 * v0.16.18, `destroy` on the account's default calendar succeeds, `isDefault` cannot be set in
 * `create` or `update` ("Field could not be set."), and the flag turns out to belong to the DAV
 * collection literally named `default` — so nothing reachable over JMAP can appoint a replacement.
 * Deleting it is therefore a one-way door with no handle on the other side, and it is not offered.
 */
export function mayDelete(calendar: Calendar): boolean {
  return calendar.isDefault !== true && calendar.myRights?.mayDelete === true
}

export interface CalendarListProps {
  readonly calendars: readonly Calendar[]
  /**
   * Whether to draw the "Calendars" heading above the list.
   *
   * `false` inside the phone sheet, whose dialog title already says it — two headings one line
   * apart read as two sections, and there is only one.
   */
  readonly heading?: boolean
  /** `false` while the session says the account may not create one, or while offline. */
  readonly canCreate: boolean
  /** Every control is disabled while a calendar write is in flight, or while offline. */
  readonly disabled: boolean
  onToggle: (calendar: Calendar, visible: boolean) => void
  onCreate: () => void
  onEdit: (calendar: Calendar) => void
  onDelete: (calendar: Calendar) => void
}

export function CalendarList(props: CalendarListProps) {
  const { t } = useTranslation()

  return (
    <div className={styles.calendars}>
      {/* The heading row exists only in the rail. In the sheet the dialog's own title already says
          "Calendars", and the create control becomes a labelled row at the end of the list — which
          is where iOS puts "Add Calendar", and reads far better than one icon alone above a list. */}
      {props.heading !== false && (
        <div className={styles.calendarsHead}>
          <h2 className={styles.railTitle}>{t('calendar.calendars.title')}</h2>
          {props.canCreate && (
            <IconButton
              label={t('calendar.calendars.create')}
              variant="ghost"
              size="sm"
              disabled={props.disabled}
              onClick={props.onCreate}
            >
              <CalendarPlus />
            </IconButton>
          )}
        </div>
      )}
      {props.calendars.length === 0 ? (
        <p className={styles.railEmpty}>{t('calendar.calendars.empty')}</p>
      ) : (
        <ul className={styles.calendarList}>
          {props.calendars.map((calendar) => (
            <li key={calendar.id} className={styles.calendarRow}>
              {/*
                The checkbox IS the coloured dot. A separate swatch beside a plain tick would put two
                circles on a row that Apple draws with one, and the tick — not the colour — is what
                carries "shown" (WCAG 1.4.1): `accent-color` only tints a control whose state is
                already announced by `checked`.
              */}
              {/* Wrapped rather than given a `className`: `Checkbox` forwards that to the INPUT,
                  so `flex: 1` on it stretched the 1.15rem box across the row and left the tick with
                  no width at all. The span is what has to take the room. */}
              <span className={styles.calendarTick}>
                <Checkbox
                  checked={isCalendarVisible(calendar)}
                  disabled={props.disabled}
                  {...(calendar.color === null || calendar.color === undefined
                    ? {}
                    : { style: { accentColor: calendar.color } })}
                  label={<span className={styles.calendarName}>{calendar.name}</span>}
                  onChange={(event) => props.onToggle(calendar, event.target.checked)}
                />
              </span>
              {mayEdit(calendar) && (
                <Menu
                  triggerLabel={t('calendar.calendars.menu', { name: calendar.name })}
                  trigger={<MoreHorizontal aria-hidden="true" />}
                  triggerVariant="ghost"
                  align="end"
                  items={[
                    {
                      id: 'edit',
                      label: t('calendar.calendars.edit'),
                      onSelect: () => props.onEdit(calendar),
                      ...(props.disabled ? { disabled: true } : {}),
                    },
                    ...(mayDelete(calendar)
                      ? [
                          {
                            id: 'delete',
                            label: t('calendar.calendars.delete'),
                            destructive: true,
                            onSelect: () => props.onDelete(calendar),
                            ...(props.disabled ? { disabled: true } : {}),
                          },
                        ]
                      : []),
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {props.heading === false && props.canCreate && (
        <Button
          variant="ghost"
          className={styles.calendarAddRow}
          disabled={props.disabled}
          onClick={props.onCreate}
        >
          <CalendarPlus aria-hidden="true" />
          {t('calendar.calendars.create')}
        </Button>
      )}
    </div>
  )
}
