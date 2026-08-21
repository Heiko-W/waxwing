/**
 * Creating and editing a single calendar event (M5.11, FR-CAL-01) — a lazy chunk.
 *
 * **Single occurrences only.** A recurring event never reaches this dialog: `refuseEdit` turns
 * back both the master and an expanded occurrence, and the caller shows a read-only view instead.
 * Editing a series needs a scope editor ("this one" / "this and following" / "all") plus iTIP for
 * the participants, and half of that loses other people's time.
 *
 * The date and time are a native `datetime-local`, which is LOCAL wall-clock with no offset — the
 * same thing JSCalendar's `start` is. That correspondence is why no conversion happens here: what
 * the user types is what gets stored, and the zone travels beside it.
 *
 * Where the event carries a location or attendees, they are SHOWN and not offered for editing —
 * see `EventFacts` for why that line is where it is, and for why saving cannot damage them.
 *
 * **Reminders (K-5) are editable, and they are the exception that proves that rule.** Two rows, each
 * a fixed list of offsets, because Apple's list is the one people expect and a free-text duration
 * field is a way of asking a reader to learn ISO 8601. The second row appears only once the first is
 * set. Anything the client does not model — an email alarm, an absolute one — is counted on a
 * read-only line and carried through the save untouched; see `event-alerts.ts`.
 *
 * The value list is a native `<select>` rather than a sub-page in a navigation stack. The stack is
 * the right shape once repetition and participants arrive beside it (they are three rows with three
 * sub-pages, and one dialog holding all of them is Apple's answer); for a single list of ten fixed
 * values it would mean a focus trap inside a focus trap to reproduce what the platform's own picker
 * already does — a full-height wheel on a phone, a popup on a desktop, keyboard and screen reader
 * included.
 */

import type { Calendar, CalendarEvent } from '@waxwing/jmap'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Select, TextInput } from '../ui'
import styles from './calendar.module.css'
import type { EventDraft } from './calendar-client'
import { EventFacts } from './EventFacts'
import {
  alertsFromEvent,
  type EventAlerts,
  formatOffset,
  MAX_OFFSETS,
  NO_ALERTS,
  offsetsFor,
} from './event-alerts'
import { durationToMs } from './jscalendar-time'

export interface EventDialogProps {
  /** The event being edited, or `null` to create one. */
  readonly event: CalendarEvent | null
  /** Pre-selected day for a new event (local). */
  readonly defaultDate: Date
  readonly calendars: readonly Calendar[]
  readonly busy: boolean
  onCancel: () => void
  onSubmit: (draft: EventDraft) => void
  /** Absent while creating. */
  onDestroy?: (() => void) | undefined
}

/**
 * The longest an event may be, in minutes: 365 days.
 *
 * Not a technical limit — JSCalendar would take `P9999Y` — but the point at which a number stops
 * being a length and starts being a typo. The field accepted 999 999 999 minutes, about nineteen
 * centuries, and drew the resulting block across every view (T14).
 */
const MAX_MINUTES = 365 * 24 * 60

/** `YYYY-MM-DDTHH:mm` in local time — the format `datetime-local` speaks. */
function toInputValue(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A JSCalendar local start (`2026-08-20T10:00:00`) is already almost this format. */
function startToInputValue(start: string): string {
  return start.slice(0, 16)
}

/**
 * The length in minutes, or `null` when the field does not hold one.
 *
 * Kept as TEXT in state and parsed here, rather than held as a number. `Number('')` is 0, so a
 * controlled numeric field snapped to `0` the instant the field was emptied — the value could not
 * be cleared and retyped, only overtyped (T14).
 */
export function parseDurationMinutes(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= 1 && value <= MAX_MINUTES ? value : null
}

export default function EventDialog(props: EventDialogProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const startId = useId()
  const durationId = useId()
  const calendarId = useId()

  const existing = props.event
  const [title, setTitle] = useState(existing?.title ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [allDay, setAllDay] = useState(existing?.showWithoutTime === true)
  const [start, setStart] = useState(() =>
    existing === null ? toInputValue(props.defaultDate) : startToInputValue(existing.start),
  )
  const [duration, setDuration] = useState(() => {
    const ms = durationToMs(existing?.duration)
    return String(ms > 0 ? Math.round(ms / 60_000) : 60)
  })
  /** Set when the reader pressed Save on a length the app will not send. */
  const [durationRejected, setDurationRejected] = useState(false)
  /**
   * The event's reminders, read from what the server actually sent.
   *
   * Seeded from the EVENT and not from an empty value even while creating: a new event has no
   * alerts, and `NO_ALERTS` says exactly that — an empty modelled list and nothing opaque, which
   * `alertsToPatch` turns into `alerts: null` rather than into "leave them alone". For a create
   * those are the same thing; for an update they are the difference between clearing the list and
   * never touching it, and the dialog is always in a position to say which.
   */
  const [alerts, setAlerts] = useState<EventAlerts>(() =>
    existing === null ? NO_ALERTS : alertsFromEvent(existing),
  )
  const [calendar, setCalendar] = useState(
    () =>
      Object.keys(existing?.calendarIds ?? {})[0] ??
      props.calendars.find((entry) => entry.isDefault)?.id ??
      props.calendars[0]?.id ??
      '',
  )

  const canSubmit = title.trim() !== '' && start !== '' && calendar !== ''

  return (
    <Dialog
      open
      onClose={props.onCancel}
      size="md"
      title={existing === null ? t('calendar.event.createTitle') : t('calendar.event.editTitle')}
    >
      <form
        className={styles.eventForm}
        /*
         * `noValidate`, so the app answers rather than the browser.
         *
         * With the constraint on the input, Chrome refused the submit and showed its own bubble —
         * in the BROWSER's language, not the page's, positioned by the browser, and gone on the
         * next keystroke. Nothing else on the screen moved, no request went out, and the dialog
         * looked inert (T14). The validation below says the same thing in the page's voice, and
         * stays until it is fixed.
         */
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSubmit) return
          const minutes = allDay ? 1 : parseDurationMinutes(duration)
          if (minutes === null) {
            setDurationRejected(true)
            return
          }
          setDurationRejected(false)
          props.onSubmit({
            calendarId: calendar,
            title: title.trim(),
            description,
            // `datetime-local` gives `YYYY-MM-DDTHH:mm`; JSCalendar wants seconds too.
            start: `${start}:00`,
            durationMinutes: minutes,
            allDay,
            // The reader's own zone for a timed event. A picker for other zones is a separate
            // feature; guessing one here would be worse than using the obvious answer.
            timeZone: allDay ? null : Intl.DateTimeFormat().resolvedOptions().timeZone,
            // Always stated, because this dialog always knows: it read the alerts on the way in and
            // has shown the reader every one it models. A caller that does NOT know leaves the
            // field off and the property stays out of the patch (see `EventDraft.alerts`).
            alerts,
          })
        }}
      >
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={titleId}>
            {t('calendar.event.title')}
          </label>
          <TextInput
            id={titleId}
            value={title}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={startId}>
            {allDay ? t('calendar.event.day') : t('calendar.event.start')}
          </label>
          <TextInput
            id={startId}
            type={allDay ? 'date' : 'datetime-local'}
            value={allDay ? start.slice(0, 10) : start}
            onChange={(event) =>
              // A date-only value still has to carry a time for JSCalendar; midnight is the one
              // a whole-day event means.
              setStart(allDay ? `${event.target.value}T00:00` : event.target.value)
            }
          />
        </div>

        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={allDay}
            onChange={(event) => setAllDay(event.target.checked)}
          />
          {t('calendar.event.allDay')}
        </label>

        {!allDay && (
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={durationId}>
              {t('calendar.event.duration')}
            </label>
            <TextInput
              id={durationId}
              type="number"
              inputMode="numeric"
              value={duration}
              aria-invalid={durationRejected}
              {...(durationRejected ? { 'aria-describedby': `${durationId}-error` } : {})}
              onChange={(event) => {
                setDuration(event.target.value)
                // The complaint goes as soon as the reader starts answering it; it comes back on
                // the next Save if the answer is still not a length.
                setDurationRejected(false)
              }}
            />
            {durationRejected && (
              <p className={styles.fieldError} id={`${durationId}-error`}>
                {t('calendar.event.durationInvalid', { max: MAX_MINUTES })}
              </p>
            )}
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={calendarId}>
            {t('calendar.event.calendar')}
          </label>
          <Select
            id={calendarId}
            value={calendar}
            onChange={(event) => setCalendar(event.target.value)}
          >
            {props.calendars.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </div>

        {/* Reminders sit above Notes, which is where Apple puts them and where the reader expects
            them: Notes is the field with no shape, and a field with no shape belongs last. */}
        <AlertRows allDay={allDay} alerts={alerts} onChange={setAlerts} />

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${titleId}-desc`}>
            {t('calendar.event.description')}
          </label>
          <textarea
            id={`${titleId}-desc`}
            className={styles.textarea}
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        {existing !== null && <EventFacts event={existing} />}

        <div className={styles.formActions}>
          {props.onDestroy !== undefined && (
            /* Delete sits at the far end of the row, away from Cancel and Save.
               It used to stand immediately beside Cancel — two adjacent buttons, one of which
               undoes the dialog and the other the event (T13). There is no confirmation: the
               deletion is undoable from the toast it raises, which is how mail triage answers the
               same question, and an Undo costs the careful reader nothing. */
            <Button
              type="button"
              variant="destructive"
              className={styles.deleteAction}
              onClick={props.onDestroy}
            >
              {t('calendar.event.delete')}
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={props.onCancel}>
            {t('calendar.event.cancel')}
          </Button>
          <Button type="submit" loading={props.busy} disabled={!canSubmit}>
            {t('calendar.event.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** The reminder rows, named so each keeps a stable identity across a change. */
const ALERT_ROWS = ['first', 'second'] as const

/**
 * The reminder rows (K-5).
 *
 * **The second row appears only once the first is set**, which is Apple's rule and the right one: a
 * calendar with two empty "Alert" rows tells every reader that two are expected. Clearing the first
 * while a second exists promotes the second rather than leaving a hole — the list is ordered, not
 * indexed, so "no first alert but a second one" is a state that cannot be expressed and should not
 * be shown.
 *
 * A stored offset the fixed list does not contain (another client's choice, or the same list for the
 * other kind of event after "All day" was ticked) is added to that row's options rather than being
 * dropped on selection. Same stance as the calendar colour picker: a value we did not offer is still
 * a value somebody chose.
 */
function AlertRows({
  allDay,
  alerts,
  onChange,
}: {
  readonly allDay: boolean
  readonly alerts: EventAlerts
  onChange: (next: EventAlerts) => void
}) {
  const { t } = useTranslation()
  const baseId = useId()
  const shown = alerts.offsets.slice(0, MAX_OFFSETS)
  const opaque = Object.keys(alerts.opaque).length
  // One row per set reminder, plus one empty row to set the next — until both are used. Named
  // rather than counted, so each row keeps a stable React key: keyed by index, clearing the first
  // reminder would hand the second one's state to the first one's `<select>`.
  const rows = ALERT_ROWS.slice(0, Math.min(shown.length + 1, MAX_OFFSETS))

  const setRow = (index: number, value: string): void => {
    const next = [...shown]
    if (value === '') next.splice(index, 1)
    else next[index] = value
    // De-duplicated here as well as on the way in: choosing the value the other row already holds
    // would otherwise leave two rows claiming one alarm, and the server stores one.
    onChange({ ...alerts, offsets: next.filter((entry, at) => next.indexOf(entry) === at) })
  }

  return (
    <>
      {rows.map((row, index) => {
        const value = shown[index] ?? ''
        const options = offsetsFor(allDay)
        return (
          <div className={styles.field} key={row}>
            <label className={styles.fieldLabel} htmlFor={`${baseId}-${row}`}>
              {index === 0 ? t('calendar.event.alert.label') : t('calendar.event.alert.second')}
            </label>
            <Select
              id={`${baseId}-${row}`}
              value={value}
              onChange={(event) => setRow(index, event.target.value)}
            >
              <option value="">{t('calendar.event.alert.none')}</option>
              {(value !== '' && !options.includes(value) ? [value, ...options] : options).map(
                (offset) => (
                  <option key={offset} value={offset}>
                    {formatOffset(offset, allDay, t)}
                  </option>
                ),
              )}
            </Select>
          </div>
        )
      })}
      {opaque > 0 && (
        /* Counted, not listed, and above all not editable. An email alarm or an absolute one is
           carried through the save byte for byte (see `event-alerts.ts`); saying how many there are
           is the difference between "this app keeps them" and a reader concluding they are gone. */
        <p className={styles.alertCarried}>
          {t('calendar.event.alert.carried', { count: opaque })}
        </p>
      )}
    </>
  )
}
