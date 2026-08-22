/**
 * The week and day views (M5.13, FR-CAL-01).
 *
 * A time axis with one column per day, events positioned by minute. All the geometry — including
 * overlap resolution — comes from `week-grid.ts`, which is tested without rendering; this file is
 * only the markup that puts the numbers on screen.
 *
 * The hours are a background grid rather than 24 rows of cells: a cell per hour per day is 168
 * elements that exist purely to draw lines, and none of them means anything to a screen reader.
 * The events themselves are buttons with full labels, which is what a reader actually needs.
 *
 * **Whole-day events get their own band**, above the axis and outside it. They have no time of day,
 * so there is no honest place for them on a scale of hours — and the previous answer, dropping them
 * from this view entirely, meant a three-day trip was invisible in the week it spanned (T4).
 * Every calendar people know puts them in a strip under the day names; this is that strip.
 *
 * **Somebody else's availability is a background layer** (S-6): {@link WeekViewProps.busy} draws a
 * hatched band behind the grid wherever the chosen person is busy. It is behind everything, it is a
 * PATTERN rather than a tint (a wash of colour would either hide the reader's own events or be
 * indistinguishable from a calendar's own hue — and colour alone may not carry meaning at all, WCAG
 * 1.4.1), and it takes no clicks: `pointer-events: none`, so the column underneath still creates
 * events where it did. Apple draws free/busy exactly this way and for the same reason — the answer
 * to "when can we meet" is only useful next to the reader's OWN commitments, never instead of them.
 */

import { useTranslation } from 'react-i18next'
import { formatDate } from '../i18n/formatters'
import { VisuallyHidden } from '../ui'
import { type BusyPeriod, busyBandsForDay } from './availability'
import styles from './calendar.module.css'
import type { PlacedEvent } from './calendar-client'
import { isSameDay } from './month-grid'
import { layoutDay, overlapsDay } from './week-grid'

/** Height of one hour, in CSS pixels. Also the unit every position below is expressed in. */
const HOUR_PX = 48
const MINUTES_PER_DAY = 1440

/** 0…23. Iterated as VALUES rather than indices: the hour is the identity of its row. */
const HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => hour)

/**
 * The instant `minute` minutes after local midnight on `day`, for formatting a band's edges.
 *
 * Built from the local date parts rather than by adding milliseconds to midnight: across a DST
 * boundary the arithmetic answer is an hour out, and this string is the only form of the band a
 * screen-reader user gets.
 */
function minuteInstant(day: Date, minute: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minute)
}

export interface WeekViewProps {
  readonly days: readonly Date[]
  readonly events: readonly PlacedEvent[]
  readonly today: Date
  /** The selected day, drawn as selected — same rule as the month grid. */
  readonly focus: Date
  onOpen: (placed: PlacedEvent, day: Date) => void
  /** A day header was activated — select that day. */
  onPick: (day: Date) => void
  /**
   * Somebody else's busy periods, merged and sorted (S-6). Empty or absent draws nothing.
   *
   * Absent means "nobody chosen" and empty means "chosen, and free all week" — the two look the
   * same on screen and must not: `busyName` is what tells a reader which one they are looking at.
   */
  readonly busy?: readonly BusyPeriod[] | undefined
  /** Whose periods {@link WeekViewProps.busy} are. Required for the layer to be announced at all. */
  readonly busyName?: string | undefined
}

export function WeekView({
  days,
  events,
  today,
  focus,
  onOpen,
  onPick,
  busy,
  busyName,
}: WeekViewProps) {
  const { t } = useTranslation()
  // The layer is drawn only when there is somebody to attribute it to. A hatch with no name beside
  // it is a pattern the reader has to guess at, and guessing wrong ("is that MY calendar?") is
  // worse than not drawing it.
  const showBusy = busy !== undefined && busyName !== undefined && busyName !== ''
  const positioned = events
    .filter((placed) => placed.startsAt !== null && !placed.allDay)
    .map((placed) => ({
      item: placed,
      startsAt: placed.startsAt as number,
      endsAt: placed.endsAt ?? (placed.startsAt as number),
    }))

  const allDay = events.filter((placed) => placed.allDay && placed.startsAt !== null)
  // The band costs a row of vertical space in a view that is already tall; it appears only when it
  // has something to hold.
  const hasAllDay = allDay.some((placed) =>
    days.some((day) => overlapsDay(placed.startsAt as number, placed.endsAt ?? 0, day)),
  )

  return (
    <div className={styles.week}>
      <div className={styles.weekHead}>
        {/* Spacer above the hour gutter, so the day headers line up with their columns. */}
        <span className={styles.hourGutter} aria-hidden="true" />
        {days.map((day) => (
          <button
            key={day.toISOString()}
            type="button"
            className={[
              styles.weekDayHead,
              isSameDay(day, today) ? styles.today : '',
              !isSameDay(day, today) && isSameDay(day, focus) ? styles.picked : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label={formatDate(day, { dateStyle: 'full' })}
            {...(isSameDay(day, today) ? { 'aria-current': 'date' as const } : {})}
            onClick={() => onPick(day)}
          >
            <span className={styles.weekDayName} aria-hidden="true">
              {formatDate(day, { weekday: 'short' })}
            </span>
            <span className={styles.weekDayNumber} aria-hidden="true">
              {day.getDate()}
            </span>
          </button>
        ))}
      </div>

      {hasAllDay && (
        <div className={styles.weekAllDay}>
          <span className={styles.weekAllDayLabel}>{t('calendar.allDay')}</span>
          {days.map((day) => (
            <div key={day.toISOString()} className={styles.weekAllDayCell}>
              {allDay
                .filter((placed) => overlapsDay(placed.startsAt as number, placed.endsAt ?? 0, day))
                .map((placed) => (
                  <button
                    key={`${placed.event.id}-${placed.startsAt}`}
                    type="button"
                    className={styles.chip}
                    onClick={() => onOpen(placed, day)}
                  >
                    {placed.event.title || t('calendar.untitled')}
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}

      <div
        className={styles.weekBody}
        style={{ blockSize: `${(MINUTES_PER_DAY / 60) * HOUR_PX}px` }}
      >
        <div className={styles.hourGutter} aria-hidden="true">
          {HOURS.map((hour) => (
            <span
              key={hour}
              className={styles.hourLabel}
              style={{ insetBlockStart: `${hour * HOUR_PX}px` }}
            >
              {/* An hour on its own, formatted by the locale — 09:00 or 9 AM. */}
              {formatDate(new Date(2026, 0, 1, hour), { hour: 'numeric' })}
            </span>
          ))}
        </div>

        {days.map((day) => {
          const slots = layoutDay(positioned, day)
          const bands = showBusy ? busyBandsForDay(busy, day) : []
          return (
            <div key={day.toISOString()} className={styles.weekColumn}>
              {/* The hour lines. Decorative: the events carry the meaning. */}
              {HOURS.map((hour) => (
                <span
                  key={hour}
                  className={styles.hourLine}
                  style={{ insetBlockStart: `${hour * HOUR_PX}px` }}
                  aria-hidden="true"
                />
              ))}

              {/*
                The availability layer. BEFORE the events in the DOM, which is the whole of the
                stacking rule: both are absolutely positioned with no `z-index`, so the later
                siblings — the events — paint on top. A band may never hide a real appointment.
              */}
              {bands.map((band) => (
                <span
                  key={`busy-${band.startMinute}-${band.endMinute}`}
                  className={styles.busyBand}
                  style={{
                    insetBlockStart: `${(band.startMinute / 60) * HOUR_PX}px`,
                    blockSize: `${((band.endMinute - band.startMinute) / 60) * HOUR_PX}px`,
                  }}
                  aria-hidden="true"
                />
              ))}
              {/* The bands are decoration; this is the same fact in words, which is the only form
                  of it a screen reader can reach. One sentence per band, per day, and nothing at
                  all on a day the person is free. */}
              {bands.map((band) => (
                <VisuallyHidden key={`busy-label-${band.startMinute}-${band.endMinute}`}>
                  {t('calendar.availability.period', {
                    name: busyName,
                    day: formatDate(day, { dateStyle: 'full' }),
                    from: formatDate(minuteInstant(day, band.startMinute), { timeStyle: 'short' }),
                    to: formatDate(minuteInstant(day, band.endMinute), { timeStyle: 'short' }),
                  })}
                </VisuallyHidden>
              ))}

              {slots.map((slot) => (
                <button
                  key={`${slot.item.event.id}-${slot.item.startsAt}`}
                  type="button"
                  className={styles.weekEvent}
                  style={{
                    insetBlockStart: `${(slot.startMinute / 60) * HOUR_PX}px`,
                    blockSize: `${((slot.endMinute - slot.startMinute) / 60) * HOUR_PX}px`,
                    // Overlapping events share the column's width; `week-grid.ts` decides how many.
                    insetInlineStart: `${(slot.column / slot.columns) * 100}%`,
                    inlineSize: `${(1 / slot.columns) * 100}%`,
                  }}
                  onClick={() => onOpen(slot.item, day)}
                >
                  <span className={styles.weekEventTime}>
                    {formatDate(new Date(slot.item.startsAt as number), { timeStyle: 'short' })}
                  </span>
                  <span className={styles.weekEventTitle}>
                    {slot.item.event.title || t('calendar.untitled')}
                  </span>
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
