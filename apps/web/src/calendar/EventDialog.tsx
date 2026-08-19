/**
 * Creating and editing a single calendar event (M5.11, FR-CAL-01) — a lazy chunk.
 *
 * **Single occurrences only.** A recurring event never reaches this dialog: `isEditable` refuses
 * both the master and an expanded occurrence, and the caller shows a read-only view instead.
 * Editing a series needs a scope editor ("this one" / "this and following" / "all") plus iTIP for
 * the participants, and half of that loses other people's time.
 *
 * The date and time are a native `datetime-local`, which is LOCAL wall-clock with no offset — the
 * same thing JSCalendar's `start` is. That correspondence is why no conversion happens here: what
 * the user types is what gets stored, and the zone travels beside it.
 */

import type { Calendar, CalendarEvent } from '@waxwing/jmap'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Select, TextInput } from '../ui'
import styles from './calendar.module.css'
import type { EventDraft } from './calendar-client'
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

/** `YYYY-MM-DDTHH:mm` in local time — the format `datetime-local` speaks. */
function toInputValue(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A JSCalendar local start (`2026-08-20T10:00:00`) is already almost this format. */
function startToInputValue(start: string): string {
  return start.slice(0, 16)
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
  const [minutes, setMinutes] = useState(() => {
    const ms = durationToMs(existing?.duration)
    return ms > 0 ? Math.round(ms / 60_000) : 60
  })
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
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSubmit) return
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
              min={1}
              value={String(minutes)}
              onChange={(event) => setMinutes(Number(event.target.value))}
            />
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

        <div className={styles.formActions}>
          {props.onDestroy !== undefined && (
            <Button type="button" variant="destructive" onClick={props.onDestroy}>
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
