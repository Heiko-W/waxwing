/**
 * The calendar screen (M5.6, FR-CAL-01) — a lazy route chunk.
 *
 * Three views: a **month** grid for orientation, a **week** grid with a time axis, and an **agenda**
 * list for "what is next".
 *
 * Single events can be created, edited and deleted (M5.11). A RECURRING one cannot: clicking it
 * opens a read-only note instead of the editor, because changing a series means choosing between
 * "this occurrence", "this and following" and "all", and a calendar that half-edits a repeating
 * meeting loses other people's time. `refuseEdit` is where that line is drawn — and it draws a
 * second one beside it: an occurrence the client cannot trace back to a writable object is refused
 * too, with its own sentence, because the alternative is the editor T1 described, whose Save could
 * never work.
 *
 * **One interaction rule across all three views:** clicking a DAY selects it, clicking an EVENT
 * opens it, and the `+` in the bar creates on the day that is selected. A day cell used to open the
 * new-event dialog directly, which meant the grid had no way to say "I mean this day" — the URL
 * never moved, so the arrow keys, `Today` and `+` all still pointed somewhere else (T6).
 */

import type { Calendar } from '@waxwing/jmap'
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
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  makeCalendarClient,
  type PlacedEvent,
  refusalReason,
  refuseEdit,
} from './calendar-client'

const EventDialog = lazy(() => import('./EventDialog'))

import { EventFacts } from './EventFacts'
import { zoneDiffersFromLocal } from './jscalendar-time'
import {
  addDays,
  addMonths,
  daysBetween,
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

/**
 * How many event chips a month cell shows before it starts counting.
 *
 * A cell is one row of a six-row grid that fills the pane; it cannot grow, so a fourth line is not
 * shortened but SLICED at the cell boundary — the "+2 more" line was legible down to about half its
 * x-height (T8). The cap is therefore honoured by the count as well: a cell that needs the counter
 * shows one chip fewer to make room for it, so the tallest a cell ever gets is the same three lines
 * either way.
 */
const MAX_CHIPS = 3

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
  /** `{ placed }` edits, `{ placed: null }` creates on `day`. */
  const [editing, setEditing] = useState<{ placed: PlacedEvent | null; day: Date } | null>(null)
  /** The day whose full event list is open (T8) — `null` when none is. */
  const [expandedDay, setExpandedDay] = useState<Date | null>(null)
  const [saving, setSaving] = useState(false)
  /**
   * The last answer, **stamped with the window it answers about**.
   *
   * Holding a bare list is what let September show August's events: the fetch for the new month was
   * still in flight, `events` still held the old month's, and the grid drew them under the new
   * heading as if they were real (T5). Stamping makes staleness a question the render can answer —
   * a list whose window is not the window on screen is simply not shown.
   */
  const [loaded, setLoaded] = useState<{
    fromMs: number
    toMs: number
    list: PlacedEvent[]
  } | null>(null)
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
   *
   * The week view fetches this same window rather than its own seven days: the six-week grid of the
   * month containing `focus` always contains the whole week containing `focus`, so stepping between
   * weeks inside a month costs no request at all.
   */
  const { fromMs, toMs } = useMemo(() => {
    const range = monthRange(focus, locale)
    return { fromMs: range.from.getTime(), toMs: range.to.getTime() }
  }, [focus, locale])

  /**
   * Which fetch is the current one.
   *
   * Two loads can be in flight after quick paging, and they can answer out of order. Without this
   * the older answer wins and the screen settles on the wrong month's data — the same class of bug
   * as the stale list above, arriving by a different route.
   */
  const request = useRef(0)

  const load = useCallback(async () => {
    if (client === null) return
    request.current += 1
    const mine = request.current
    // Clearing the failure at the START of the attempt, so a retry shows that it is trying rather
    // than leaving the error on screen until it either succeeds or fails again.
    setFailed(false)
    try {
      const [inRange, list] = await Promise.all([
        client.eventsInRange(new Date(fromMs), new Date(toMs)),
        client.listCalendars(),
      ])
      if (mine !== request.current) return
      setLoaded({ fromMs, toMs, list: inRange })
      setCalendars(list)
    } catch {
      if (mine !== request.current) return
      setFailed(true)
    }
  }, [client, fromMs, toMs])

  useEffect(() => {
    void load()
  }, [load])

  const goto = useCallback(
    (date: Date): void => navigate(calendarPath(toIsoDate(date))),
    [navigate],
  )

  /**
   * Runs a write, then reloads. Closes the dialog only on success, so a refusal keeps the user's
   * input on screen to correct rather than discarding it.
   *
   * A failed write raises a TOAST rather than the page-level `failed` flag: `failed` renders inside
   * the page, the dialog is modal and portalled above it, and this leaves the dialog open on
   * failure — so a report painted inside the page would sit behind the backdrop.
   *
   * `failureTitle` is a parameter and not a constant, which is the whole of T7: one `run` served
   * create, update and delete, and all three reported "The event could not be saved." after a
   * failed DELETE. The server's own reason is passed through underneath it — Stalwart said
   * "Deleting synthetic ids is not yet supported.", the client received it, and nothing showed it.
   */
  async function run<T>(
    action: () => Promise<T>,
    failureTitle: string,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    setSaving(true)
    try {
      const value = await action()
      setEditing(null)
      await load()
      return { ok: true, value }
    } catch (error) {
      toast({
        tone: 'danger',
        title: failureTitle,
        ...(refusalReason(error) === null ? {} : { description: refusalReason(error) }),
      })
      return { ok: false }
    } finally {
      setSaving(false)
    }
  }

  /**
   * Opens the editor, or explains why it cannot.
   *
   * The offline gate lives here rather than on each control because there were three ways in and
   * only one of them was gated: the `+` button knew, the day cell and the event chip did not. The
   * dialog is a `lazy()` chunk, so offline the import failed, the chunk boundary rendered nothing,
   * and the whole application went white (T3). A read-only note needs neither the chunk nor a
   * connection, so it is still offered offline — it is the editor that cannot work.
   */
  const openEvent = (placed: PlacedEvent, day: Date): void => {
    if (refuseEdit(placed) === null && !online) {
      toast({ tone: 'warning', title: t('calendar.offlineOpen') })
      return
    }
    setExpandedDay(null)
    setEditing({ placed, day })
  }

  const createEvent = (day: Date): void => {
    if (!online) {
      toast({ tone: 'warning', title: t('calendar.offline') })
      return
    }
    setExpandedDay(null)
    setEditing({ placed: null, day })
  }

  const deleteEvent = async (target: PlacedEvent): Promise<void> => {
    // Narrowed here rather than relying on the early return below, which comes later in the body.
    const writer = client
    if (writer === null) return
    const outcome = await run(() => writer.destroyEvent(target), t('calendar.deleteFailed'))
    if (!outcome.ok) return
    const snapshot = outcome.value
    /*
     * Deleted, and undoable — not "are you sure?" first.
     *
     * Delete is the one irreversible control on this screen, and the app already answers that
     * question elsewhere: mail triage moves and then offers the inverse (`use-triage.ts`). A
     * confirmation taxes every correct deletion to catch the rare wrong one; an Undo taxes none
     * and catches all of them. The toast does not expire while it carries an action (M4.7, WCAG
     * 2.2.1) — reaching it by Tab means crossing the shell, which nobody does in five seconds.
     *
     * When the copy could not be taken the toast still reports the deletion but offers nothing,
     * because a button labelled Undo that cannot restore is worse than no button at all.
     */
    toast({
      title: t('calendar.deleted'),
      ...(snapshot === null
        ? {}
        : {
            duration: 0,
            action: {
              label: t('calendar.undo'),
              onAction: () => {
                void run(() => writer.restoreEvent(snapshot), t('calendar.restoreFailed'))
              },
            },
          }),
    })
  }

  if (client === null) {
    return (
      <div className={styles.page}>
        <EmptyState icon={CalendarDays} title={t('calendar.signedOut')} />
      </div>
    )
  }

  /** Only ever the list that answers about the window on screen — see `loaded`. */
  const events =
    loaded !== null && loaded.fromMs === fromMs && loaded.toMs === toMs ? loaded.list : null

  const days = monthGrid(focus, locale, today)
  const week = weekDays(focus, firstDayOfWeek(locale))
  const byDay = new Map<string, PlacedEvent[]>()
  for (const placed of events ?? []) {
    /*
     * Every day the event touches, not only the one it starts on.
     *
     * A three-day whole-day event was keyed by its start alone, so it appeared on the 12th and the
     * 13th and 14th were empty — the event was invisible to anyone looking at the days it actually
     * covers (T4). The list stays in start order because the source list is.
     */
    for (const key of daysBetween(
      placed.startsAt as number,
      placed.endsAt ?? (placed.startsAt as number),
    )) {
      byDay.set(key, [...(byDay.get(key) ?? []), placed])
    }
  }

  const step = (delta: number): void =>
    goto(view === 'week' ? addDays(focus, delta * 7) : addMonths(focus, delta))

  /* The week view names the week it shows. It used to say "August 2026" over a strip of seven days
     that could start in July, and its arrows said "Next month" and jumped one (T6). */
  const heading =
    view === 'week'
      ? t('calendar.weekRange', {
          from: formatDate(week[0] ?? focus, { day: 'numeric', month: 'short' }),
          to: formatDate(week[6] ?? focus, { day: 'numeric', month: 'short', year: 'numeric' }),
        })
      : formatDate(focus, { year: 'numeric', month: tier === 'phone' ? 'short' : 'long' })

  return (
    <div className={styles.page}>
      {/* The month, the way through it, and the one thing you come here to do — in the shell
          header on a phone, in its own strip above the grid elsewhere. This screen used to spend
          three bands before its grid began (61 + 56 + 52 = 169px, a fifth of a 390px phone), the
          first of them empty apart from the shell's own two buttons. */}
      <ScreenBar>
        <div className={styles.nav}>
          <IconButton
            label={view === 'week' ? t('calendar.previousWeek') : t('calendar.previousMonth')}
            variant="ghost"
            size="sm"
            onClick={() => step(-1)}
          >
            <ChevronLeft />
          </IconButton>
          {/* Abbreviated on a phone. "August 2026" wrapped onto two lines inside a 61px header and
              pushed everything beside it into everything else; "Aug 2026" is the same information
              in the space there is. */}
          <h1 className={shellStyles.paneTitle}>{heading}</h1>
          <IconButton
            label={view === 'week' ? t('calendar.nextWeek') : t('calendar.nextMonth')}
            variant="ghost"
            size="sm"
            onClick={() => step(1)}
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
        {/* The primary action, which this screen had none of on any viewport: it creates on the day
            in focus, which is what Apple Calendar's does — and since a click on a day now MOVES the
            focus, "the day I just tapped" and "the day + will use" are the same day. */}
        <IconButton
          label={t('calendar.newEvent')}
          variant="ghost"
          size="sm"
          unavailableReason={online ? undefined : t('calendar.offline')}
          onClick={() => createEvent(focus)}
        >
          <Plus />
        </IconButton>
      </ScreenBar>

      {/*
        Exactly ONE of: the failure, the spinner, the view.

        All three used to be able to stand in the DOM at once, and the combination was the worst of
        the three: a red "could not be loaded" over a grid that looked complete and was not (T5).
        A failure with usable data for THIS window keeps the data and reports in one line above it;
        a failure with nothing to show takes the whole pane, which is where a Try again belongs.
      */}
      {failed && events === null ? (
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
      ) : (
        <>
          {failed && (
            <div className={styles.loadError} role="alert">
              <TriangleAlert aria-hidden="true" />
              <span className={styles.loadErrorText}>{t('calendar.refreshFailed')}</span>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                {t('calendar.retry')}
              </Button>
            </div>
          )}
          {events === null ? (
            <div className={styles.loading}>
              <Spinner label={t('ui.spinner.label')} />
            </div>
          ) : view === 'month' ? (
            <MonthView
              days={days}
              byDay={byDay}
              locale={locale}
              focus={focus}
              onPick={goto}
              onExpand={setExpandedDay}
              onOpen={openEvent}
            />
          ) : view === 'week' ? (
            <WeekView
              days={week}
              events={events}
              today={today}
              focus={focus}
              onOpen={openEvent}
              onPick={goto}
            />
          ) : (
            <AgendaView events={events} today={today} onOpen={openEvent} />
          )}
        </>
      )}

      {expandedDay !== null && (
        <DayDialog
          day={expandedDay}
          events={byDay.get(toIsoDate(expandedDay)) ?? []}
          onClose={() => setExpandedDay(null)}
          onOpen={openEvent}
        />
      )}

      {editing !== null &&
        (editing.placed !== null && refuseEdit(editing.placed) !== null ? (
          // Shown, never edited — see `refuseEdit` for the two reasons and why they read
          // differently.
          <Dialog
            open
            onClose={() => setEditing(null)}
            size="sm"
            title={editing.placed.event.title || t('calendar.untitled')}
          >
            <p className={styles.readOnlyNote}>
              {refuseEdit(editing.placed) === 'series'
                ? t('calendar.event.recurringReadOnly')
                : t('calendar.event.unresolvedReadOnly')}
            </p>
            <EventFacts event={editing.placed.event} />
          </Dialog>
        ) : (
          <Suspense fallback={null}>
            <EventDialog
              event={editing.placed?.event ?? null}
              defaultDate={editing.day}
              calendars={calendars}
              busy={saving}
              onCancel={() => setEditing(null)}
              onSubmit={(draft) => {
                const target = editing.placed
                void run(
                  () =>
                    target === null ? client.createEvent(draft) : client.updateEvent(target, draft),
                  t('calendar.saveFailed'),
                )
              }}
              onDestroy={
                editing.placed === null
                  ? undefined
                  : () => {
                      const target = editing.placed as PlacedEvent
                      void deleteEvent(target)
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
  /** The selected day, drawn as selected — the answer to "what did my click do?". */
  readonly focus: Date
  onPick: (date: Date) => void
  /** The counter under a full cell was activated — show that day's whole list. */
  onExpand: (date: Date) => void
  /** An event chip was activated. */
  onOpen: (placed: PlacedEvent, day: Date) => void
}

function MonthView({ days, byDay, locale, focus, onPick, onExpand, onOpen }: MonthViewProps) {
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
          // See MAX_CHIPS: a cell shows either three chips or two and a counter, never four lines.
          const shown = dayEvents.length > MAX_CHIPS ? dayEvents.slice(0, MAX_CHIPS - 1) : dayEvents
          const hidden = dayEvents.length - shown.length
          return (
            /*
             * The cell is a DIV with a button stretched across it, not a button containing the
             * chips.
             *
             * `<button>` inside `<button>` is invalid HTML — React said so twice on every visit to
             * this screen (T9) — and what a browser does with the inner one is undefined. The fill
             * is a real button that takes the whole cell, so the target is unchanged; the chips are
             * its siblings, sitting above it in the stacking order, so a click on a chip is a click
             * on the chip and needs no `stopPropagation` to say so.
             */
            <div
              key={key}
              className={[
                styles.day,
                day.inMonth ? '' : styles.outside,
                day.isToday ? styles.today : '',
                !day.isToday && isSameDay(day.date, focus) ? styles.picked : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                type="button"
                className={styles.dayFill}
                aria-label={formatDate(day.date, { dateStyle: 'full' })}
                {...(day.isToday ? { 'aria-current': 'date' as const } : {})}
                onClick={() => onPick(day.date)}
              />
              <span className={styles.dayNumber} aria-hidden="true">
                {day.date.getDate()}
              </span>
              <span className={styles.dayEvents}>
                {shown.map((placed) => (
                  <button
                    key={`${placed.event.id}-${placed.startsAt}`}
                    type="button"
                    className={styles.chip}
                    onClick={() => onOpen(placed, day.date)}
                  >
                    {placed.event.title || t('calendar.untitled')}
                  </button>
                ))}
                {hidden > 0 && (
                  // A button, not a caption. It read as one and was not: a click went through to
                  // the cell and opened the new-event dialog, so the events it counted were
                  // unreachable in this view by any means (T8).
                  <button type="button" className={styles.more} onClick={() => onExpand(day.date)}>
                    {t('calendar.more', { count: hidden })}
                  </button>
                )}
              </span>
            </div>
          )
        })}
      </div>
      <span className={styles.localeHint} lang={locale} />
    </div>
  )
}

/** Everything on one day, for the cells that cannot show everything (T8). */
function DayDialog({
  day,
  events,
  onClose,
  onOpen,
}: {
  readonly day: Date
  readonly events: readonly PlacedEvent[]
  onClose: () => void
  onOpen: (placed: PlacedEvent, day: Date) => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open onClose={onClose} size="sm" title={formatDate(day, { dateStyle: 'full' })}>
      {events.length === 0 ? (
        <p className={styles.readOnlyNote}>{t('calendar.noEventsOnDay')}</p>
      ) : (
        <ul className={styles.dayList}>
          {events.map((placed) => (
            <li key={`${placed.event.id}-${placed.startsAt}`}>
              <button
                type="button"
                className={styles.dayListRow}
                onClick={() => onOpen(placed, day)}
              >
                <span className={styles.dayListTime}>
                  {placed.allDay
                    ? t('calendar.allDay')
                    : formatDate(new Date(placed.startsAt as number), { timeStyle: 'short' })}
                </span>
                <span className={styles.dayListTitle}>
                  {placed.event.title || t('calendar.untitled')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

function AgendaView({
  events,
  today,
  onOpen,
}: {
  readonly events: readonly PlacedEvent[]
  readonly today: Date
  onOpen: (placed: PlacedEvent, day: Date) => void
}) {
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
          <li key={`${placed.event.id}-${placed.startsAt}`}>
            <button
              type="button"
              className={styles.agendaRow}
              onClick={() => onOpen(placed, start)}
            >
              <span className={styles.agendaWhen}>
                <span className={styles.agendaDate}>
                  {formatDate(start, { weekday: 'short', day: 'numeric', month: 'short' })}
                </span>
                <span className={styles.agendaTime}>
                  {placed.allDay ? t('calendar.allDay') : formatDate(start, { timeStyle: 'short' })}
                </span>
              </span>
              <span className={styles.agendaWhat}>
                <span className={styles.agendaTitle}>
                  {placed.event.title || t('calendar.untitled')}
                </span>
                {/* The zone is shown only when it is NOT the reader's: an event at 10:00 in a
                    different zone is not at 10:00 for the person reading it, and saying so is the
                    difference between a calendar and a trap.

                    A whole-day event is excluded outright, whatever the property says. It HAS no
                    zone by definition, and the expanded query answers `Etc/UTC` for one where a
                    direct read answers `null` — so the agenda announced a zone for an event that
                    cannot have one, in the same place it announces a real one (T12). */}
                {!placed.allDay && zoneDiffersFromLocal(placed.event.timeZone) && (
                  <span className={styles.agendaZone}>{placed.event.timeZone}</span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
