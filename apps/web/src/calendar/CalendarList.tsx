/**
 * The calendars themselves (K-1, FR-CAL-01): make one, rename it, colour it, hide it, delete it.
 *
 * `Calendar/set` had been typed since M5.6 and had **no caller at all**, so a reader could see
 * their calendars and do nothing whatever with them. The consequence that justifies the work is not
 * the create button, though — it is the tick:
 *
 * **Hiding WAS server state, and since #79 it is not.** `isVisible` is a property of the calendar
 * object, so a tick used to be a `Calendar/set` — which is fine for a calendar the reader owns and
 * flatly impossible for one somebody shared read-only. The merged view (#79) puts exactly that kind
 * of calendar on the screen, so the decision moved into the replica's local prefs
 * (`repo.ts`, `CALENDAR_SHOWN_KEY`) and the server's `isVisible` became the STARTING value. The
 * range query still stops asking for a calendar that is off — the filter is built from the same
 * answer — so it is still not a drawing trick; it is simply this device's decision rather than the
 * account's.
 *
 * **Shape, and why it is Apple's.** One row is a checkbox tinted with the calendar's colour and the
 * calendar's name — no per-row toolbar, no gear, nothing else competing for the row. That is the
 * iOS calendar list and the macOS sidebar both. Editing hides behind a `⋯` at the end of the row,
 * which is the one place this departs from "a dot, a tick and a name": iOS puts an ⓘ there for
 * exactly this purpose, and a list whose only route to renaming is a long-press is a list where
 * renaming does not exist for a keyboard.
 *
 * **Rights decide what is on the row, not whether it is refused afterwards.** A calendar the reader
 * cannot write to has no `⋯` at all; one whose `myRights.mayShare` is false has no share icon; a calendar that is the account default, or that
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

import type { Calendar, Id } from '@waxwing/jmap'
import { CalendarPlus, MoreHorizontal, UserPlus, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { mayShareCalendar } from '../sharing/calendar-roles'
import { Button, Checkbox, IconButton, Menu, VisuallyHidden } from '../ui'
import styles from './calendar.module.css'
import { calendarColor } from './calendar-colour'

/**
 * The reader's own show/hide decisions for ONE account's calendars (#79) — `{ [calendarId]: bool }`.
 *
 * Only calendars the reader actually ticked appear in it; everything else falls back to the
 * server's `isVisible`. Stored per account (`repo.ts`, `CALENDAR_SHOWN_KEY`), which is what makes
 * two accounts that both call a calendar `c1` two different decisions (ADR-018).
 */
export type ShownOverrides = Readonly<Record<Id, boolean>>

/** No decisions taken yet — a shared constant so callers do not allocate one per render. */
export const NO_OVERRIDES: ShownOverrides = {}

/**
 * Is this calendar drawn?
 *
 * **Only `false` hides it.** `undefined` means the property was not asked for, or the server does
 * not send it — and reading that as "hidden" empties the whole screen on any server that does not
 * implement `isVisible`. The rule is one-sided on purpose (see `Calendar.isVisible`).
 *
 * The SERVER's answer only, and since #79 that makes it the STARTING value rather than the whole
 * answer — see {@link isCalendarShown}.
 */
export function isCalendarVisible(calendar: Calendar): boolean {
  return calendar.isVisible !== false
}

/**
 * Is this calendar drawn, once the reader's own decision is taken into account (#79)?
 *
 * The local decision wins where there is one, and the server's `isVisible` is the value it starts
 * from. Ticking used to WRITE `isVisible`, which is impossible on a calendar somebody shared
 * read-only — precisely the kind the merged view puts on screen — so half the rows had a tick box
 * that could not be ticked.
 */
export function isCalendarShown(
  calendar: Calendar,
  overrides: ShownOverrides = NO_OVERRIDES,
): boolean {
  return overrides[calendar.id] ?? isCalendarVisible(calendar)
}

/** The ids whose events the range query should ask for, for ONE account. */
export function visibleCalendarIds(
  calendars: readonly Calendar[],
  overrides: ShownOverrides = NO_OVERRIDES,
): string[] {
  return calendars
    .filter((calendar) => isCalendarShown(calendar, overrides))
    .map((calendar) => calendar.id)
}

/**
 * May the reader put an event INTO this calendar?
 *
 * `mayWriteAll` or `mayWriteOwn` — the draft has no single `mayWrite`, and the two are the same
 * answer to "can I create something here": all events, or the ones I organise. A calendar granting
 * neither is offered in the editor's picker but not selectable, so the reader can see it exists and
 * cannot aim a save at a server that will refuse it.
 */
export function mayWriteEvents(calendar: Calendar): boolean {
  return calendar.myRights?.mayWriteAll === true || calendar.myRights?.mayWriteOwn === true
}

/** May the reader change this calendar's name and colour? */
export function mayEdit(calendar: Calendar): boolean {
  return calendar.myRights?.mayWriteAll === true
}

/**
 * Is this calendar shared with anybody (S-2)?
 *
 * Reliable here in a way the address book's equivalent is not: `CALENDAR_PROPERTIES` names
 * `shareWith` on every `Calendar/get`, so an empty map means empty rather than "not asked for".
 * `null` is the server's own word for "nobody" and reads the same way.
 */
export function isCalendarShared(calendar: Calendar): boolean {
  const shareWith = calendar.shareWith
  return shareWith != null && Object.keys(shareWith).length > 0
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
   * The account these calendars belong to (#79).
   *
   * Needed for the COLOUR, not for identity: a calendar the server left without one is drawn in a
   * derived colour (`calendar-colour.ts`), and the derivation is per account so two accounts that
   * both call a calendar `c1` do not land on the same hue. The tick box has to use the same
   * function the chips do — a chip coloured by a rule the tick box beside it does not follow is
   * worse than no colour at all, because the rail is where the reader learns which colour is whose.
   */
  readonly accountId: Id
  /**
   * The reader's own show/hide decisions for these calendars (#79). Absent = none taken, in which
   * case every tick reads the server's `isVisible` exactly as it did before.
   */
  readonly shown?: ShownOverrides
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
  /**
   * Open the share dialog for one calendar (S-2).
   *
   * Optional so a caller that cannot share — no session, offline — simply passes nothing and the
   * row loses the control rather than growing one that fails. The row ALSO checks
   * `myRights.mayShare`: a calendar shared WITH the reader comes back with that right `false` and
   * `shareWith: null`, so the affordance would open a dialog listing nobody over something they
   * cannot change.
   */
  onShare?: ((calendar: Calendar) => void) | undefined
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
                  checked={isCalendarShown(calendar, props.shown)}
                  disabled={props.disabled}
                  style={{ accentColor: calendarColor(props.accountId, calendar) }}
                  label={<span className={styles.calendarName}>{calendar.name}</span>}
                  onChange={(event) => props.onToggle(calendar, event.target.checked)}
                />
              </span>
              {/*
                The share affordance sits beside the NAME rather than inside the ⋯ — which is where
                iCloud puts it, and the reason is not fashion: sharing a calendar is a thing people
                come to this list to do, and a control that has to be found in a menu is a control
                most people never learn exists. It is an icon and not a word because the row is a
                rail 215px wide and the name may not be shortened for it.
              */}
              {isCalendarShared(calendar) && (
                // NOT colour, and not the icon alone (WCAG 1.4.1): the icon is decorative and the
                // word beside it is the marker, hidden from sight but not from a screen reader —
                // there is no room in this rail for a second badge, and no honest way to say
                // "shared" with a tint.
                <span className={styles.calendarShared} title={t('calendar.calendars.sharedTitle')}>
                  <UsersRound aria-hidden="true" className={styles.calendarSharedIcon} />
                  <VisuallyHidden>{t('calendar.calendars.sharedTitle')}</VisuallyHidden>
                </span>
              )}
              {props.onShare !== undefined && mayShareCalendar(calendar.myRights) && (
                <IconButton
                  label={t('calendar.calendars.share', { name: calendar.name })}
                  variant="ghost"
                  size="sm"
                  disabled={props.disabled}
                  onClick={() => props.onShare?.(calendar)}
                >
                  <UserPlus />
                </IconButton>
              )}
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
