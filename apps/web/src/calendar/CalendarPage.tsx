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
 * same view menu that already carries Today. Ticking one off re-fetches the month naming only the
 * calendars that are on — `eventsInRange`'s third parameter, which had existed since M5.6 with no
 * caller. So the two loads are no longer independent: the calendars are fetched first and the
 * events depend on their answer, which costs one extra round trip on the first paint and none
 * afterwards. The alternative, filtering the drawn list locally, looks the same on this screen and
 * is a lie on the phone.
 *
 * **ONE grid for EVERY account (#79), which is the largest change this screen has had.** Until now
 * it drew one account at a time and `?account=` switched between them, so a team member could see
 * their own week or the group's week and never both — which is the one question a shared calendar
 * exists to answer ("am I free when the group is busy?"). The screen now reads the reader's own
 * account plus every delegated account whose `calendar` area the server serves, merges the months in
 * `useCalendarEvents`, and draws them in a single grid with a colour and a tick per calendar. Three
 * consequences run through the whole file, and each of them was a defect waiting to happen:
 *
 *  - **One client per ACCOUNT, never one client.** JMAP ids are per-account and short (ADR-018):
 *    two accounts meet on `c1` and on `e17` routinely. Every write therefore looks up the client of
 *    the account the object came from — `placed.accountId` for an event, the row's account for a
 *    calendar — and a single "acting" client would have sent half of them to the wrong server-side
 *    account, where they would either fail or, worse, hit somebody else's object of the same id.
 *  - **Ticking is LOCAL.** `isVisible` is a property of the calendar object, so hiding used to be a
 *    write — impossible on a calendar shared read-only, which is exactly what this screen now shows.
 *    The decision lives in the replica's local prefs (`setCalendarShown`), with the server's
 *    `isVisible` as its starting value.
 *  - **`?account=` no longer narrows anything.** It marks the named account's section in the rail
 *    and switches its calendars back ON, so the share card's Open still leads somewhere true — it
 *    reveals the shared calendar inside the merged grid instead of hiding every other one.
 */

import type { Calendar, Id, Principal } from '@waxwing/jmap'
import type { TFunction } from 'i18next'
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Import,
  Plus,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react'
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ACCOUNT_PARAM, calendarPath, useNavigate, useRoute } from '../app/route'
import { delegatedAccountsFor } from '../app/session/accounts'
import { useSessionOptional } from '../app/session/context'
import type { DelegatedAccount } from '../app/session/types'
import { useLayoutTier } from '../app/shell/layout'
import { ScreenBar } from '../app/shell/ScreenBar'
import shellStyles from '../app/shell/shell.module.css'
import { useOnline } from '../app/use-online'
import { formatDate, formatRelativeTime } from '../i18n/formatters'
import type { CalendarSharingClient } from '../sharing/calendar-share-client'
import { makeCalendarSharingClient } from '../sharing/calendar-share-client'
import { IncomingShares } from '../sharing/IncomingShares'
import type { ShareAnnouncement } from '../sharing/incoming'
import { currentUserPrincipalId, principalLabel } from '../sharing/principals'
import { useIncomingShares } from '../sharing/use-incoming-shares'
import {
  setCalendarShown,
  useCalendarShownFor,
  useCalendarsForAccounts,
  useReplicaOptional,
} from '../sync'
import { RECONNECT_DEBOUNCE_MS } from '../sync/engine'
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
import { calendarColor } from './calendar-colour'
import type { CalendarChoice } from './EventDialog'
import { chipColor, rowColor } from './event-color'
import { DEFAULT_MAX_PARTICIPANTS, ownAddresses } from './event-participants'
import type { EditScope } from './event-recurrence'
import { type CalendarSource, useCalendarEvents } from './use-calendar-events'

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
import {
  CalendarList,
  isCalendarShown,
  mayWriteEvents,
  NO_OVERRIDES,
  visibleCalendarIds,
} from './CalendarList'
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

/** No local show/hide decisions — a module constant, so it is not a fresh object per render. */
const NO_SHOWN: ReadonlyMap<Id, Record<Id, boolean>> = new Map()

export interface CalendarPageProps {
  /**
   * Injected in tests: the client for the reader's OWN account. Defaults to one built from the live
   * session.
   */
  readonly client?: CalendarClient
  /**
   * Injected in tests: a client per account (#79), for the paths where WHICH account a write went
   * to is the assertion. Takes precedence over {@link client} for the accounts it names; every other
   * account still falls back to the session.
   */
  readonly clients?: ReadonlyMap<Id, CalendarClient>
  /** Injected in tests so the grid is deterministic. */
  readonly today?: Date
}

export default function CalendarPage(props: CalendarPageProps): ReactNode {
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
   * The screen READS from the replica since K-8 (`use-calendar-events.ts`), so a month already
   * synced is drawn offline. Every control that WRITES — a new event, an RSVP, a calendar's colour
   * — still needs a line, and this is what greys those out with a reason. Without it the new-event
   * button stayed enabled offline, the write failed, and the reader was told the calendar could not
   * be LOADED. Settings has gated its writes this way since M3.5; Calendar and Files were the two
   * screens that never did.
   */
  const online = useOnline()
  /**
   * The network's calendar answers, KEYED by the account each one answers about (#79).
   *
   * A map rather than a list plus a tag, and the difference is not cosmetic: the screen now draws
   * several accounts at once, so "the list" was never one list. Keying by account also answers the
   * question the old tag was invented for — a mid-flight answer landing after the account set
   * changed writes into its own slot and is simply never read again if that account has gone.
   *
   * An entry that IS an empty array means "asked, and this account has none"; a missing entry means
   * "not asked, or the request failed", which is where the replica's copy takes over.
   */
  const [networkCalendars, setNetworkCalendars] = useState<ReadonlyMap<Id, Calendar[]>>(
    () => new Map(),
  )
  /** `{ placed }` edits, `{ placed: null }` creates on `day`. */
  const [editing, setEditing] = useState<{ placed: PlacedEvent | null; day: Date } | null>(null)
  /** The day whose full event list is open (T8) — `null` when none is. */
  const [expandedDay, setExpandedDay] = useState<Date | null>(null)
  const [saving, setSaving] = useState(false)
  /**
   * The event list no longer needs a stamp, and that is K-8's doing rather than a simplification.
   *
   * It used to hold "the last answer, stamped with the window it answers about", because the answer
   * arrived asynchronously into component state and the fetch for a new month could land after the
   * reader had paged again (T5). The list now comes from the replica keyed BY that window, so a
   * month can only ever render its own rows: the staleness question the stamp answered cannot be
   * asked any more.
   */
  const [failed, setFailed] = useState(false)
  /**
   * `{ calendar }` edits, `{ calendar: null }` creates — and `accountId` says WHOSE (#79).
   *
   * The account rides along with every one of these because the save has to pick a client by it: a
   * calendar id alone is `c1`, which two accounts both have (ADR-018).
   */
  const [editingCalendar, setEditingCalendar] = useState<{
    accountId: Id
    calendar: Calendar | null
  } | null>(null)
  /** The calendar the reader asked to delete, and how many events go with it (`null` = counting). */
  const [deleting, setDeleting] = useState<{
    accountId: Id
    calendar: Calendar
    count: number | null
  } | null>(null)
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
   * Open still leads somewhere true, and since #79 somewhere BETTER: the shared account's calendars
   * are already in this grid, so `?account=` no longer swaps the screen over to them — it points at
   * the account, switches its calendars back on and marks its section in the
   * rail. The account is the announcement's `objectAccountId`, which the session lists by name.
   */
  const incoming = useIncomingShares('Calendar')
  /** The `.ics` import sheet (K-4). */
  const [importing, setImporting] = useState(false)
  /** The calendar whose share dialog is open (S-2), or `null`. */
  /**
   * WHICH calendar the share dialog is for — an id, never the object.
   *
   * It used to hold the `Calendar` itself, and that snapshot was a defect rather than a shortcut:
   * `onChanged` re-reads the list, but a snapshot taken when the row was clicked is not part of that
   * list and never hears about it. So a grant that landed while the dialog was open — or between the
   * click and the re-read arriving — left the dialog rendering `shareWith: {}` for ever, under the
   * heading "Who has access": **"Only you."**, for a calendar the server had already shared.
   *
   * Reproduced against the live fixture, and the transcript is unambiguous: `Calendar/set` writes
   * the grant, both following `Calendar/get`s return it, the RAIL redraws with its "Shared" marker —
   * and the dialog beside it still says "Only you." A reader would conclude the grant was lost, and
   * grant it again.
   *
   * Deriving from the calendar list by id means the dialog is a VIEW of the list rather than a copy
   * of one of its rows, so every refresh reaches it. That is what the note on `onChanged` below
   * always claimed was happening. The ACCOUNT rides along for the usual reason (#79): `c1` alone
   * names two calendars once there are two accounts.
   */
  const [sharingId, setSharingId] = useState<{ accountId: Id; calendarId: Id } | null>(null)
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
  const injectedClients = props.clients
  const sessionClient = connected?.client ?? null
  const replica = useReplicaOptional()

  /**
   * The reader's OWN account.
   *
   * The session first, the replica's scope second. The fallback is not decoration: a screen with a
   * replica and no session is what every unit test of this file is, and before #79 the account it
   * read came implicitly from the replica context anyway. Making that explicit is what lets the
   * rest of the file speak in account ids instead of relying on whichever provider it sits under.
   */
  const ownAccountId = connected?.accountId ?? replica?.accountId ?? null
  /*
   * Every delegated account whose `calendar` area the server serves — a group the user belongs to
   * has no incoming share card, so before #79 the rail's account row was its only standing door.
   * Now its calendars are simply IN the rail, under the account's own name.
   */
  const calendarAccounts = useMemo(
    () => (connected === null ? [] : delegatedAccountsFor(connected, 'calendar')),
    [connected],
  )
  /**
   * Every account this screen draws, the reader's own FIRST (#79).
   *
   * The order is load-bearing in two places: the rail puts the own account's calendars above the
   * sections, and the editor defaults a new event to the first writable calendar it is offered — so
   * "first" has to mean "mine", or a stray click lands a private appointment on a group's calendar.
   */
  const accountIds = useMemo(
    () => (ownAccountId === null ? [] : [ownAccountId, ...calendarAccounts.map((a) => a.id)]),
    [ownAccountId, calendarAccounts],
  )
  /** `accountId → the name to show beside a calendar`; `null` for the own account (unmarked). */
  const accountNames = useMemo<ReadonlyMap<Id, string | null>>(() => {
    const names = new Map<Id, string | null>()
    if (ownAccountId !== null) names.set(ownAccountId, null)
    for (const account of calendarAccounts) names.set(account.id, account.name)
    return names
  }, [ownAccountId, calendarAccounts])

  /**
   * ONE CLIENT PER ACCOUNT — the heart of #79, and of ADR-018 (see the file header).
   *
   * Every write on this screen looks its client up in here by the account of the OBJECT it is
   * writing, never by "the account the screen is in", because there is no longer such a thing. A
   * single client would send a delete of the group's `e17` to the reader's own account, where `e17`
   * is somebody else's lunch.
   */
  const clients = useMemo<ReadonlyMap<Id, CalendarClient>>(() => {
    const built = new Map<Id, CalendarClient>()
    for (const id of accountIds) {
      const fromProps = injectedClients?.get(id) ?? (id === ownAccountId ? injected : undefined)
      if (fromProps !== undefined) {
        built.set(id, fromProps)
        continue
      }
      if (sessionClient !== null) built.set(id, makeCalendarClient(sessionClient, id))
    }
    return built
  }, [accountIds, injected, injectedClients, ownAccountId, sessionClient])

  /** The client for one account, or `null` when the screen has none — never a fallback to another. */
  const clientFor = useCallback(
    (accountId: Id | null): CalendarClient | null =>
      accountId === null ? null : (clients.get(accountId) ?? null),
    [clients],
  )
  /** The own account's client: what the availability picker, the importer and the identities use. */
  const ownClient = clientFor(ownAccountId)

  /** The share card's Open — see the note on `incoming` above. */
  const openSharedCalendar = useCallback(
    (announcement: ShareAnnouncement): void => {
      if (announcement.accountId === ownAccountId) {
        navigate(calendarPath())
        return
      }
      navigate(calendarPath(undefined, announcement.accountId))
    },
    [navigate, ownAccountId],
  )

  /**
   * The server's own ceiling on participants, from the account capability (measured `20`).
   *
   * Read rather than assumed so the editor refuses the 21st attendee here, with a sentence, instead
   * of letting the whole save come back `tooManyParticipants` after the reader has finished typing.
   * Read for the account the EVENT is in (#79) — a group account may publish a different ceiling,
   * and the reader is told the one that will actually refuse them.
   */
  const maxParticipantsFor = useCallback(
    (accountId: Id | null): number => {
      const capability =
        accountId === null
          ? undefined
          : (connected?.jmapSession?.accounts?.[accountId]?.accountCapabilities?.[
              'urn:ietf:params:jmap:calendars'
            ] as { maxParticipantsPerEvent?: number | null } | undefined)
      return capability?.maxParticipantsPerEvent ?? DEFAULT_MAX_PARTICIPANTS
    },
    [connected],
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
   * The calendar lists of every account, read the way the folder tree is: from the replica (#79).
   *
   * The network read below still runs and still wins — it is how a calendar created on this device
   * appears before the next sweep. What changed is what happens when it does not answer: the
   * replica's copy is drawn instead of an empty rail, which is the difference between a calendar
   * that shows the events it already holds under their own names and one that shows nothing at all
   * because it does not know which calendars to ask for.
   */
  const replicaCalendars = useCalendarsForAccounts(accountIds)

  /**
   * What the rail draws and what the month filter names, PER ACCOUNT — the network's answer where
   * there is one, the replica's otherwise. An account missing from this map has not answered at
   * all; an account mapping to `[]` has answered "I have none", and the two must not be conflated
   * (see `sources` below).
   */
  const calendarsByAccount = useMemo<ReadonlyMap<Id, Calendar[]>>(() => {
    const merged = new Map<Id, Calendar[]>()
    for (const id of accountIds) {
      const fromNetwork = networkCalendars.get(id)
      if (fromNetwork !== undefined) {
        merged.set(id, fromNetwork)
        continue
      }
      const fromReplica = replicaCalendars?.get(id)
      if (fromReplica !== undefined) merged.set(id, fromReplica)
    }
    return merged
  }, [accountIds, networkCalendars, replicaCalendars])

  /**
   * The reader's own show/hide decisions, per account (#79).
   *
   * `undefined` means "not read yet" and the grid WAITS for it. Drawing before it lands would flash
   * every event of a calendar the reader has switched off and then take them away again — the same
   * lie the old `isVisible` filter was built to avoid, one layer down. With no replica at all there
   * are no decisions and none can be taken, so an empty map is the complete answer rather than a
   * pending one.
   */
  const storedShown = useCalendarShownFor(accountIds)
  /*
   * The ticks the reader has just clicked, before the replica has answered (#79).
   *
   * The stored decision is the truth, and it arrives about 50 ms after the click — measured against
   * the fixture: `checked` is still the OLD value at t=0 and correct at t=50 ms. Without this the
   * tick does not respond to the click at all, it responds to the database; on a slow device or a
   * large replica that gap is long enough to look broken, and the reader clicks again. (It also
   * fails Playwright's `uncheck()`, which is how it was found — the check verifies the state
   * immediately after clicking, and that is exactly what a person does too.)
   *
   * Cleared per calendar as soon as the stored answer AGREES, so this never becomes a second source
   * of truth: a write that fails leaves the stored value unchanged, the entry is dropped, and the
   * tick goes back to what the replica says.
   */
  const [pendingShown, setPendingShown] = useState<ReadonlyMap<string, boolean>>(new Map())
  const shownByAccount = useMemo(() => {
    const stored = replica === null ? NO_SHOWN : storedShown
    if (stored === undefined || pendingShown.size === 0) return stored
    const merged = new Map(stored)
    for (const [key, shown] of pendingShown) {
      const [accountId, calendarId] = key.split('\u0000')
      if (accountId === undefined || calendarId === undefined) continue
      merged.set(accountId, { ...(merged.get(accountId) ?? {}), [calendarId]: shown })
    }
    return merged
  }, [replica, storedShown, pendingShown])

  // Drop each optimistic tick the moment the replica reports the same value.
  useEffect(() => {
    if (storedShown === undefined || pendingShown.size === 0) return
    const settled = [...pendingShown].filter(([key, shown]) => {
      const [accountId, calendarId] = key.split('\u0000')
      if (accountId === undefined || calendarId === undefined) return true
      return storedShown.get(accountId)?.[calendarId] === shown
    })
    if (settled.length === 0) return
    setPendingShown((current) => {
      const next = new Map(current)
      for (const [key] of settled) next.delete(key)
      return next
    })
  }, [storedShown, pendingShown])

  /** The own account's calendars — the create button and the rail's unlabelled first section. */
  const ownCalendars = ownAccountId === null ? [] : (calendarsByAccount.get(ownAccountId) ?? [])

  /**
   * Where a `.ics` may be imported to — the OWN account's writable calendars, and only those.
   *
   * Deliberately narrower than the editor's picker (#79). `CalendarEvent/parse` + the bulk create
   * are one client's work, importing a hundred events into a group's calendar is not a thing anyone
   * has asked for, and an importer that could aim anywhere would need a second account column in a
   * dialog whose whole point is one file, one calendar, one press. If it is ever wanted it is a
   * `CalendarChoice[]` away — the shape is already here.
   */
  const importableCalendars = ownCalendars.filter(mayWriteEvents)

  /**
   * One source per account: which calendars of it the merged month should ask for.
   *
   * `null` for an account whose list has not arrived, which `useCalendarEvents` reads as "watch
   * nothing yet" — an EMPTY list is the different and equally real answer "every calendar of this
   * account is switched off", and a filter naming no calendar at all would ask for everything.
   */
  const sources = useMemo<CalendarSource[]>(
    () =>
      accountIds.map((id) => {
        const list = calendarsByAccount.get(id)
        return {
          accountId: id,
          calendarIds:
            list === undefined || shownByAccount === undefined
              ? null
              : visibleCalendarIds(list, shownByAccount.get(id) ?? NO_OVERRIDES),
        }
      }),
    [accountIds, calendarsByAccount, shownByAccount],
  )

  /** The month, from the replica (K-8), merged across accounts (#79). This never fetches. */
  const { events, syncedAt, neverSynced, refresh } = useCalendarEvents(sources, fromMs, toMs)

  /**
   * The colour an event's chip wears — its CALENDAR's, resolved through its own account (#79).
   *
   * Both halves of the lookup are needed and neither is enough: `calendarIds` is a set of ids that
   * only mean anything inside one account (ADR-018), and `placed.accountId` is the account they
   * mean it in. Looking the id up across the merged list would tint a group's event with the
   * reader's own calendar of the same id — a wrong answer that looks exactly like a right one.
   *
   * `null` for a calendar this screen cannot resolve, and for one the server gave no colour: the
   * chip then keeps its neutral surface. Inventing a colour for the second case would put a hue on
   * the chip that the rail's own tick box does not have, so the legend would not match the grid.
   */
  const colorFor = useCallback(
    (placed: PlacedEvent): string | null => {
      const list = calendarsByAccount.get(placed.accountId)
      if (list === undefined) return null
      const ids = Object.keys(placed.event.calendarIds ?? {})
      for (const calendar of list) {
        // A calendar with no colour of its own still gets one — see `calendar-colour.ts`. Without
        // that, the merged grid drew every account in the same neutral chip, which is the one thing
        // it exists not to do.
        if (ids.includes(calendar.id)) return calendarColor(placed.accountId, calendar)
      }
      return null
    },
    [calendarsByAccount],
  )

  /**
   * What the editor's calendar picker offers (#79).
   *
   * Creating: every calendar of every account, own account first, each marked with the account it
   * belongs to and with whether it may be written to. Editing: the calendars of the event's OWN
   * account only — see `EventDialogProps.calendars` on why moving an event between accounts is not
   * something a `<select>` may promise.
   */
  const editorChoices = useMemo<CalendarChoice[]>(() => {
    const editedIn = editing?.placed?.accountId ?? null
    const offered = editedIn === null ? accountIds : [editedIn]
    return offered.flatMap((id) =>
      (calendarsByAccount.get(id) ?? []).map((calendar) => ({
        accountId: id,
        calendar,
        accountName: accountNames.get(id) ?? null,
        writable: mayWriteEvents(calendar),
      })),
    )
  }, [editing, accountIds, calendarsByAccount, accountNames])

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
   * One per account for the same reason the calendar clients are (#79): `Calendar/set` names an
   * `accountId`, and the "self" principal excluded from the picker is that account's, not the
   * reader's own. Empty when there is no session, which is what removes the affordance from every
   * row rather than letting one open a dialog that cannot save.
   */
  const sharingClients = useMemo(() => {
    const built = new Map<Id, ReturnType<typeof makeCalendarSharingClient>>()
    if (sessionClient === null) return built
    for (const id of accountIds) {
      built.set(
        id,
        makeCalendarSharingClient(
          sessionClient,
          id,
          currentUserPrincipalId(connected?.jmapSession ?? null, id),
        ),
      )
    }
    return built
  }, [sessionClient, accountIds, connected])

  /**
   * Ask every account for its calendars.
   *
   * One request per account rather than one for "the" account (#79): they are separate JMAP calls
   * on separate `accountId`s and there is no way to batch them into one answer this screen could
   * read. A refusal is per account too — one group whose `Calendar/get` fails must not blank the
   * reader's own rail, so a failed account simply keeps whatever it had (usually the replica's
   * copy) and the "could not refresh" line is raised once for the lot.
   */
  const loadCalendars = useCallback(async () => {
    if (clients.size === 0) return
    const answers = await Promise.all(
      [...clients].map(async ([id, calendarClient]) => {
        try {
          return [id, await calendarClient.listCalendars()] as const
        } catch {
          return [id, null] as const
        }
      }),
    )
    setNetworkCalendars((current) => {
      const next = new Map(current)
      for (const [id, list] of answers) {
        if (list !== null) next.set(id, list)
      }
      // An account the session no longer serves loses its list here, so a stale rail section cannot
      // outlive the grant that produced it.
      for (const id of [...next.keys()]) {
        if (!clients.has(id)) next.delete(id)
      }
      return next
    })
    setFailed(answers.some(([, list]) => list === null))
  }, [clients])

  useEffect(() => {
    void loadCalendars()
  }, [loadCalendars])

  /*
   * And again when the line comes back (N-05).
   *
   * The list is the one thing on this screen that does NOT come from the replica: the month is
   * watched by the engine, which re-syncs itself on `online`, but `listCalendars()` is a direct
   * call that ran once. So a reader who opened the calendar offline and then reconnected sat in
   * front of an empty rail — with a colour legend for nothing and every write greyed out — until
   * they noticed the "Try again" bar. The bar stays for the failure that is not a connection; it
   * should not be how a reconnection is handled.
   *
   * On the SAME {@link RECONNECT_DEBOUNCE_MS} the engine uses, and imported rather than repeated:
   * a flapping line fires `online` in bursts, and the two paths have to settle together, or the
   * rail refetches ahead of the month it is the legend for.
   *
   * It fires on the TRANSITION and not on `online === true`, which is why the previous value is
   * kept: on a screen that opens connected — the ordinary case — this must add no second request
   * to the one the effect above already sent.
   */
  const wasOnline = useRef(online)
  useEffect(() => {
    const reconnected = online && !wasOnline.current
    wasOnline.current = online
    if (!reconnected) return
    const timer = window.setTimeout(() => void loadCalendars(), RECONNECT_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [online, loadCalendars])

  /** The share dialog's subject, read from the LIVE list of its own account — see {@link sharingId}. */
  const sharing =
    sharingId === null
      ? null
      : ((networkCalendars
          .get(sharingId.accountId)
          ?.find((calendar) => calendar.id === sharingId.calendarId) ?? null) as Calendar | null)

  /*
   * The reader's calendar addresses (K-10), from EVERY account (#79).
   *
   * Per account rather than own-only because "which of these participants is me" has a different
   * answer inside a group's calendar: the invitation there is addressed to the group, and an RSVP
   * bar that only knows the reader's personal address would never appear on the one kind of event
   * people actually get invited to. The addresses are unioned — they are only ever compared
   * against, never written back.
   */
  useEffect(() => {
    if (clients.size === 0) return
    let live = true
    void Promise.all(
      [...clients.values()].map(async (calendarClient) => {
        try {
          return ownAddresses(await calendarClient.listParticipantIdentities())
        } catch {
          // Swallowed: see `myAddresses`. Nothing here depends on it except one optional bar.
          return []
        }
      }),
    ).then((lists) => {
      if (live) setMyAddresses([...new Set(lists.flat())])
    })
    return () => {
      live = false
    }
  }, [clients])

  /**
   * Try everything the screen needs again — the calendar list AND the month.
   *
   * Both, because they fail together and independently: the rail is a `Calendar/get` and the grid a
   * pair of `CalendarEvent` calls, and a "Try again" that re-read only one of them would leave the
   * other's failure on screen with no way to clear it.
   */
  const retry = useCallback(async () => {
    await loadCalendars()
    await refresh()
  }, [loadCalendars, refresh])

  /**
   * What `?account=` still means, now that it cannot narrow the screen (#79).
   *
   * Before the merged grid it scoped the whole screen; the share card's Open used it, and so do any
   * links a reader has bookmarked. Making it inert would have left that button doing visibly
   * nothing — the worst of the three options — so it kept the job it was built for and lost the
   * mechanism: it POINTS at an account rather than switching to one. The section is marked with
   * `aria-current`, and the effect below switches that account's calendars back on, so
   * "Open" reliably ends with the shared calendar's events on the grid.
   *
   * B37's vetting is unchanged: only an account the server actually serves may be named, and
   * anything else is ignored rather than trusted.
   */
  const requestedAccount = route.search.get(ACCOUNT_PARAM)
  const highlightedAccount =
    requestedAccount !== null && calendarAccounts.some((account) => account.id === requestedAccount)
      ? requestedAccount
      : null

  /*
   * Switching the named account's calendars back on, ONCE per navigation.
   *
   * The ref is what makes it a reaction to the click rather than a standing policy: without it the
   * effect would re-tick every calendar of that account each time the list re-rendered, and a reader
   * who unticked one while the parameter was still in the URL could never keep it unticked. It also
   * waits for the list AND the stored decisions, because "switch on what is off" cannot be answered
   * before either has arrived.
   */
  const revealed = useRef<Id | null>(null)
  useEffect(() => {
    if (replica === null || highlightedAccount === null) return
    if (revealed.current === highlightedAccount) return
    const list = calendarsByAccount.get(highlightedAccount)
    if (list === undefined || shownByAccount === undefined) return
    const local = shownByAccount.get(highlightedAccount) ?? NO_OVERRIDES
    revealed.current = highlightedAccount
    const hidden = list.filter((calendar) => !isCalendarShown(calendar, local))
    if (hidden.length === 0) return
    void (async () => {
      // Sequentially rather than `Promise.all`: every one of these is a read-modify-write of the
      // SAME prefs row, so concurrent ones would drop each other's calendars.
      for (const calendar of hidden) {
        await setCalendarShown(replica.db, highlightedAccount, calendar.id, true)
      }
      // Swallowed for the same reason every other pref write here is: a decision that could not be
      // stored costs this reader one tick, never the screen.
    })().catch(() => undefined)
  }, [replica, highlightedAccount, calendarsByAccount, shownByAccount])

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
    if (ownClient === null || !showAvailability || people !== null) return
    let live = true
    void ownClient
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
  }, [ownClient, showAvailability, people])

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
    if (ownClient === null || availabilityOf === null || !showAvailability) {
      setBusy(null)
      setBusyPending(false)
      return
    }
    let live = true
    setBusyPending(true)
    void ownClient
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
  }, [ownClient, availabilityOf, showAvailability, weekFromMs, weekToMs])

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
      await refresh()
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
    /*
     * The client of the event's OWN account (#79), narrowed here rather than relying on the early
     * return below, which comes later in the body.
     *
     * `target.accountId` and not "the current account": in a merged grid the chip under the pointer
     * may belong to any of them, and `e17` exists in all of them. A destroy aimed at the wrong
     * account either fails — the lucky case — or deletes a different event with the same short id.
     */
    const writer = clientFor(target.accountId)
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
   * Ticking a calendar on or off — a LOCAL decision since #79, not a `Calendar/set`.
   *
   * It used to write `isVisible` to the server, which was defensible while every calendar on screen
   * belonged to the reader and is not defensible at all now that half of them may be somebody
   * else's: `mayWriteAll` is false on a read-only share, so the tick box on those rows opened a
   * request that came back refused, put the tick back, and raised a toast. The reader could not
   * hide a calendar they had merely been shown.
   *
   * So the decision is stored in the replica's local prefs, per account and per calendar, with the
   * server's `isVisible` as its starting value (see `repo.ts`). No optimistic patch is needed any
   * more either: the live query is the state, so the tick moves as soon as the write lands and
   * there is no round trip to hide.
   */
  const toggleCalendar = async (
    accountId: Id,
    calendar: Calendar,
    shown: boolean,
  ): Promise<void> => {
    if (replica === null) return
    const pendingKey = `${accountId}\u0000${calendar.id}`
    setPendingShown((current) => new Map(current).set(pendingKey, shown))
    try {
      await setCalendarShown(replica.db, accountId, calendar.id, shown)
    } catch (error) {
      // The stored value never changed, so drop the optimistic one rather than leaving the tick
      // showing a decision the replica does not hold.
      setPendingShown((current) => {
        const next = new Map(current)
        next.delete(pendingKey)
        return next
      })
      toast({
        tone: 'danger',
        title: t('calendar.calendars.toggleFailed'),
        ...(refusalReason(error) === null ? {} : { description: refusalReason(error) }),
      })
    }
  }

  const saveCalendar = async (draft: CalendarDraft): Promise<void> => {
    if (editingCalendar === null) return
    // The account the ROW came from (#79) — creating goes to whichever account's section the
    // create button sits in, editing to the account the calendar is in.
    const writer = clientFor(editingCalendar.accountId)
    if (writer === null) return
    const target = editingCalendar.calendar
    setSaving(true)
    try {
      if (target === null) await writer.createCalendar(draft)
      else await writer.updateCalendar(target.id, draft)
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
  const askDelete = async (accountId: Id, calendar: Calendar): Promise<void> => {
    const reader = clientFor(accountId)
    if (reader === null) return
    setCalendarsOpen(false)
    setDeleting({ accountId, calendar, count: null })
    try {
      const count = await reader.countEvents(calendar.id)
      setDeleting((current) =>
        // Both halves of the identity (#79): the same calendar id in another account is a different
        // dialog, and answering it with this count would name the wrong number of events.
        current?.calendar.id === calendar.id && current.accountId === accountId
          ? { accountId, calendar, count }
          : current,
      )
    } catch {
      // A count we could not take must not become a zero. Nothing changes; the dialog keeps saying
      // it is counting and Delete stays unavailable, which is the honest end of this path.
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (deleting === null) return
    const writer = clientFor(deleting.accountId)
    if (writer === null) return
    setSaving(true)
    try {
      await writer.destroyCalendar(deleting.calendar.id)
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

  /*
   * No own account, or no client for it: there is nothing this screen can read or write. The
   * DELEGATED accounts are deliberately not enough — without a session there is no way to have been
   * granted one, and a screen showing somebody else's calendars and none of the reader's would be a
   * stranger state than an empty one.
   */
  if (ownAccountId === null || ownClient === null) {
    return (
      <div className={styles.page}>
        <EmptyState icon={CalendarDays} title={t('calendar.signedOut')} />
      </div>
    )
  }

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
              ...(online && importableCalendars.length > 0
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
                an icon button, beside `+` and quieter than it.

                Its own offline sentence, not the `+` button's. `calendar.offline` says "Events can
                only be CREATED while connected", which is the wrong explanation for a control that
                imports a file — and while the list came from the network, the reason was hidden
                behind `disabled` (`Button` suppresses `unavailableReason` when a control is hard
                disabled), so nobody saw it. Now that the replica answers the list, this control is
                reachable offline and says what is actually true of it. */}
            <IconButton
              label={t('calendar.import.open')}
              variant="ghost"
              size="sm"
              disabled={importableCalendars.length === 0}
              unavailableReason={online ? undefined : t('calendar.import.offline')}
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
            <CalendarSections
              ownAccountId={ownAccountId}
              accounts={calendarAccounts}
              calendarsByAccount={calendarsByAccount}
              shownByAccount={shownByAccount}
              highlightedAccount={highlightedAccount}
              heading
              canCreateOwn={
                mayCreateCalendar(connected?.jmapSession ?? null, ownAccountId) && online
              }
              disabled={saving}
              onToggle={(id, calendar, shown) => void toggleCalendar(id, calendar, shown)}
              onCreate={() => setEditingCalendar({ accountId: ownAccountId, calendar: null })}
              onEdit={(id, calendar) => setEditingCalendar({ accountId: id, calendar })}
              onDelete={(id, calendar) => void askDelete(id, calendar)}
              {...(!online
                ? {}
                : {
                    onShare: (id: Id, calendar: Calendar) =>
                      setSharingId({ accountId: id, calendarId: calendar.id }),
                  })}
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
            {/* LAST in the rail (B61): a share card arrives on a sync pass, and above the calendar
                list it moved every row out from under the pointer mid-click. Below it, nothing is
                pushed. */}
            <IncomingShares
              announcements={incoming.announcements}
              onDismiss={incoming.dismiss}
              onOpen={openSharedCalendar}
            />
          </aside>
        )}
        <div className={styles.main}>
          {/*
            Exactly ONE of: the "nothing here yet" pane, the spinner, the view.

            The order is what K-8 changed. It used to be failure-first, so ONE refused request turned
            a month the device already held into "The calendar could not be loaded" — the reader was
            shown an error instead of their own data. Now a window that has ever synced is DRAWN,
            whatever the network is doing, and the fact that it is not updating right now is said in
            one line above it. The full-pane state is reserved for the case where there is genuinely
            nothing to draw: a month this device has never synced.

            The failure line still exists, and it is still one line: a stale grid with a note is a far
            better answer than a red pane over data (T5).
          */}
          {events !== undefined && neverSynced && events.length === 0 ? (
            <EmptyState
              tone={online ? 'error' : 'empty'}
              icon={online ? TriangleAlert : CloudOff}
              title={online ? t('calendar.loadFailed') : t('calendar.offlineNever.title')}
              {...(online
                ? {
                    action: (
                      <Button variant="secondary" onClick={() => void retry()}>
                        {t('calendar.retry')}
                      </Button>
                    ),
                  }
                : { description: t('calendar.offlineNever.body') })}
            />
          ) : (
            <>
              {/*
                Apple's answer to "the data on screen is not live": say so quietly, beside the data,
                and never take the data away. `role="status"` rather than `alert` — nothing is wrong,
                and a screen reader should hear it after whatever the reader was doing, not instead.
              */}
              {!online && events !== undefined && (
                <div className={styles.loadError} role="status">
                  <CloudOff aria-hidden="true" />
                  <span className={styles.loadErrorText}>
                    {syncedAt > 0
                      ? t('calendar.offlineStale', { when: formatRelativeTime(syncedAt) })
                      : t('calendar.offlineNotUpdating')}
                  </span>
                </div>
              )}
              {online && failed && (
                <div className={styles.loadError} role="alert">
                  <TriangleAlert aria-hidden="true" />
                  <span className={styles.loadErrorText}>{t('calendar.refreshFailed')}</span>
                  <Button variant="secondary" size="sm" onClick={() => void retry()}>
                    {t('calendar.retry')}
                  </Button>
                </div>
              )}
              {events === undefined ? (
                <div className={styles.loading}>
                  <Spinner label={t('ui.spinner.label')} />
                </div>
              ) : view === 'month' ? (
                <MonthView
                  days={days}
                  byDay={byDay}
                  locale={locale}
                  focus={focus}
                  colorFor={colorFor}
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
                  colorFor={colorFor}
                  onOpen={openEvent}
                  onPick={goto}
                  {...(busy === null || busyName === null ? {} : { busy, busyName })}
                />
              ) : (
                <AgendaView events={events} today={today} colorFor={colorFor} onOpen={openEvent} />
              )}
            </>
          )}
        </div>
      </div>

      {expandedDay !== null && (
        <DayDialog
          day={expandedDay}
          events={byDay.get(toIsoDate(expandedDay)) ?? []}
          colorFor={colorFor}
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
            <CalendarSections
              ownAccountId={ownAccountId}
              accounts={calendarAccounts}
              calendarsByAccount={calendarsByAccount}
              shownByAccount={shownByAccount}
              highlightedAccount={highlightedAccount}
              heading={false}
              canCreateOwn={
                mayCreateCalendar(connected?.jmapSession ?? null, ownAccountId) && online
              }
              disabled={saving}
              onToggle={(id, calendar, shown) => void toggleCalendar(id, calendar, shown)}
              onCreate={() => {
                setCalendarsOpen(false)
                setEditingCalendar({ accountId: ownAccountId, calendar: null })
              }}
              onEdit={(id, calendar) => {
                setCalendarsOpen(false)
                setEditingCalendar({ accountId: id, calendar })
              }}
              onDelete={(id, calendar) => void askDelete(id, calendar)}
              {...(!online
                ? {}
                : {
                    onShare: (id: Id, calendar: Calendar) => {
                      setCalendarsOpen(false)
                      setSharingId({ accountId: id, calendarId: calendar.id })
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

      {sharing !== null &&
        sharingId !== null &&
        sharingClients.get(sharingId.accountId) !== undefined && (
          <Suspense fallback={null}>
            <CalendarShareDialog
              calendarId={sharing.id}
              name={sharing.name}
              // The map the last `Calendar/get` returned — `CALENDAR_PROPERTIES` names `shareWith`, so
              // it is really here and the dialog needs no fetch of its own.
              shareWith={sharing.shareWith}
              // The sharing client of the calendar's OWN account (#79): `Calendar/set … shareWith`
              // names an account, and granting on the wrong one is the ADR-018 collision again.
              client={sharingClients.get(sharingId.accountId) as CalendarSharingClient}
              onClose={() => setSharingId(null)}
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
            client={ownClient}
            calendars={importableCalendars}
            onClose={() => setImporting(false)}
            onImported={() => {
              setImporting(false)
              void refresh()
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
              calendars={editorChoices}
              busy={saving}
              isSeries={editing.placed !== null && needsScope(editing.placed)}
              ownAddresses={myAddresses}
              // `mayRSVP` is read from the calendar the event is IN, not from the account: a shared
              // calendar can grant reading and refuse answering, and a bar that always fails is
              // worse than no bar. Looked up inside the event's OWN account (#79) — the same right
              // on another account's `c1` is a different calendar's answer.
              mayRsvp={rsvpAllowed(
                editing.placed === null
                  ? []
                  : (calendarsByAccount.get(editing.placed.accountId) ?? []),
                editing.placed,
              )}
              maxParticipants={maxParticipantsFor(editing.placed?.accountId ?? ownAccountId)}
              onCancel={() => setEditing(null)}
              onSubmit={(draft, scope, invite, chosenAccountId) => {
                const target = editing.placed
                /*
                 * Create goes to the account of the CHOSEN calendar; update goes to the account the
                 * event already lives in (#79). They are never derived from one another: a create
                 * has no event to ask, and an update may not be moved to another account by a
                 * picker — see `EventDialogProps.calendars`.
                 */
                const writer = clientFor(target === null ? chosenAccountId : target.accountId)
                if (writer === null) return
                void run(
                  () =>
                    target === null
                      ? writer.createEvent(draft, invite)
                      : writer.updateEvent(target, draft, scope, invite),
                  t('calendar.saveFailed'),
                )
              }}
              onRsvp={
                editing.placed === null
                  ? undefined
                  : (key, status) => {
                      const target = editing.placed as PlacedEvent
                      const writer = clientFor(target.accountId)
                      if (writer === null) return
                      void run(() => writer.rsvp(target, key, status), t('calendar.rsvpFailed'))
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

interface CalendarSectionsProps {
  readonly ownAccountId: Id
  /** The delegated accounts, in session order — each one a labelled section of its own. */
  readonly accounts: readonly DelegatedAccount[]
  readonly calendarsByAccount: ReadonlyMap<Id, Calendar[]>
  readonly shownByAccount: ReadonlyMap<Id, Record<Id, boolean>> | undefined
  /** The account `?account=` points at, marked with `aria-current` — see the page's note on it. */
  readonly highlightedAccount: Id | null
  /** `true` in the rail (a "Calendars" heading), `false` in the phone sheet (the title says it). */
  readonly heading: boolean
  readonly canCreateOwn: boolean
  readonly disabled: boolean
  onToggle: (accountId: Id, calendar: Calendar, shown: boolean) => void
  onCreate: () => void
  onEdit: (accountId: Id, calendar: Calendar) => void
  onDelete: (accountId: Id, calendar: Calendar) => void
  onShare?: ((accountId: Id, calendar: Calendar) => void) | undefined
}

/**
 * The calendars of every account, grouped (#79) — the reader's own first and unlabelled, then one
 * `<section>` per delegated account under that account's name.
 *
 * The same shape the contacts rail has used since S-4 (`GroupedBookList`), and for the same reason:
 * a reader with no shares must see exactly what they saw before — a plain list, no headings, no
 * extra landmarks — while a reader with shares needs to know whose "Team" they are ticking. The
 * account name is DATA and is not translated.
 *
 * A delegated section whose list has not arrived is not rendered at all. `CalendarList` would
 * otherwise say "This account has no calendars.", which is a claim, and it would be wrong for the
 * second or so before the answer lands.
 */
function CalendarSections(props: CalendarSectionsProps): ReactNode {
  const ownShown = props.shownByAccount?.get(props.ownAccountId) ?? NO_OVERRIDES
  return (
    <>
      <CalendarList
        calendars={props.calendarsByAccount.get(props.ownAccountId) ?? []}
        accountId={props.ownAccountId}
        shown={ownShown}
        heading={props.heading}
        canCreate={props.canCreateOwn}
        disabled={props.disabled}
        onToggle={(calendar, shown) => props.onToggle(props.ownAccountId, calendar, shown)}
        onCreate={props.onCreate}
        onEdit={(calendar) => props.onEdit(props.ownAccountId, calendar)}
        onDelete={(calendar) => props.onDelete(props.ownAccountId, calendar)}
        {...(props.onShare === undefined
          ? {}
          : {
              onShare: (calendar: Calendar) => props.onShare?.(props.ownAccountId, calendar),
            })}
      />
      {props.accounts.map((account) => {
        const list = props.calendarsByAccount.get(account.id)
        if (list === undefined) return null
        return (
          <section
            key={account.id}
            className={styles.calendarAccountSection}
            aria-label={account.name}
            {...(props.highlightedAccount === account.id
              ? { 'aria-current': 'true' as const }
              : {})}
          >
            <h3 className={styles.railTitle}>{account.name}</h3>
            <CalendarList
              calendars={list}
              accountId={account.id}
              shown={props.shownByAccount?.get(account.id) ?? NO_OVERRIDES}
              heading={false}
              /* Never from a delegated section: `Calendar/set create` against somebody else's
                 account is refused, and the session's `mayCreateCalendar` is the reader's own. */
              canCreate={false}
              disabled={props.disabled}
              onToggle={(calendar, shown) => props.onToggle(account.id, calendar, shown)}
              onCreate={props.onCreate}
              onEdit={(calendar) => props.onEdit(account.id, calendar)}
              onDelete={(calendar) => props.onDelete(account.id, calendar)}
              {...(props.onShare === undefined
                ? {}
                : { onShare: (calendar: Calendar) => props.onShare?.(account.id, calendar) })}
            />
          </section>
        )
      })}
    </>
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
  /** The colour of an event's calendar, or `null` for one this screen cannot resolve (#79). */
  readonly colorFor: (placed: PlacedEvent) => string | null
  onPick: (date: Date) => void
  /** The counter under a full cell was activated — show that day's whole list. */
  onExpand: (date: Date) => void
  /** An event chip was activated. */
  onOpen: (placed: PlacedEvent, day: Date) => void
}

function MonthView({
  days,
  byDay,
  locale,
  focus,
  colorFor,
  onPick,
  onExpand,
  onOpen,
}: MonthViewProps) {
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
                    // The ACCOUNT is in the key (#79): two accounts routinely hold an event with
                    // the same short id at the same instant, and React would then reconcile two
                    // different events into one chip.
                    key={`${placed.accountId}-${placed.event.id}-${placed.startsAt}`}
                    type="button"
                    {...chipColor(styles.chip, colorFor(placed))}
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
  colorFor,
  onClose,
  onOpen,
}: {
  readonly day: Date
  readonly events: readonly PlacedEvent[]
  readonly colorFor: (placed: PlacedEvent) => string | null
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
            <li key={`${placed.accountId}-${placed.event.id}-${placed.startsAt}`}>
              <button
                type="button"
                {...rowColor(styles.dayListRow, colorFor(placed))}
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
  colorFor,
  onOpen,
}: {
  readonly events: readonly PlacedEvent[]
  readonly today: Date
  readonly colorFor: (placed: PlacedEvent) => string | null
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
          <li key={`${placed.accountId}-${placed.event.id}-${placed.startsAt}`}>
            <button
              type="button"
              {...rowColor(styles.agendaRow, colorFor(placed))}
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
