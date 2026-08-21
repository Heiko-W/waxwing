/**
 * The calendar screen (M5.6, FR-CAL-01) — a lazy route chunk.
 *
 * Three views: a **month** grid for orientation, a **week** grid with a time axis, and an **agenda**
 * list for "what is next".
 *
 * Events can be created, edited and deleted (M5.11) — **including repeating ones (K-2)**. A series
 * no longer opens a read-only note: it opens the editor, and the scope question ("this event" /
 * "all events") is asked after Save, which is where Apple asks it and the only place it can be
 * answered. `refuseEdit` still draws one line: an occurrence the client cannot trace back to a
 * writable object is refused, with its own sentence, because the alternative is the editor T1
 * described, whose Save could never work.
 *
 * **Participants and RSVP (K-3)** ride in the same editor. The answer bar appears only when one of
 * the participants carries an address this account owns — which is what `ParticipantIdentity/get`
 * (K-10) is fetched for, once per mount — and the calendar grants `mayRSVP`. Inviting works because
 * `CalendarEvent/set` is given `sendSchedulingMessages: true`; measured, it is the only trigger.
 *
 * **One interaction rule across all three views:** clicking a DAY selects it, clicking an EVENT
 * opens it, and the `+` in the bar creates on the day that is selected. A day cell used to open the
 * new-event dialog directly, which meant the grid had no way to say "I mean this day" — the URL
 * never moved, so the arrow keys, `Today` and `+` all still pointed somewhere else (T6).
 *
 * **The calendars themselves are managed here too (K-1), and that changes what the grid asks for.**
 * The list of calendars is a rail from 40em up and a screen-high sheet below it, reached from the
 * same view menu that already carries Today. Ticking one off writes `isVisible` to the SERVER and
 * then re-fetches the month naming only the calendars that are on — `eventsInRange`'s third
 * parameter, which had existed since M5.6 with no caller. So the two loads are no longer
 * independent: the calendars are fetched first and the events depend on their answer, which costs
 * one extra round trip on the first paint and none afterwards. The alternative, filtering the drawn
 * list locally, looks the same on this screen and is a lie on the phone.
 */

import type { Calendar, Id, Principal } from '@waxwing/jmap'
import type { TFunction } from 'i18next'
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Import,
  Plus,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { calendarPath, useNavigate, useRoute } from '../app/route'
import { useSessionOptional } from '../app/session/context'
import { useLayoutTier } from '../app/shell/layout'
import { ScreenBar } from '../app/shell/ScreenBar'
import shellStyles from '../app/shell/shell.module.css'
import { useOnline } from '../app/use-online'
import { formatDate } from '../i18n/formatters'
import { makeCalendarSharingClient } from '../sharing/calendar-share-client'
import { IncomingShares } from '../sharing/IncomingShares'
import { currentUserPrincipalId, principalLabel } from '../sharing/principals'
import { useIncomingShares } from '../sharing/use-incoming-shares'
import { Button, Dialog, EmptyState, IconButton, Menu, Select, Spinner, useToast } from '../ui'
import { type BusyPeriod, toBusyPeriods } from './availability'
import styles from './calendar.module.css'
import {
  type CalendarClient,
  type CalendarDraft,
  makeCalendarClient,
  mayCreateCalendar,
  needsScope,
  type PlacedEvent,
  refusalReason,
  refuseEdit,
} from './calendar-client'
import { DEFAULT_MAX_PARTICIPANTS, ownAddresses } from './event-participants'
import type { EditScope } from './event-recurrence'

const EventDialog = lazy(() => import('./EventDialog'))
/*
 * The import sheet is a chunk of its own, and not part of `EventDialog`: reading a `.ics` is a rare,
 * deliberate act, and the editor is opened many times a session. Registered in `.size-limit.js`.
 */
const IcsImportDialog = lazy(() => import('./IcsImportDialog'))
/*
 * The share dialog is a chunk of its own (registered in `.size-limit.js`), and not part of this
 * screen's: it pulls in the generic `ShareDialog` and the principal picker, which the great majority
 * of calendar sessions never open.
 */
const CalendarShareDialog = lazy(() => import('../sharing/CalendarShareDialog'))

import CalendarDialog, { CalendarDeleteDialog } from './CalendarDialog'
import { CalendarList, visibleCalendarIds } from './CalendarList'
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
import { weekDays, weekRange } from './week-grid'

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
  /**
   * Whether {@link calendars} is an ANSWER or just the initial empty value.
   *
   * Without it the first paint cannot tell "this account has no calendars" from "the list has not
   * arrived", and the range query would either fetch nothing for ever or fetch everything once and
   * then contradict itself.
   */
  const [calendarsLoaded, setCalendarsLoaded] = useState(false)
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
    /** Which calendars the list answers about — see `visibleKey`. */
    visibleKey: string
    list: PlacedEvent[]
  } | null>(null)
  const [failed, setFailed] = useState(false)
  /** `{ calendar }` edits, `{ calendar: null }` creates. */
  const [editingCalendar, setEditingCalendar] = useState<{ calendar: Calendar | null } | null>(null)
  /** The calendar the reader asked to delete, and how many events go with it (`null` = counting). */
  const [deleting, setDeleting] = useState<{ calendar: Calendar; count: number | null } | null>(
    null,
  )
  /** The calendar list on a phone, where there is no rail to put it in. */
  const [calendarsOpen, setCalendarsOpen] = useState(false)
  /**
   * This account's own calendar addresses (K-10) — fetched once, read only to answer "which of
   * these participants is me".
   *
   * Failure is silent and empty on purpose: a server without `ParticipantIdentity` is a server on
   * which the RSVP bar cannot be shown, which is a missing control rather than a broken screen. The
   * session's calendar capability was expected to carry the same address and would have cost no
   * round trip at all — measured on v0.16.18, it does not.
   */
  const [myAddresses, setMyAddresses] = useState<readonly string[]>([])
  /*
   * Incoming calendar shares (S-1, extended to this type by S-2).
   *
   * No `onOpen` is passed to the strip: following the card means opening someone ELSE's calendar,
   * and this screen is wired to `connected.accountId` throughout — `sharing/probe.ts` does not even
   * have a `calendar` area, because there is no rail that could render one. The card announces the
   * share; a button that led back to the reader's own calendars would be a lie.
   */
  const incoming = useIncomingShares('Calendar')
  /** The `.ics` import sheet (K-4). */
  const [importing, setImporting] = useState(false)
  /** The calendar whose share dialog is open (S-2), or `null`. */
  const [sharing, setSharing] = useState<Calendar | null>(null)
  /**
   * Whose availability is drawn behind the week grid (S-6) — a principal id, or `null` for nobody.
   *
   * Deliberately NOT persisted. It is a question ("when is Bob free this week?"), not a preference,
   * and a hatch that was still there next week over somebody the reader had forgotten choosing
   * would be read as their own calendar being wrong.
   */
  const [availabilityOf, setAvailabilityOf] = useState<Id | null>(null)
  /** The directory to choose from — fetched once, and only once the picker is on screen. */
  const [people, setPeople] = useState<readonly Principal[] | null>(null)
  /** The answer for {@link availabilityOf}, or `null` for "no answer" — never `[]` for it. */
  const [busy, setBusy] = useState<readonly BusyPeriod[] | null>(null)
  /**
   * Whether that answer is still on its way.
   *
   * Its own flag rather than "busy is null", because those are two different sentences and one of
   * them is a claim: without it, the moment between choosing somebody and their diary arriving
   * showed "No availability came back for that person" — a false statement, flashed at the reader,
   * that reads as a failure and then vanishes.
   */
  const [busyPending, setBusyPending] = useState(false)

  /** The day the view is centred on: the route param, else today. */
  const focusDay = route.params.date
  const focus = useMemo(() => fromIsoDate(focusDay) ?? today, [focusDay, today])

  const injected = props.client
  const sessionClient = connected?.client ?? null
  const accountId = connected?.accountId ?? null

  /**
   * The server's own ceiling on participants, from the account capability (measured `20`).
   *
   * Read rather than assumed so the editor refuses the 21st attendee here, with a sentence, instead
   * of letting the whole save come back `tooManyParticipants` after the reader has finished typing.
   */
  const maxParticipants = useMemo(() => {
    const capability =
      accountId === null
        ? undefined
        : (connected?.jmapSession?.accounts?.[accountId]?.accountCapabilities?.[
            'urn:ietf:params:jmap:calendars'
          ] as { maxParticipantsPerEvent?: number | null } | undefined)
    return capability?.maxParticipantsPerEvent ?? DEFAULT_MAX_PARTICIPANTS
  }, [connected, accountId])
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

  /**
   * `null` until the calendars are known; then the ids whose events to ask for.
   *
   * The distinction matters: an EMPTY list is "every calendar is switched off" and must draw an
   * empty month, while "not known yet" must not fetch at all — asking with no filter would draw
   * every event for one paint and then take the hidden ones away again.
   */
  const visibleIds = useMemo(
    () => (calendarsLoaded ? visibleCalendarIds(calendars) : null),
    [calendars, calendarsLoaded],
  )
  /** A stable stamp for "which calendars this answer is about", for the staleness check below. */
  const visibleKey = (visibleIds ?? []).join(',')

  /**
   * Whether the availability layer has anywhere to go (S-6).
   *
   * The week view alone: it is the only one of the three with a time axis, and free/busy without a
   * time axis is a list of intervals nobody can compare against anything. Rather than draw a picker
   * in the month view that quietly does nothing, the picker itself is week-only — so there is no
   * control on screen whose effect the reader cannot see.
   */
  const showAvailability = view === 'week'

  /**
   * The week on screen, as timestamps.
   *
   * Timestamps rather than `Date`s for the same reason `fromMs`/`toMs` are: a `Date` is a fresh
   * object every render, so an effect keyed on one never settles.
   */
  const { weekFromMs, weekToMs } = useMemo(() => {
    const range = weekRange(focus, firstDayOfWeek(locale))
    return { weekFromMs: range.from.getTime(), weekToMs: range.to.getTime() }
  }, [focus, locale])

  /**
   * Whose availability the hatch is, as a name.
   *
   * `null` until the directory has come back with a name for the chosen id, and the week view draws
   * nothing while it is — a hatch nobody is named beside is a pattern the reader has to guess at.
   */
  const busyName = useMemo(() => {
    if (availabilityOf === null) return null
    const person = (people ?? []).find((entry) => entry.id === availabilityOf)
    return person === undefined ? null : principalLabel(person)
  }, [people, availabilityOf])

  /**
   * The share seam (S-2) — `Calendar/set … shareWith`, classified separately from the editor's write.
   *
   * `null` when there is no session, which is what removes the affordance from every row rather
   * than letting one open a dialog that cannot save.
   */
  const sharingClient = useMemo(
    () =>
      sessionClient === null || accountId === null
        ? null
        : makeCalendarSharingClient(
            sessionClient,
            accountId,
            currentUserPrincipalId(connected?.jmapSession ?? null, accountId),
          ),
    [sessionClient, accountId, connected],
  )

  const loadCalendars = useCallback(async () => {
    if (client === null) return
    try {
      setCalendars(await client.listCalendars())
      setCalendarsLoaded(true)
    } catch {
      setFailed(true)
    }
  }, [client])

  const load = useCallback(async () => {
    if (client === null || visibleIds === null) return
    request.current += 1
    const mine = request.current
    // Clearing the failure at the START of the attempt, so a retry shows that it is trying rather
    // than leaving the error on screen until it either succeeds or fails again.
    setFailed(false)
    try {
      const inRange = await client.eventsInRange(new Date(fromMs), new Date(toMs), visibleIds)
      if (mine !== request.current) return
      setLoaded({ fromMs, toMs, visibleKey, list: inRange })
    } catch {
      if (mine !== request.current) return
      setFailed(true)
    }
  }, [client, fromMs, toMs, visibleIds, visibleKey])

  useEffect(() => {
    void loadCalendars()
  }, [loadCalendars])

  useEffect(() => {
    if (client === null) return
    let live = true
    void client
      .listParticipantIdentities()
      .then((identities) => {
        if (live) setMyAddresses(ownAddresses(identities))
      })
      // Swallowed: see `myAddresses`. Nothing on this screen depends on it except one optional bar.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * The directory, fetched at most once and only when the picker is actually on screen.
   *
   * `Principal/query` + `/get` is a round trip that says nothing about the reader's own calendar, so
   * it may not ride along with the month load. `showAvailability` gates it: the picker exists in the
   * week view alone (that is the only view with a time axis to hatch), so a reader who never opens
   * the week view never sends it.
   *
   * A failure sets an EMPTY list rather than leaving `null`: `null` is "still asking" and would spin
   * for ever. An empty directory renders the picker disabled with its "nobody to ask" note, which is
   * the honest outcome of a server that will not answer.
   */
  useEffect(() => {
    if (client === null || !showAvailability || people !== null) return
    let live = true
    void client
      .listPrincipals()
      .then((list) => {
        if (live) setPeople(list)
      })
      .catch(() => {
        if (live) setPeople([])
      })
    return () => {
      live = false
    }
  }, [client, showAvailability, people])

  /*
   * The busy periods for the chosen person, over the week on screen.
   *
   * The WEEK, not the month the events are fetched for: the hatch is only ever drawn in the week
   * view, and asking for six weeks of somebody else's diary to draw one is six times the answer for
   * nothing. Well inside `maxAvailabilityDuration` (`P52W1D`) either way — which the server was
   * measured NOT to enforce, so staying inside it is this client's own discipline.
   *
   * `null` on failure, and `null` while in flight: both mean "nothing to draw", and neither is `[]`,
   * which would be the claim that the person is free all week.
   */
  useEffect(() => {
    if (client === null || availabilityOf === null || !showAvailability) {
      setBusy(null)
      setBusyPending(false)
      return
    }
    let live = true
    setBusyPending(true)
    void client
      .getAvailability(availabilityOf, new Date(weekFromMs), new Date(weekToMs))
      .then((list) => {
        if (!live) return
        setBusy(list === null ? null : toBusyPeriods(list))
        setBusyPending(false)
      })
      .catch(() => {
        if (!live) return
        setBusy(null)
        setBusyPending(false)
      })
    return () => {
      live = false
    }
  }, [client, availabilityOf, showAvailability, weekFromMs, weekToMs])

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

  const deleteEvent = async (target: PlacedEvent, scope: EditScope = 'all'): Promise<void> => {
    // Narrowed here rather than relying on the early return below, which comes later in the body.
    const writer = client
    if (writer === null) return
    /*
     * Removing ONE occurrence of a series is an `excluded` override on the master, not a delete —
     * so there is nothing to snapshot and nothing to restore, and the toast must not offer an Undo
     * it cannot honour. Undoing it would mean removing the override again, which is a different
     * write with a different failure mode; it is left out rather than approximated.
     */
    if (scope === 'occurrence' && needsScope(target)) {
      const removed = await run(() => writer.excludeOccurrence(target), t('calendar.deleteFailed'))
      if (removed.ok) toast({ title: t('calendar.occurrenceDeleted') })
      return
    }
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

  /**
   * Ticking a calendar on or off.
   *
   * Optimistic, and the optimism is not decoration: the write is followed by a fresh range query,
   * so waiting for the round trip before moving the tick would leave the reader looking at a
   * checkbox that ignored them for as long as the server took. On refusal the tick goes back where
   * it was and the toast says why — the list is re-read rather than patched back, so the screen
   * ends up agreeing with the server rather than with our guess about it.
   */
  const toggleCalendar = async (calendar: Calendar, visible: boolean): Promise<void> => {
    if (client === null) return
    setCalendars((current) =>
      current.map((entry) => (entry.id === calendar.id ? { ...entry, isVisible: visible } : entry)),
    )
    try {
      await client.updateCalendar(calendar.id, { isVisible: visible })
    } catch (error) {
      await loadCalendars()
      toast({
        tone: 'danger',
        title: t('calendar.calendars.toggleFailed'),
        ...(refusalReason(error) === null ? {} : { description: refusalReason(error) }),
      })
    }
  }

  const saveCalendar = async (draft: CalendarDraft): Promise<void> => {
    if (client === null || editingCalendar === null) return
    const target = editingCalendar.calendar
    setSaving(true)
    try {
      if (target === null) await client.createCalendar(draft)
      else await client.updateCalendar(target.id, draft)
      setEditingCalendar(null)
      await loadCalendars()
    } catch (error) {
      toast({
        tone: 'danger',
        title: t('calendar.calendars.saveFailed'),
        ...(refusalReason(error) === null ? {} : { description: refusalReason(error) }),
      })
    } finally {
      setSaving(false)
    }
  }

  /**
   * Opens the confirmation, then fetches what it has to say.
   *
   * The count is asked for AFTER the dialog is on screen rather than before it, so the answer to a
   * menu click is immediate. Until it arrives the confirm button is out of reach — see
   * `CalendarDeleteDialog`: agreeing to lose an unknown number of events is not agreement.
   */
  const askDelete = async (calendar: Calendar): Promise<void> => {
    if (client === null) return
    setCalendarsOpen(false)
    setDeleting({ calendar, count: null })
    try {
      const count = await client.countEvents(calendar.id)
      setDeleting((current) =>
        current?.calendar.id === calendar.id ? { calendar, count } : current,
      )
    } catch {
      // A count we could not take must not become a zero. Nothing changes; the dialog keeps saying
      // it is counting and Delete stays unavailable, which is the honest end of this path.
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (client === null || deleting === null) return
    setSaving(true)
    try {
      await client.destroyCalendar(deleting.calendar.id)
      setDeleting(null)
      await loadCalendars()
      toast({ title: t('calendar.calendars.deleted', { name: deleting.calendar.name }) })
    } catch (error) {
      toast({
        tone: 'danger',
        title: t('calendar.calendars.deleteFailed'),
        ...(refusalReason(error) === null ? {} : { description: refusalReason(error) }),
      })
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

  /** Only ever the list that answers about the window on screen — see `loaded`. */
  const events =
    loaded !== null &&
    loaded.fromMs === fromMs &&
    loaded.toMs === toMs &&
    loaded.visibleKey === visibleKey
      ? loaded.list
      : null

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
     that could start in July, and its arrows said "Next month" and jumped one (T6).

     The month name is spelled out on every viewport again. It was abbreviated on a phone to buy
     room inside the header — which did not work (see `phoneTitle` below), and is not needed now
     that the heading has a line of its own there. */
  const heading =
    view === 'week'
      ? t('calendar.weekRange', {
          from: formatDate(week[0] ?? focus, { day: 'numeric', month: 'short' }),
          to: formatDate(week[6] ?? focus, { day: 'numeric', month: 'short', year: 'numeric' }),
        })
      : formatDate(focus, { year: 'numeric', month: 'long' })

  /*
   * Where the heading goes, and why it is not always in the bar (F1).
   *
   * On a phone the bar is the SHELL header, and it holds four 44px controls of this screen's own
   * (both arrows, the view menu, the new-event button) beside the shell's palette, compose and
   * account buttons. Seven touch targets, their gaps and the header's own inset come to some 388 of
   * the 390px there are: measured, the heading got 32px of the 76 it needs — "A…" where it should
   * say "August 2026", and "1…" for a week range. The targets are correct at 44px (T15) and may not
   * shrink, the shell's buttons are not this screen's to remove, and no stylesheet can invent the
   * missing 44px: the arithmetic is the defect, exactly as it was for the reading pane's
   * eleven-button toolbar (`mail/use-action-overflow.ts`).
   *
   * So the heading stops competing for that row. Below 40em it becomes the page's own title line,
   * full width, above the grid — which is where Apple Calendar puts the month on an iPhone, at the
   * size a heading is meant to be read at, and the one thing this screen must state. It costs a
   * single text line; the alternative costs the reader the ability to tell which month they are
   * looking at. Above 40em nothing changes: the pane's strip has room for both.
   */
  const phoneTitle = tier === 'phone'

  return (
    <div className={styles.page}>
      {/* The way through the month and the one thing you come here to do — in the shell header on
          a phone, in its own strip above the grid elsewhere. This screen used to spend three bands
          before its grid began (61 + 56 + 52 = 169px, a fifth of a 390px phone), the first of them
          empty apart from the shell's own two buttons. The month NAME joins them from 40em up; on a
          phone it is the page title below (see `phoneTitle`). */}
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
          {!phoneTitle && <h1 className={shellStyles.paneTitle}>{heading}</h1>}
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
              /* Below 40em there is no rail to hold the calendar list, so it becomes a screen-high
                 sheet from the one menu this screen already has. Same list, same controls — the
                 difference is where it is anchored, which is the difference Apple's own calendar
                 makes between an iPad and an iPhone. */
              {
                id: 'calendars',
                label: t('calendar.calendars.open'),
                onSelect: () => setCalendarsOpen(true),
              },
              // Importing a file is rare and deliberate; it belongs in a menu on every viewport,
              // not beside the one control this screen uses constantly.
              ...(online && calendars.length > 0
                ? [
                    {
                      id: 'import',
                      label: t('calendar.import.open'),
                      onSelect: () => setImporting(true),
                    },
                  ]
                : []),
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
          <>
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
            {/* From 40em up there is no overflow menu to hide it in, so import is its own control —
                an icon button, beside `+` and quieter than it. */}
            <IconButton
              label={t('calendar.import.open')}
              variant="ghost"
              size="sm"
              disabled={calendars.length === 0}
              unavailableReason={online ? undefined : t('calendar.offline')}
              onClick={() => setImporting(true)}
            >
              <Import aria-hidden="true" />
            </IconButton>
          </>
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

      {/* The phone's heading line — see `phoneTitle`. It wraps rather than truncating: a week range
          is two dates long, and a heading that ends in an ellipsis answers half the question it was
          put there to answer. */}
      {phoneTitle && <h1 className={styles.pageTitle}>{heading}</h1>}

      {/*
        The month and the calendars, side by side from 40em up.

        The rail is the same shape as the address-book rail and the folder tree, because it is the
        same kind of thing: a short list of containers, one line each, that decides what the pane
        beside it shows. Below 40em it is not narrowed — it is not rendered, and the list lives in a
        sheet instead (see the view menu above). A 215px rail beside a 390px phone is two panes that
        both lose.
      */}
      <div className={styles.body}>
        {tier !== 'phone' && (
          <aside className={styles.rail} aria-label={t('calendar.calendars.title')}>
            <IncomingShares announcements={incoming.announcements} onDismiss={incoming.dismiss} />
            <CalendarList
              calendars={calendars}
              canCreate={mayCreateCalendar(connected?.jmapSession ?? null, accountId) && online}
              disabled={saving || !online}
              onToggle={(calendar, visible) => void toggleCalendar(calendar, visible)}
              onCreate={() => setEditingCalendar({ calendar: null })}
              onEdit={(calendar) => setEditingCalendar({ calendar })}
              onDelete={(calendar) => void askDelete(calendar)}
              {...(sharingClient === null || !online
                ? {}
                : { onShare: (calendar: Calendar) => setSharing(calendar) })}
            />
            {/* The availability layer's control, under the list of layers it joins — a calendar is
                "whose events are drawn", this is "whose free/busy is drawn behind them". */}
            {showAvailability && (
              <AvailabilityPicker
                people={people}
                value={availabilityOf}
                answered={busy !== null}
                pending={busyPending}
                disabled={!online}
                onChange={setAvailabilityOf}
              />
            )}
          </aside>
        )}
        <div className={styles.main}>
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
                  {...(busy === null || busyName === null ? {} : { busy, busyName })}
                />
              ) : (
                <AgendaView events={events} today={today} onOpen={openEvent} />
              )}
            </>
          )}
        </div>
      </div>

      {expandedDay !== null && (
        <DayDialog
          day={expandedDay}
          events={byDay.get(toIsoDate(expandedDay)) ?? []}
          onClose={() => setExpandedDay(null)}
          onOpen={openEvent}
        />
      )}

      {/* The phone's calendar list: the same component, in a screen-high sheet. `size="lg"` is what
          the Dialog offers that comes closest to Apple's presentation, and below 40em the panel is
          full-bleed anyway. */}
      {calendarsOpen && (
        <Dialog
          open
          onClose={() => setCalendarsOpen(false)}
          size="lg"
          title={t('calendar.calendars.title')}
        >
          <div className={styles.calendarSheet}>
            <CalendarList
              calendars={calendars}
              heading={false}
              canCreate={mayCreateCalendar(connected?.jmapSession ?? null, accountId) && online}
              disabled={saving || !online}
              onToggle={(calendar, visible) => void toggleCalendar(calendar, visible)}
              onCreate={() => {
                setCalendarsOpen(false)
                setEditingCalendar({ calendar: null })
              }}
              onEdit={(calendar) => {
                setCalendarsOpen(false)
                setEditingCalendar({ calendar })
              }}
              onDelete={(calendar) => void askDelete(calendar)}
              {...(sharingClient === null || !online
                ? {}
                : {
                    onShare: (calendar: Calendar) => {
                      setCalendarsOpen(false)
                      setSharing(calendar)
                    },
                  })}
            />
            {showAvailability && (
              <AvailabilityPicker
                people={people}
                value={availabilityOf}
                answered={busy !== null}
                pending={busyPending}
                disabled={!online}
                onChange={setAvailabilityOf}
              />
            )}
          </div>
        </Dialog>
      )}

      {sharing !== null && sharingClient !== null && (
        <Suspense fallback={null}>
          <CalendarShareDialog
            calendarId={sharing.id}
            name={sharing.name}
            // The map the last `Calendar/get` returned — `CALENDAR_PROPERTIES` names `shareWith`, so
            // it is really here and the dialog needs no fetch of its own.
            shareWith={sharing.shareWith}
            client={sharingClient}
            onClose={() => setSharing(null)}
            // Re-read, so the row's "shared" marker is the server's answer rather than this
            // screen's guess — and so the dialog, which adopts the prop, shows what really landed.
            onChanged={() => void loadCalendars()}
          />
        </Suspense>
      )}

      {editingCalendar !== null && (
        <CalendarDialog
          calendar={editingCalendar.calendar}
          busy={saving}
          onCancel={() => setEditingCalendar(null)}
          onSubmit={(draft) => void saveCalendar(draft)}
        />
      )}

      {deleting !== null && (
        <CalendarDeleteDialog
          calendar={deleting.calendar}
          eventCount={deleting.count}
          busy={saving}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {importing && (
        <Suspense fallback={null}>
          <IcsImportDialog
            client={client}
            calendars={calendars}
            onClose={() => setImporting(false)}
            onImported={() => {
              setImporting(false)
              void load()
            }}
          />
        </Suspense>
      )}

      {editing !== null &&
        (editing.placed !== null && refuseEdit(editing.placed) !== null ? (
          // Shown, never edited — one reason left, see `refuseEdit`. A SERIES is no longer one of
          // them: it opens the editor and answers the scope question after Save (K-2).
          <Dialog
            open
            onClose={() => setEditing(null)}
            size="sm"
            title={editing.placed.event.title || t('calendar.untitled')}
          >
            <p className={styles.readOnlyNote}>{t('calendar.event.unresolvedReadOnly')}</p>
            <EventFacts event={editing.placed.event} />
          </Dialog>
        ) : (
          <Suspense fallback={null}>
            <EventDialog
              event={editing.placed?.event ?? null}
              defaultDate={editing.day}
              calendars={calendars}
              busy={saving}
              isSeries={editing.placed !== null && needsScope(editing.placed)}
              ownAddresses={myAddresses}
              // `mayRSVP` is read from the calendar the event is IN, not from the account: a shared
              // calendar can grant reading and refuse answering, and a bar that always fails is
              // worse than no bar.
              mayRsvp={rsvpAllowed(calendars, editing.placed)}
              maxParticipants={maxParticipants}
              onCancel={() => setEditing(null)}
              onSubmit={(draft, scope, invite) => {
                const target = editing.placed
                void run(
                  () =>
                    target === null
                      ? client.createEvent(draft, invite)
                      : client.updateEvent(target, draft, scope, invite),
                  t('calendar.saveFailed'),
                )
              }}
              onRsvp={
                editing.placed === null
                  ? undefined
                  : (key, status) => {
                      const target = editing.placed as PlacedEvent
                      void run(() => client.rsvp(target, key, status), t('calendar.rsvpFailed'))
                    }
              }
              onDestroy={
                editing.placed === null
                  ? undefined
                  : (scope) => {
                      const target = editing.placed as PlacedEvent
                      void deleteEvent(target, scope)
                    }
              }
            />
          </Suspense>
        ))}
    </div>
  )
}

/**
 * May the reader answer an invitation on this event?
 *
 * Asked of the CALENDAR the event is in, because that is where the right lives: `myRights.mayRSVP`
 * is per calendar, and a calendar shared read-only grants everything except this. An event in a
 * calendar this list does not hold answers `false` — an unknown right is not a granted one.
 */
function rsvpAllowed(calendars: readonly Calendar[], placed: PlacedEvent | null): boolean {
  if (placed === null) return false
  const ids = Object.keys(placed.event.calendarIds ?? {})
  return calendars.some(
    (calendar) => ids.includes(calendar.id) && calendar.myRights?.mayRSVP === true,
  )
}

interface AvailabilityPickerProps {
  /** The directory, or `null` while it is still being fetched. */
  readonly people: readonly Principal[] | null
  /** The chosen principal, or `null` for nobody. */
  readonly value: Id | null
  /** Whether the server has actually answered for {@link value} — see the note in the body. */
  readonly answered: boolean
  /** Whether that answer is still on its way. Distinct from `!answered`, which is a claim. */
  readonly pending: boolean
  readonly disabled: boolean
  onChange: (principalId: Id | null) => void
}

/**
 * "Show availability: …" — the control behind the week view's hatched layer (S-6).
 *
 * **A native `<Select>`, and one line of explanation.** The alternative that was considered and
 * rejected is a participant picker inside the event editor: an availability answer is only useful
 * next to the reader's OWN commitments, and the editor has no time axis to put it on — it would
 * have needed a timeline widget of its own, fetched per keystroke, to say anything more than a
 * yes/no about an instant that may not even be chosen yet. This costs one round trip per person per
 * week, reuses the week grid's geometry entirely, and answers the question people actually have
 * before they create the meeting.
 *
 * **It needs no share of any kind**, which is the measurement that makes it worth building at all:
 * `Principal/getAvailability` is answerable about anyone in the directory, and it returns times
 * without titles. So a reader may plan around a colleague they have no access to whatsoever.
 *
 * `answered === false` with somebody chosen is the honest empty case: the request failed, or the
 * server has no such method. It says so rather than leaving an unhatched week to be read as "free".
 */
function AvailabilityPicker({
  people,
  value,
  answered,
  pending,
  disabled,
  onChange,
}: AvailabilityPickerProps) {
  const { t } = useTranslation()
  const selectId = useId()
  const empty = people !== null && people.length === 0

  return (
    <div className={styles.availability}>
      <label className={styles.availabilityLabel} htmlFor={selectId}>
        {t('calendar.availability.label')}
      </label>
      {/* A native select on every viewport: on a phone this is the platform's own picker wheel,
          which is a 44px target and a gesture people already know. */}
      <Select
        id={selectId}
        value={value ?? ''}
        disabled={disabled || people === null || empty}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">{t('calendar.availability.nobody')}</option>
        {(people ?? []).map((person) => (
          <option key={person.id} value={person.id}>
            {principalLabel(person)}
          </option>
        ))}
      </Select>
      {empty && <p className={styles.availabilityNote}>{t('calendar.availability.noPeople')}</p>}
      {value !== null && !answered && !pending && (
        <p className={styles.availabilityNote}>{t('calendar.availability.unavailable')}</p>
      )}
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
