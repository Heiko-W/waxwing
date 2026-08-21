/**
 * Creating and editing a calendar event (M5.11, FR-CAL-01) — a lazy chunk.
 *
 * **A navigation stack inside ONE dialog, not a dialog inside a dialog.** Repetition (K-2) and
 * participants (K-3) are each a row here and a page behind it, exactly as Apple's event editor puts
 * them. The alternative — a modal opened from a modal — is a focus trap inside a focus trap, which
 * is a bug with an announcement. `page` says which surface is showing; the title changes with it,
 * the leading control becomes a back arrow, and Escape goes one level up rather than throwing the
 * draft away.
 *
 * **The scope question comes AFTER Save, not before.** A repeating event does not ask "what are you
 * about to change" while the reader is still typing — it saves, and then asks "this event, or all
 * of them", which is the moment the question is actually answerable. Two answers and a Cancel; no
 * third button, because on the first occurrence "all future" and "all" are the same thing and a
 * button whose difference has to be explained is a button that should not exist. The same sheet
 * handles Delete, with both answers destructive.
 *
 * **"All future events" is deliberately NOT offered.** JSCalendar has no "split a series": it is
 * truncate-the-old plus create-a-new, two operations that cannot be made one, so a connection lost
 * between them leaves two series where there was one. It is buildable and it is measured working
 * (`create` + `recurrenceRule/until` in one `/set` — probed on v0.16.18) — it is left out of this
 * package rather than shipped without the recovery path it needs.
 *
 * The date and time are a native `datetime-local`, which is LOCAL wall-clock with no offset — the
 * same thing JSCalendar's `start` is. That correspondence is why no conversion happens here.
 *
 * Reminders (K-5), repetition (K-2) and participants (K-3) are editable; a location is still shown
 * and not offered for editing (see `EventFacts`). Anything the client does not model — an email
 * alarm, a `byDay` rule, a participant's delegate — is carried through the save untouched.
 */

import type { Calendar, CalendarEvent, ParticipationStatus } from '@waxwing/jmap'
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, IconButton, Select, TextInput } from '../ui'
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
import {
  DEFAULT_MAX_PARTICIPANTS,
  findSelf,
  newParticipantRow,
  normaliseAddress,
  type ParticipantRow,
  participantsFromEvent,
  RSVP_STATUSES,
} from './event-participants'
import {
  type EditScope,
  endFromRule,
  presetFromRule,
  REPEAT_PRESETS,
  type RepeatEnd,
  type RepeatPreset,
} from './event-recurrence'
import { durationToMs } from './jscalendar-time'

export interface EventDialogProps {
  /** The event being edited, or `null` to create one. */
  readonly event: CalendarEvent | null
  /** Pre-selected day for a new event (local). */
  readonly defaultDate: Date
  readonly calendars: readonly Calendar[]
  readonly busy: boolean
  /**
   * Does saving this event have to ask "this one or all of them"?
   *
   * Passed in rather than derived from `event`, because the answer lives on the PLACED occurrence:
   * an instance whose master is outside the fetched window carries a `recurrenceId` and no rule, and
   * only the caller has both halves. See `needsScope` in `calendar-client.ts`.
   */
  readonly isSeries?: boolean
  /** This account's own calendar addresses (K-10) — what makes one participant "me". */
  readonly ownAddresses?: readonly string[]
  /** `myRights.mayRSVP` on the event's calendar. Without it the answer bar is not shown. */
  readonly mayRsvp?: boolean
  /** `maxParticipantsPerEvent` from the account capability. */
  readonly maxParticipants?: number
  onCancel: () => void
  onSubmit: (draft: EventDraft, scope: EditScope, invite: boolean) => void
  /** Absent while creating. */
  onDestroy?: ((scope: EditScope) => void) | undefined
  /** Answering an invitation — one pointer patch, not a save. Absent when it does not apply. */
  onRsvp?: ((participantKey: string, status: ParticipationStatus) => void) | undefined
}

/** The surfaces this dialog navigates between. `scope-*` are the two answers after an action. */
type Page = 'main' | 'repeat' | 'participants' | 'scope-save' | 'scope-delete'

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
  const [page, setPage] = useState<Page>('main')
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
   * `alertsToPatch` turns into `alerts: null` rather than into "leave them alone".
   */
  const [alerts, setAlerts] = useState<EventAlerts>(() =>
    existing === null ? NO_ALERTS : alertsFromEvent(existing),
  )
  /** Repetition (K-2). `custom` means the stored rule has no name here and is carried unchanged. */
  const [preset, setPreset] = useState<RepeatPreset>(() => presetFromRule(existing?.recurrenceRule))
  const [repeatEnd, setRepeatEnd] = useState<RepeatEnd>(() => endFromRule(existing?.recurrenceRule))
  /** Participants (K-3), already de-duplicated against the entry the server adds for the organiser. */
  const [participants, setParticipants] = useState<readonly ParticipantRow[]>(() =>
    existing === null ? [] : participantsFromEvent(existing),
  )
  /** Did the reader touch the participant list? Only then is `participants` in the patch at all. */
  const [participantsTouched, setParticipantsTouched] = useState(false)
  const [calendar, setCalendar] = useState(
    () =>
      Object.keys(existing?.calendarIds ?? {})[0] ??
      props.calendars.find((entry) => entry.isDefault)?.id ??
      props.calendars[0]?.id ??
      '',
  )

  const canSubmit = title.trim() !== '' && start !== '' && calendar !== ''
  const self = findSelf(participants, props.ownAddresses ?? [])
  const showRsvp = self !== null && props.mayRsvp === true && props.onRsvp !== undefined

  /** Everything the save needs, or `null` when the form is not sendable yet. */
  function buildDraft(): EventDraft | null {
    if (!canSubmit) return null
    const minutes = allDay ? 1 : parseDurationMinutes(duration)
    if (minutes === null) {
      setDurationRejected(true)
      return null
    }
    setDurationRejected(false)
    const organizer = participants.find((row) => row.isOrganizer)
    return {
      calendarId: calendar,
      title: title.trim(),
      description,
      // `datetime-local` gives `YYYY-MM-DDTHH:mm`; JSCalendar wants seconds too.
      start: `${start}:00`,
      durationMinutes: minutes,
      allDay,
      // The reader's own zone for a timed event. A picker for other zones is a separate feature;
      // guessing one here would be worse than using the obvious answer.
      timeZone: allDay ? null : Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Always stated, because this dialog always knows: it read the alerts on the way in and has
      // shown the reader every one it models.
      alerts,
      repeat: { preset, end: repeatEnd },
      /*
       * `participants` only once the reader has touched the list, and that condition is doing real
       * work rather than saving bytes. Reading a participant map and writing it straight back
       * normalises it through this client's model — every member it does not know would be dropped
       * on a save that was only ever meant to fix a typo in the title. Untouched means unsent means
       * untouched on the server (RFC 8620 §5.3).
       */
      ...(participantsTouched
        ? {
            participants,
            ...(organizer === undefined ? {} : { organizerCalendarAddress: organizer.calendarAddress }),
          }
        : {}),
    }
  }

  /** Save pressed: a series asks first, everything else goes straight out. */
  function save(): void {
    const draft = buildDraft()
    if (draft === null) return
    if (props.isSeries === true) {
      setPage('scope-save')
      return
    }
    props.onSubmit(draft, 'all', invitesGoOut())
  }

  /**
   * Should this save send iMIP invitations?
   *
   * Only when the reader added somebody. Measured: `sendSchedulingMessages: true` is the trigger and
   * the ONLY trigger — so leaving it on for every save would re-invite the whole room because
   * somebody corrected a spelling, and leaving it off entirely means the invitation never goes.
   */
  function invitesGoOut(): boolean {
    return participantsTouched && participants.some((row) => !row.isOrganizer)
  }

  const backTo = (target: Page) => () => setPage(target)
  const pageTitle =
    page === 'repeat'
      ? t('calendar.event.repeat.label')
      : page === 'participants'
        ? t('calendar.event.participants')
        : page === 'scope-save'
          ? t('calendar.event.scope.saveTitle')
          : page === 'scope-delete'
            ? t('calendar.event.scope.deleteTitle')
            : existing === null
              ? t('calendar.event.createTitle')
              : t('calendar.event.editTitle')

  return (
    <Dialog
      open
      // Escape goes ONE level up, and only closes from `main`. A reader who stepped into "Repeat"
      // and pressed Escape meant "not that page", not "throw the whole event away".
      onClose={page === 'main' ? props.onCancel : backTo('main')}
      size="md"
      title={
        page === 'main' ? (
          pageTitle
        ) : (
          <span className={styles.pageTitle}>
            <IconButton
              label={t('calendar.event.back')}
              size="sm"
              variant="ghost"
              onClick={backTo('main')}
            >
              <ChevronLeft aria-hidden />
            </IconButton>
            {pageTitle}
          </span>
        )
      }
    >
      {page === 'repeat' && (
        <RepeatPage
          preset={preset}
          end={repeatEnd}
          onPreset={setPreset}
          onEnd={setRepeatEnd}
        />
      )}

      {page === 'participants' && (
        <ParticipantsPage
          rows={participants}
          max={props.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS}
          onChange={(next) => {
            setParticipants(next)
            setParticipantsTouched(true)
          }}
        />
      )}

      {(page === 'scope-save' || page === 'scope-delete') && (
        <ScopeSheet
          destructive={page === 'scope-delete'}
          busy={props.busy}
          onCancel={backTo('main')}
          onChoose={(scope) => {
            if (page === 'scope-delete') {
              props.onDestroy?.(scope)
              return
            }
            const draft = buildDraft()
            if (draft !== null) props.onSubmit(draft, scope, invitesGoOut())
          }}
        />
      )}

      {page === 'main' && (
        <form
          className={styles.eventForm}
          /*
           * `noValidate`, so the app answers rather than the browser. With the constraint on the
           * input, Chrome refused the submit and showed its own bubble — in the BROWSER's language,
           * positioned by the browser, and gone on the next keystroke (T14).
           */
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          {showRsvp && self !== null && (
            <RsvpBar
              status={self.participationStatus}
              busy={props.busy}
              onAnswer={(status) => props.onRsvp?.(self.key, status)}
            />
          )}

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

          {/* Repeat sits under the times, where the thing it modifies is. Apple's order, and the
              reason it is a row and not a `<select>`: the value has an ending behind it, and a
              second control that appears out of a dropdown is a control nobody finds. */}
          <NavRow
            label={t('calendar.event.repeat.label')}
            value={t(`calendar.event.repeat.${preset}`)}
            onClick={backTo('repeat')}
          />

          {/* Reminders sit above Notes, which is where Apple puts them and where the reader expects
              them: Notes is the field with no shape, and a field with no shape belongs last. */}
          <AlertRows allDay={allDay} alerts={alerts} onChange={setAlerts} />

          <NavRow
            label={t('calendar.event.participants')}
            value={
              participants.length === 0
                ? t('calendar.event.participant.none')
                : t('calendar.event.participant.count', { count: participants.length })
            }
            onClick={backTo('participants')}
          />

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
              /* Delete sits at the far end of the row, away from Cancel and Save. It used to stand
                 immediately beside Cancel — two adjacent buttons, one of which undoes the dialog and
                 the other the event (T13). A single event has no confirmation: it is undoable from
                 the toast it raises. A SERIES gets the scope sheet instead, because "which of them"
                 has no undo-shaped answer. */
              <Button
                type="button"
                variant="destructive"
                className={styles.deleteAction}
                onClick={() =>
                  props.isSeries === true ? setPage('scope-delete') : props.onDestroy?.('all')
                }
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
      )}
    </Dialog>
  )
}

/** A row that leads to a sub-page: label left, current value right, chevron after it. */
function NavRow({
  label,
  value,
  onClick,
}: {
  readonly label: string
  readonly value: ReactNode
  onClick: () => void
}) {
  return (
    <button type="button" className={styles.navRow} onClick={onClick}>
      <span className={styles.navRowLabel}>{label}</span>
      <span className={styles.navRowValue}>{value}</span>
      <ChevronRight aria-hidden className={styles.navRowChevron} />
    </button>
  )
}

/**
 * The repetition page (K-2).
 *
 * The presets, then the ending — and the ending appears only once something repeats, which is
 * Apple's order and the right one: most readers pick one of five and never see a second control.
 * A stored rule this client cannot name shows as its own selected row ("Custom") that cannot be
 * chosen, rather than being silently reshaped into the nearest offer.
 */
function RepeatPage({
  preset,
  end,
  onPreset,
  onEnd,
}: {
  readonly preset: RepeatPreset
  readonly end: RepeatEnd
  onPreset: (next: RepeatPreset) => void
  onEnd: (next: RepeatEnd) => void
}) {
  const { t } = useTranslation()
  const untilId = useId()
  const countId = useId()
  const offered: readonly RepeatPreset[] = preset === 'custom' ? [...REPEAT_PRESETS, 'custom'] : REPEAT_PRESETS

  return (
    <div className={styles.eventForm}>
      <ul className={styles.choiceList}>
        {offered.map((entry) => (
          <li key={entry}>
            <button
              type="button"
              className={styles.choiceRow}
              aria-pressed={entry === preset}
              // A rule with a `byDay` this editor has no control for stays exactly as it is; the
              // row is shown so the reader knows what the event does, not so it can be re-chosen.
              disabled={entry === 'custom'}
              onClick={() => onPreset(entry)}
            >
              <span>{t(`calendar.event.repeat.${entry}`)}</span>
              {entry === preset && <Check aria-hidden className={styles.choiceCheck} />}
            </button>
          </li>
        ))}
      </ul>

      {preset !== 'none' && (
        <fieldset className={styles.field}>
          <legend className={styles.fieldLabel}>{t('calendar.event.repeat.endLabel')}</legend>
          <ul className={styles.choiceList}>
            {(['never', 'until', 'count'] as const).map((kind) => (
              <li key={kind}>
                <button
                  type="button"
                  className={styles.choiceRow}
                  aria-pressed={end.kind === kind}
                  onClick={() =>
                    onEnd(
                      kind === 'never'
                        ? { kind: 'never' }
                        : kind === 'count'
                          ? { kind: 'count', count: end.kind === 'count' ? end.count : 10 }
                          : {
                              kind: 'until',
                              until: end.kind === 'until' ? end.until : defaultUntil(),
                            },
                    )
                  }
                >
                  <span>{t(`calendar.event.repeat.end.${kind}`)}</span>
                  {end.kind === kind && <Check aria-hidden className={styles.choiceCheck} />}
                </button>
              </li>
            ))}
          </ul>

          {end.kind === 'until' && (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={untilId}>
                {t('calendar.event.repeat.untilDate')}
              </label>
              <TextInput
                id={untilId}
                type="date"
                value={end.until.slice(0, 10)}
                // JSCalendar's `until` is a LOCAL date-time like every other timestamp in the
                // format; a date picker gives the day, and the last second of it is what "up to and
                // including this day" means.
                onChange={(event) => onEnd({ kind: 'until', until: `${event.target.value}T23:59:59` })}
              />
            </div>
          )}
          {end.kind === 'count' && (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={countId}>
                {t('calendar.event.repeat.countLabel')}
              </label>
              <TextInput
                id={countId}
                type="number"
                inputMode="numeric"
                min={1}
                value={String(end.count)}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10)
                  onEnd({ kind: 'count', count: Number.isFinite(next) && next > 0 ? next : 1 })
                }}
              />
            </div>
          )}
        </fieldset>
      )}
    </div>
  )
}

/** A year out, as a local date-time — the value "ends on a date" starts from. */
function defaultUntil(): string {
  const date = new Date()
  date.setFullYear(date.getFullYear() + 1)
  return `${date.toISOString().slice(0, 10)}T23:59:59`
}

/**
 * The participants page (K-3).
 *
 * An address field and a list. The organiser carries a note beside the name and cannot be removed —
 * removing the organiser from their own meeting is not a thing this editor should make easy, and on
 * the wire the server puts them straight back.
 *
 * Status is a WORD, never a colour alone (WCAG 1.4.1): the reader who cannot tell green from amber
 * still has to be able to see who has answered.
 */
function ParticipantsPage({
  rows,
  max,
  onChange,
}: {
  readonly rows: readonly ParticipantRow[]
  readonly max: number
  onChange: (next: readonly ParticipantRow[]) => void
}) {
  const { t } = useTranslation()
  const inputId = useId()
  const [entry, setEntry] = useState('')
  const [rejected, setRejected] = useState<'invalid' | 'duplicate' | 'full' | null>(null)

  function add(): void {
    const address = normaliseAddress(entry)
    // Deliberately minimal: something before an `@` and something after it, with no space. A real
    // address grammar in the client rejects addresses that work, which is the more expensive error.
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
      setRejected('invalid')
      return
    }
    if (rows.some((row) => row.address === address)) {
      setRejected('duplicate')
      return
    }
    if (rows.length >= max) {
      setRejected('full')
      return
    }
    setRejected(null)
    setEntry('')
    onChange([...rows, newParticipantRow(address)])
  }

  return (
    <div className={styles.eventForm}>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={inputId}>
          {t('calendar.event.participant.add')}
        </label>
        <div className={styles.participantAdd}>
          <TextInput
            id={inputId}
            type="email"
            inputMode="email"
            value={entry}
            aria-invalid={rejected !== null}
            {...(rejected === null ? {} : { 'aria-describedby': `${inputId}-error` })}
            onChange={(event) => {
              setEntry(event.target.value)
              setRejected(null)
            }}
            onKeyDown={(event) => {
              // Enter adds the address rather than submitting the form — which is on another page
              // and would save the event from underneath the reader.
              if (event.key === 'Enter') {
                event.preventDefault()
                add()
              }
            }}
          />
          <Button type="button" variant="secondary" onClick={add}>
            {t('calendar.event.participant.addAction')}
          </Button>
        </div>
        {rejected !== null && (
          <p className={styles.fieldError} id={`${inputId}-error`}>
            {t(`calendar.event.participant.${rejected}`, { max })}
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <p className={styles.alertCarried}>{t('calendar.event.participant.empty')}</p>
      ) : (
        <ul className={styles.participantList}>
          {rows.map((row) => (
            <li key={row.key} className={styles.participantRow}>
              <span className={styles.participantName}>
                {row.name || row.address}
                {row.isOrganizer && (
                  <span className={styles.participantNote}>
                    {t('calendar.event.participant.organizer')}
                  </span>
                )}
              </span>
              <span className={styles.participantStatus}>
                {t(`calendar.event.participant.status.${row.participationStatus ?? 'needs-action'}`)}
              </span>
              {!row.isOrganizer && (
                <IconButton
                  label={t('calendar.event.participant.remove', { name: row.name || row.address })}
                  size="sm"
                  variant="ghost"
                  onClick={() => onChange(rows.filter((other) => other.key !== row.key))}
                >
                  <X aria-hidden />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The three-way answer bar (K-3).
 *
 * Shown only when a participant carries one of this account's own calendar addresses (K-10) AND the
 * calendar grants `mayRSVP`. Both halves are needed: without the first the bar belongs to somebody
 * else, without the second pressing it produces a refusal the reader cannot act on.
 *
 * `aria-pressed` rather than a radio group, because these are three buttons that each perform an
 * action immediately — the answer goes to the server on the press, it is not part of Save.
 */
function RsvpBar({
  status,
  busy,
  onAnswer,
}: {
  readonly status: ParticipationStatus | null
  readonly busy: boolean
  onAnswer: (status: ParticipationStatus) => void
}) {
  const { t } = useTranslation()
  return (
    <div className={styles.rsvpBar} role="group" aria-label={t('calendar.event.rsvp.label')}>
      {RSVP_STATUSES.map((entry) => (
        <button
          key={entry}
          type="button"
          className={styles.rsvpButton}
          aria-pressed={status === entry}
          disabled={busy}
          onClick={() => onAnswer(entry)}
        >
          {t(`calendar.event.rsvp.${entry}`)}
        </button>
      ))}
    </div>
  )
}

/**
 * "This event" / "All events", asked after the action rather than before it.
 *
 * Two answers and a Cancel. There is no "all future events": see the file header — it is not one
 * operation on this wire format, and a half-finished split leaves two series where there was one.
 *
 * The note under the buttons is the one thing Apple does NOT say, and it is said here on purpose:
 * changing the whole series leaves individually-moved occurrences where they are (they carry a
 * `recurrenceOverrides` entry that wins over the master). Apple deletes those silently. Telling the
 * reader costs one line and saves the "why did that one not move" that follows otherwise.
 */
function ScopeSheet({
  destructive,
  busy,
  onCancel,
  onChoose,
}: {
  readonly destructive: boolean
  readonly busy: boolean
  onCancel: () => void
  onChoose: (scope: EditScope) => void
}) {
  const { t } = useTranslation()
  return (
    <div className={styles.scopeSheet}>
      <Button
        variant={destructive ? 'destructive' : 'primary'}
        loading={busy}
        onClick={() => onChoose('occurrence')}
      >
        {t('calendar.event.scope.occurrence')}
      </Button>
      <Button
        variant={destructive ? 'destructive' : 'primary'}
        loading={busy}
        onClick={() => onChoose('all')}
      >
        {t('calendar.event.scope.all')}
      </Button>
      <p className={styles.alertCarried}>{t('calendar.event.scope.note')}</p>
      <Button variant="secondary" onClick={onCancel}>
        {t('calendar.event.cancel')}
      </Button>
    </div>
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
  /** Reminders that are kept but not drawn: the ones we cannot model, plus any beyond the rows. */
  const kept = Object.keys(alerts.opaque).length + (alerts.offsets.length - shown.length)
  // One row per set reminder, plus one empty row to set the next — until both are used. Named
  // rather than counted, so each row keeps a stable React key: keyed by index, clearing the first
  // reminder would hand the second one's state to the first one's `<select>`.
  const rows = ALERT_ROWS.slice(0, Math.min(shown.length + 1, MAX_OFFSETS))

  const setRow = (index: number, value: string): void => {
    const next = [...shown]
    if (value === '') next.splice(index, 1)
    else next[index] = value
    // The tail is put back untouched: an event that came in with more reminders than there are
    // rows keeps them, exactly as an alarm this client cannot model does.
    const all = [...next, ...alerts.offsets.slice(MAX_OFFSETS)]
    // De-duplicated here as well as on the way in: choosing the value the other row already holds
    // would otherwise leave two rows claiming one alarm, and the server stores one.
    onChange({ ...alerts, offsets: all.filter((entry, at) => all.indexOf(entry) === at) })
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
      {kept > 0 && (
        /* Counted, not listed, and above all not editable. An email alarm, an absolute one, or a
           third reminder past the rows on offer is carried through the save byte for byte (see
           `event-alerts.ts`); saying how many there are is the difference between "this app keeps
           them" and a reader concluding they are gone. */
        <p className={styles.alertCarried}>{t('calendar.event.alert.carried', { count: kept })}</p>
      )}
    </>
  )
}
