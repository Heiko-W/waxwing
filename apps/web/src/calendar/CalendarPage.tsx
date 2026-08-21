/**
 * The calendar screen (M5.6, FR-CAL-01) — a lazy route chunk.
 *
 * Two views, and the choice of which two is the point: a **month** grid for orientation and an
 * **agenda** list for "what is next". Week and day grids are the two that need a time axis with
 * overlap resolution, and shipping them badly is worse than not shipping them — they are named as
 * open in the plan rather than approximated here.
 *
 * Single events can be created, edited and deleted (M5.11). A RECURRING one cannot: clicking it
 * opens a read-only note instead of the editor, because changing a series means choosing between
 * "this occurrence", "this and following" and "all", and a calendar that half-edits a repeating
 * meeting loses other people's time. `isEditable` is where that line is drawn.
 */

import type { Calendar, CalendarEvent } from '@waxwing/jmap'
import type { TFunction } from 'i18next'
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Plus,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { calendarPath, useNavigate, useRoute } from '../app/route'
import { useSessionOptional } from '../app/session/context'
import { useLayoutTier } from '../app/shell/layout'
import { ScreenBar } from '../app/shell/ScreenBar'
import shellStyles from '../app/shell/shell.module.css'
import { useOnline } from '../app/use-online'
import { formatDate } from '../i18n/formatters'
import { Button, Dialog, EmptyState, IconButton, Menu, Spinner, useToast } from '../ui'
import styles from './calendar.module.css'
import {
  type CalendarClient,
  isEditable,
  makeCalendarClient,
  type PlacedEvent,
} from './calendar-client'

const EventDialog = lazy(() => import('./EventDialog'))

import { zoneDiffersFromLocal } from './jscalendar-time'
import {
  addMonths,
  firstDayOfWeek,
  fromIsoDate,
  isSameDay,
  monthGrid,
  monthRange,
  startOfDay,
  toIsoDate,
} from './month-grid'
import { WeekView } from './WeekView'
import { weekDays } from './week-grid'

type View = 'month' | 'week' | 'agenda'

/** One source for both shapes of the view picker, so the segmented control and the menu cannot drift. */
const VIEWS = ['month', 'week', 'agenda'] as const satisfies readonly View[]

const VIEW_LABELS: Record<View, (t: TFunction) => string> = {
  month: (t) => t('calendar.view.month'),
  week: (t) => t('calendar.view.week'),
  agenda: (t) => t('calendar.view.agenda'),
}

export interface CalendarPageProps {
  /** Injected in tests; defaults to a client built from the live session. */
  readonly client?: CalendarClient
  /** Injected in tests so the grid is deterministic. */
  readonly today?: Date
}

export default function CalendarPage(props: CalendarPageProps) {
  const { t, i18n } = useTranslation()
  const route = useRoute()
  const navigate = useNavigate()
  const connected = useSessionOptional()
  const locale = i18n.resolvedLanguage ?? i18n.language
  /**
   * "Now", pinned for the lifetime of this mount.
   *
   * A bare `new Date()` in the render body is a different object every time, which makes every
   * memo and every effect keyed on it re-run for ever. Reading the clock once is also more honest:
   * the highlight on "today" should not move under the reader mid-session.
   */
  const todayMs = useMemo(() => (props.today ?? new Date()).getTime(), [props.today])
  const today = useMemo(() => new Date(todayMs), [todayMs])

  const [view, setView] = useState<View>('month')
  const tier = useLayoutTier()
  const { toast } = useToast()
  /*
   * This screen has no replica: every control on it is an online-only control. Without this check
   * the new-event button stayed enabled offline, the write failed, and the reader was told the
   * calendar could not be LOADED. Settings has gated its writes this way since M3.5; Calendar and
   * Files were the two screens that never did.
   */
  const online = useOnline()
  const [calendars, setCalendars] = useState<Calendar[]>([])
  /** `{ event }` edits, `{ event: null }` creates on `day`. */
  const [editing, setEditing] = useState<{ event: CalendarEvent | null; day: Date } | null>(null)
  const [saving, setSaving] = useState(false)
  const [events, setEvents] = useState<PlacedEvent[] | null>(null)
  const [failed, setFailed] = useState(false)

  /** The day the view is centred on: the route param, else today. */
  const focusDay = route.params.date
  const focus = useMemo(() => fromIsoDate(focusDay) ?? today, [focusDay, today])

  const injected = props.client
  const sessionClient = connected?.client ?? null
  const accountId = connected?.accountId ?? null
  const client = useMemo(
    () =>
      injected ??
      (sessionClient === null || accountId === null
        ? null
        : makeCalendarClient(sessionClient, accountId)),
    [injected, sessionClient, accountId],
  )

  /**
   * The window to fetch — the whole month grid, so the neighbouring days are not blank.
   *
   * Held as timestamps rather than `Date`s: a `Date` is a fresh object on every render, so an
   * effect keyed on one re-runs for ever. Numbers compare by value and the dependency list can be
   * honest about what it depends on.
   */
  const { fromMs, toMs } = useMemo(() => {
    const range = monthRange(focus, locale)
    return { fromMs: range.from.getTime(), toMs: range.to.getTime() }
  }, [focus, locale])

  const load = useCallback(async () => {
    if (client === null) return
    try {
      const [inRange, list] = await Promise.all([
        client.eventsInRange(new Date(fromMs), new Date(toMs)),
        client.listCalendars(),
      ])
      setEvents(inRange)
      setCalendars(list)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [client, fromMs, toMs])

  useEffect(() => {
    void load()
  }, [load])

  const goto = (date: Date): void => navigate(calendarPath(toIsoDate(date)))

  /**
   * Runs a write, then reloads. Closes the dialog only on success, so a refusal keeps the user's
   * input on screen to correct rather than discarding it.
   *
   * A failed write raises a TOAST rather than the page-level `failed` flag, and that is the whole
   * of the fix: `failed` renders inside the page, the dialog is modal and portalled above it, and
   * `run` leaves the dialog open on failure — so the only report of a failed save was painted
   * behind the backdrop. It also said "The calendar could not be loaded", which is a different
   * sentence about a different operation. Pressing Save produced no visible response at all.
   */
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setSaving(true)
    try {
      await action()
      setEditing(null)
      await load()
    } catch {
      toast({ tone: 'danger', title: t('calendar.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  if (client === null) {
    return (
      <div className={styles.page}>
        <EmptyState icon={CalendarDays} title={t('calendar.signedOut')} />
      </div>
    )
  }

  const days = monthGrid(focus, locale, today)
  const byDay = new Map<string, PlacedEvent[]>()
  for (const placed of events ?? []) {
    const key = toIsoDate(new Date(placed.startsAt as number))
    byDay.set(key, [...(byDay.get(key) ?? []), placed])
  }

  return (
    <div className={styles.page}>
      {/* The month, the way through it, and the one thing you come here to do — in the shell
          header on a phone, in its own strip above the grid elsewhere. This screen used to spend
          three bands before its grid began (61 + 56 + 52 = 169px, a fifth of a 390px phone), the
          first of them empty apart from the shell's own two buttons. */}
      <ScreenBar>
        <div className={styles.nav}>
          <IconButton
            label={t('calendar.previousMonth')}
            variant="ghost"
            size="sm"
            onClick={() => goto(addMonths(focus, -1))}
          >
            <ChevronLeft />
          </IconButton>
          {/* Abbreviated on a phone. "August 2026" wrapped onto two lines inside a 61px header and
              pushed everything beside it into everything else; "Aug 2026" is the same information
              in the space there is. */}
          <h1 className={shellStyles.paneTitle}>
            {formatDate(focus, { year: 'numeric', month: tier === 'phone' ? 'short' : 'long' })}
          </h1>
          <IconButton
            label={t('calendar.nextMonth')}
            variant="ghost"
            size="sm"
            onClick={() => goto(addMonths(focus, 1))}
          >
            <ChevronRight />
          </IconButton>
          {/* Today is a button where there is room and a menu entry where there is not — see the
              view picker below, which it joins. */}
          {tier !== 'phone' && (
            <Button variant="ghost" size="sm" onClick={() => goto(today)}>
              {t('calendar.today')}
            </Button>
          )}
        </div>

        {/*
          A segmented control where there is room for one, a menu where there is not.

          On a phone the header carries the month, both arrows, Today, this control, the new-event
          button and the shell's own two — 390px does not hold that, and what gave way was the
          month name, which is the one thing the screen has to state. Mail answers the same
          pressure the same way: its view options live behind one button below 40em.

          No `role="group"` on the segmented form: every button carries `aria-pressed` and names
          itself, so a group role would add a wrapper announcement without adding information.
        */}
        {tier === 'phone' ? (
          <Menu
            triggerLabel={t('calendar.viewLabel')}
            trigger={<SlidersHorizontal aria-hidden="true" />}
            triggerVariant="toolbar"
            align="end"
            items={[
              { id: 'today', label: t('calendar.today'), onSelect: () => goto(today) },
              ...VIEWS.map((id) => ({
                id,
                label: VIEW_LABELS[id](t),
                onSelect: () => setView(id),
                // A tick on the current one: the trigger is an icon here, so unlike the segmented
                // control it cannot show which view is on.
                ...(view === id ? { icon: Check } : {}),
              })),
            ]}
          />
        ) : (
          <div className={styles.views}>
            {VIEWS.map((id) => (
              <Button
                key={id}
                variant={view === id ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={view === id}
                onClick={() => setView(id)}
              >
                {VIEW_LABELS[id](t)}
              </Button>
            ))}
          </div>
        )}
        {/* The primary action, which this screen had none of on any viewport: a day cell opens the
            dialog when clicked, but nothing said so. Mail has its compose button and Contacts its
            `+`; the calendar was the one screen you could look at without being told what it is
            for. It creates on the day in focus, which is what Apple Calendar's does. */}
        <IconButton
          label={t('calendar.newEvent')}
          variant="ghost"
          size="sm"
          unavailableReason={online ? undefined : t('calendar.offline')}
          onClick={() => setEditing({ event: null, day: focus })}
        >
          <Plus />
        </IconButton>
      </ScreenBar>

      {/* A load that failed, told apart from a month with nothing in it — the two shared one
          class, so a server error and an empty calendar were the same grey sentence. */}
      {failed && (
        <EmptyState
          tone="error"
          icon={TriangleAlert}
          title={t('calendar.loadFailed')}
          action={
            <Button variant="secondary" onClick={() => void load()}>
              {t('calendar.retry')}
            </Button>
          }
        />
      )}

      {events === null && !failed ? (
        <div className={styles.loading}>
          <Spinner label={t('ui.spinner.label')} />
        </div>
      ) : view === 'month' ? (
        <MonthView
          days={days}
          byDay={byDay}
          locale={locale}
          onPick={goto}
          onCreate={(day) => setEditing({ event: null, day })}
          onOpen={(event, day) => setEditing({ event, day })}
        />
      ) : view === 'week' ? (
        <WeekView
          days={weekDays(focus, firstDayOfWeek(locale))}
          events={events ?? []}
          today={today}
          onOpen={(placed, day) => setEditing({ event: placed.event, day })}
          onCreate={(day) => setEditing({ event: null, day })}
        />
      ) : (
        <AgendaView events={events ?? []} today={today} />
      )}

      {editing !== null &&
        (editing.event !== null && !isEditable(editing.event) ? (
          // A series is shown, never edited — see `isEditable` for why.
          <Dialog
            open
            onClose={() => setEditing(null)}
            size="sm"
            title={editing.event.title || t('calendar.untitled')}
          >
            <p className={styles.readOnlyNote}>{t('calendar.event.recurringReadOnly')}</p>
          </Dialog>
        ) : (
          <Suspense fallback={null}>
            <EventDialog
              event={editing.event}
              defaultDate={editing.day}
              calendars={calendars}
              busy={saving}
              onCancel={() => setEditing(null)}
              onSubmit={(draft) => {
                const target = editing.event
                void run(() =>
                  target === null
                    ? client.createEvent(draft)
                    : client.updateEvent(target.id, draft),
                )
              }}
              onDestroy={
                editing.event === null
                  ? undefined
                  : () => {
                      const target = editing.event as CalendarEvent
                      void run(() => client.destroyEvent(target.id))
                    }
              }
            />
          </Suspense>
        ))}
    </div>
  )
}

interface MonthViewProps {
  readonly days: ReturnType<typeof monthGrid>
  readonly byDay: Map<string, PlacedEvent[]>
  readonly locale: string
  onPick: (date: Date) => void
  /** The day cell was activated — start a new event there. */
  onCreate: (date: Date) => void
  /** An event chip was activated. */
  onOpen: (event: CalendarEvent, day: Date) => void
}

function MonthView({ days, byDay, locale, onCreate, onOpen }: MonthViewProps) {
  const { t } = useTranslation()
  // Weekday headers taken from the grid's own first row, so they follow the locale's first weekday
  // rather than being hard-coded to Monday.
  const weekdays = days.slice(0, 7).map((day) => formatDate(day.date, { weekday: 'short' }))

  return (
    <div className={styles.month}>
      <div className={styles.weekdays} aria-hidden="true">
        {weekdays.map((label) => (
          <span key={label} className={styles.weekday}>
            {label}
          </span>
        ))}
      </div>
      {/* Deliberately NOT `role="grid"`. That role promises the APG grid keyboard pattern — arrow
          keys moving one tab stop across cells — and this view does not implement it. A promise
          assistive tech acts on and the keyboard does not keep is worse than no role at all; each
          day is a button labelled with its full date and reachable by Tab. */}
      <div className={styles.grid}>
        {days.map((day) => {
          const key = toIsoDate(day.date)
          const dayEvents = byDay.get(key) ?? []
          return (
            <button
              key={key}
              type="button"
              className={[
                styles.day,
                day.inMonth ? '' : styles.outside,
                day.isToday ? styles.today : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-label={formatDate(day.date, { dateStyle: 'full' })}
              onClick={() => onCreate(day.date)}
            >
              <span className={styles.dayNumber}>{day.date.getDate()}</span>
              <span className={styles.dayEvents}>
                {dayEvents.slice(0, 3).map((placed) => (
                  // A chip is its own button: clicking an event opens THAT event, while clicking
                  // the empty part of the cell starts a new one. `stopPropagation` is what keeps
                  // the two apart.
                  <button
                    key={`${placed.event.id}-${placed.startsAt}`}
                    type="button"
                    className={styles.chip}
                    onClick={(clickEvent) => {
                      clickEvent.stopPropagation()
                      onOpen(placed.event, day.date)
                    }}
                  >
                    {placed.event.title || t('calendar.untitled')}
                  </button>
                ))}
                {dayEvents.length > 3 && (
                  <span className={styles.more}>
                    {t('calendar.more', { count: dayEvents.length - 3 })}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
      <span className={styles.localeHint} lang={locale} />
    </div>
  )
}

function AgendaView({ events, today }: { readonly events: PlacedEvent[]; readonly today: Date }) {
  const { t } = useTranslation()
  // Only what is still ahead: an agenda is a list of what is coming, not a log.
  const upcoming = events.filter((placed) => (placed.endsAt ?? 0) >= startOfDay(today).getTime())

  if (upcoming.length === 0) {
    return <EmptyState icon={CalendarDays} title={t('calendar.noEvents')} />
  }

  return (
    <ol className={styles.agenda}>
      {upcoming.map((placed) => {
        const start = new Date(placed.startsAt as number)
        return (
          <li key={`${placed.event.id}-${placed.startsAt}`} className={styles.agendaRow}>
            <div className={styles.agendaWhen}>
              <span className={styles.agendaDate}>
                {formatDate(start, { weekday: 'short', day: 'numeric', month: 'short' })}
              </span>
              <span className={styles.agendaTime}>
                {placed.allDay ? t('calendar.allDay') : formatDate(start, { timeStyle: 'short' })}
              </span>
            </div>
            <div className={styles.agendaWhat}>
              <span className={styles.agendaTitle}>
                {placed.event.title || t('calendar.untitled')}
              </span>
              {/* The zone is shown only when it is NOT the reader's: an event at 10:00 in a
                  different zone is not at 10:00 for the person reading it, and saying so is the
                  difference between a calendar and a trap. */}
              {zoneDiffersFromLocal(placed.event.timeZone) && (
                <span className={styles.agendaZone}>{placed.event.timeZone}</span>
              )}
            </div>
            {!isSameDay(start, today) && <span className={styles.agendaSpacer} />}
          </li>
        )
      })}
    </ol>
  )
}
