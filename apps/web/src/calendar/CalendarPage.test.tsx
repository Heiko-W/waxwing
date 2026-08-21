import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Calendar, CalendarEvent, CalendarEventFilter, Id } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../app/route'
import {
  canonicalCalendarQueryKey,
  putCalendarEvents,
  putCalendarQueryCache,
  putCalendars,
  type ReplicaDb,
  ReplicaProvider,
} from '../sync'
import { clearEngines, type SyncEngine, setEngineFor } from '../sync/engine'
import { freshDb } from '../sync/test-utils'
import { ToastProvider } from '../ui'
import CalendarPage from './CalendarPage'
import {
  type CalendarClient,
  CalendarSetError,
  type EventIdentity,
  type PlacedEvent,
  placeEvent,
} from './calendar-client'

/**
 * The calendar screen, end to end against a faked client.
 *
 * The walkthrough of 21 August 2026 found fifteen defects here and this file had three tests, none
 * of which could have caught the one that mattered: every edit and every delete failed, on every
 * event, because the screen wrote back with the id it had drawn with (T1). So the assertions below
 * are mostly about behaviour a screenshot shows and a type does not — WHICH id a write carries,
 * WHICH day an event appears on, WHICH sentence a failure produces, and what a click on a day does.
 */

const CALENDAR: Calendar = {
  id: 'c1',
  name: 'Work',
  color: null,
  isSubscribed: true,
  isVisible: true,
  myRights: {
    mayReadFreeBusy: true,
    mayReadItems: true,
    mayWriteAll: true,
    mayWriteOwn: true,
    mayUpdatePrivate: true,
    mayRSVP: true,
    mayAdmin: true,
    mayDelete: true,
  },
} as unknown as Calendar

function client(over: Partial<CalendarClient> = {}): CalendarClient {
  return {
    listCalendars: async (): Promise<Calendar[]> => [CALENDAR],
    eventsInRange: async (): Promise<PlacedEvent[]> => [],
    createCalendar: async (): Promise<void> => {},
    updateCalendar: async (): Promise<void> => {},
    destroyCalendar: async (): Promise<void> => {},
    countEvents: async (): Promise<number> => 0,
    createEvent: async (): Promise<void> => {},
    updateEvent: async (): Promise<void> => {},
    updateOccurrence: async (): Promise<void> => {},
    excludeOccurrence: async (): Promise<void> => {},
    rsvp: async (): Promise<void> => {},
    // Empty by default: without a matching own address the RSVP bar is not shown, which is what
    // every test written before K-3 assumes.
    listParticipantIdentities: async () => [],
    parseIcs: async () => [],
    importEvents: async () => ({ added: 0, duplicates: 0, failed: 0, reason: null }),
    destroyEvent: async (): Promise<CalendarEvent | null> => null,
    restoreEvent: async (): Promise<void> => {},
    // S-6. Empty directory + no answer by default: the availability picker then renders disabled
    // and the week view draws no hatch, which is what every test written before S-6 assumes.
    listPrincipals: async () => [],
    getAvailability: async () => null,
    ...over,
  }
}

/**
 * Local-time, not `new Date('…Z')`: 10:00 UTC is a different DAY in a few zones, and a grid test
 * that changes its answer with `TZ` is a test nobody can read a failure from.
 */
const TODAY = new Date(2026, 7, 20, 10, 0)

/**
 * An occurrence shaped the way Stalwart answers an EXPANDED query: a synthetic id for the view,
 * and — once identity is resolved — the real id underneath for a write.
 */
function occurrence(
  over: Partial<CalendarEvent> = {},
  identity: EventIdentity = { writeId: '0', series: false },
): PlacedEvent {
  return placeEvent(
    {
      id: 'eaaaaa0',
      uid: 'uid-1',
      calendarIds: { c1: true },
      title: 'Standup',
      // No `timeZone`: a floating event resolves in the reader's own zone, so every assertion
      // below holds whatever `TZ` the suite runs under.
      start: '2026-08-20T09:00:00',
      duration: 'PT60M',
      ...over,
    } as CalendarEvent,
    identity,
  )
}

const ACC = 'acc'

let db: ReplicaDb

/**
 * The window `[after, before)` and the calendar ids a watch spec names.
 *
 * The screen no longer calls `eventsInRange` — it registers a window with the sync engine and reads
 * the replica (K-8). This unpicks the filter the engine was handed so the fake below can answer with
 * the very same `eventsInRange` every test in this file already writes, and so the assertions about
 * WHICH calendars are asked about still assert exactly what they always did.
 */
function unpackFilter(filter: CalendarEventFilter | null | undefined): {
  from: Date
  to: Date
  ids: Id[]
} {
  type Node = {
    operator?: string
    conditions?: Node[]
    after?: string
    before?: string
    inCalendar?: Id
  }
  let from = new Date(0)
  let to = new Date(0)
  const ids: Id[] = []
  const visit = (node: Node | null | undefined): void => {
    if (node === null || node === undefined) return
    if (node.operator !== undefined) {
      for (const inner of node.conditions ?? []) visit(inner)
      return
    }
    if (node.after !== undefined) from = new Date(node.after)
    if (node.before !== undefined) to = new Date(node.before)
    if (node.inCalendar !== undefined) ids.push(node.inCalendar)
  }
  visit(filter as Node | null | undefined)
  return { from, to, ids }
}

/**
 * Write what `eventsInRange` answered into the replica, the way the real delta does.
 *
 * The identity half is RECONSTRUCTED from each `PlacedEvent`'s `writeId`/`series` — a stored object
 * per distinct write id, carrying a `recurrenceRule` when the occurrence claimed to be part of a
 * series — because that is what the server actually sends and what `resolveIdentity` reads back. A
 * test asking for `{ writeId: null }` seeds no object, so the occurrence resolves to nothing, which
 * is the "cannot be traced" case.
 */
async function materialize(
  key: string,
  spec: { filter?: CalendarEventFilter | null },
  c: CalendarClient,
): Promise<void> {
  const { from, to, ids } = unpackFilter(spec.filter)
  let placed: PlacedEvent[]
  try {
    placed = await c.eventsInRange(from, to, ids)
  } catch {
    // Exactly what the engine does with a refused window it has never materialized: a placeholder
    // row, so the screen can tell "tried and failed" from "still loading".
    await putCalendarQueryCache(db, {
      accountId: ACC,
      key,
      ids: [],
      objectIds: [],
      filter: spec.filter ?? null,
      stale: true,
      syncedAt: 0,
      lastUsedAt: 1,
    })
    return
  }

  const occurrences = placed.map((item) =>
    item.writeId === null
      ? item.event
      : ({ ...item.event, baseEventId: item.writeId } as CalendarEvent),
  )
  const objects = new Map<Id, CalendarEvent>()
  for (const item of placed) {
    if (item.writeId === null) continue
    objects.set(item.writeId, {
      ...item.event,
      id: item.writeId,
      ...(item.series ? { recurrenceRule: { frequency: 'weekly' } } : {}),
    } as CalendarEvent)
  }

  await putCalendarEvents(db, ACC, [...objects.values()], false)
  await putCalendarEvents(db, ACC, occurrences, true)
  await putCalendarQueryCache(db, {
    accountId: ACC,
    key,
    ids: occurrences.map((event) => event.id),
    objectIds: [...objects.keys()],
    filter: spec.filter ?? null,
    stale: false,
    syncedAt: 1,
    lastUsedAt: 1,
  })
}

/** The narrow slice of the engine this screen touches, backed by the injected client. */
function fakeEngine(c: CalendarClient): SyncEngine {
  const keyOf = (spec: { filter?: CalendarEventFilter | null }): string =>
    canonicalCalendarQueryKey({ filter: spec.filter ?? null, expandRecurrences: true })
  return {
    accountId: ACC,
    watchCalendarQuery(spec: { filter?: CalendarEventFilter | null }) {
      const key = keyOf(spec)
      // Swallowed: `afterEach` deletes the replica, and a seed still in flight then rejects with
      // `DatabaseClosedError` — an unhandled rejection that fails the run from outside any test.
      void materialize(key, spec, c).catch(() => {})
      return key
    },
    unwatchCalendarQuery() {},
    async refreshCalendarWindow(spec: { filter?: CalendarEventFilter | null }) {
      await materialize(keyOf(spec), spec, c).catch(() => {})
    },
  } as unknown as SyncEngine
}

function renderPage(c: CalendarClient) {
  db = freshDb()
  setEngineFor(ACC, fakeEngine(c))
  void putCalendars(db, ACC, [CALENDAR]).catch(() => {})
  return render(
    <RouterProvider>
      <ToastProvider>
        <ReplicaProvider accountId={ACC} db={db}>
          <CalendarPage client={c} today={TODAY} />
        </ReplicaProvider>
      </ToastProvider>
    </RouterProvider>,
  )
}

beforeEach(() => {
  window.history.pushState({}, '', '/')
})

const originalMatchMedia = window.matchMedia

/** Force the phone tier (nothing matches → `useLayoutTier` reports 'phone'). */
function forcePhone(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false
      },
    }),
  })
}

afterEach(async () => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
  clearEngines()
  // Unmount BEFORE the database goes away: a live query still subscribed to a deleted Dexie handle
  // raises `DatabaseClosedError` as an unhandled rejection, which fails the run from outside any test.
  cleanup()
  await db?.delete()
})

/**
 * The screen's toolbar: the smallest element holding both ends of it.
 *
 * Found by containment rather than by class name — a CSS-module class is a build artefact, and the
 * claim below ("the heading is not in that row") is about the DOM the reader gets, whatever the row
 * happens to be called.
 */
function toolbar(): HTMLElement {
  const plus = screen.getByRole('button', { name: 'New event' })
  let node: HTMLElement | null = screen.getByRole('button', { name: /Previous (month|week)/ })
  while (node !== null && !node.contains(plus)) node = node.parentElement
  if (node === null) throw new Error('no element holds both ends of the toolbar')
  return node
}

describe('CalendarPage reporting', () => {
  it('offers a way to create an event', async () => {
    // Day cells opened the dialog all along and nothing said so, which made this the one screen a
    // reader could look at without being told what it is for.
    renderPage(client())
    expect(await screen.findByRole('button', { name: 'New event' })).toBeInTheDocument()
  })

  it('says a save failed, in front of the dialog rather than behind it', async () => {
    /*
     * The defect this pins: `run` reported failure by setting the page-level `failed` flag, which
     * renders INSIDE the page — while the dialog is modal, portalled above it, and deliberately
     * stays open on failure. So the only report of a failed save was painted behind the backdrop,
     * and it said "The calendar could not be loaded", which is a different operation. Pressing
     * Save produced no visible response whatsoever.
     */
    const user = userEvent.setup()
    renderPage(
      client({
        createEvent: async (): Promise<void> => {
          throw new Error('server said no')
        },
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'New event' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/title/i), 'Standup')
    await user.click(within(dialog).getByRole('button', { name: /save|create/i }))

    // The toast region is portalled to the end of the document, which is exactly why it is
    // reachable while a modal is open.
    await waitFor(() =>
      expect(screen.getByText('The event could not be saved.')).toBeInTheDocument(),
    )
    // And the wording is about saving, not loading.
    expect(screen.queryByText('The calendar could not be loaded.')).not.toBeInTheDocument()
  })

  it('tells a failed load apart from an empty month, and offers a retry', async () => {
    // Both used to render through one class: a server error looked exactly like a calendar with
    // nothing in it, and only one of the two has anything the reader can do about it.
    const eventsInRange = vi.fn().mockRejectedValue(new Error('offline'))
    renderPage(client({ eventsInRange }))

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('The calendar could not be loaded.')).toBeInTheDocument()
    const retry = within(alert).getByRole('button', { name: 'Try again' })

    eventsInRange.mockResolvedValue([])
    await userEvent.setup().click(retry)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})

describe('writing an event (T1)', () => {
  it('sends the write to the OBJECT id, never to the id the grid drew with', async () => {
    /*
     * The leading defect of the walkthrough, in one assertion.
     *
     * The month is fetched with `expandRecurrences: true`, so the server answers with occurrence
     * ids (`eaaaaa0`). Writing back with one is refused — "Updating synthetic ids is not yet
     * supported." — and the identical patch addressed to `0` is accepted. Editing therefore failed
     * for every event in the calendar, single ones included.
     */
    const user = userEvent.setup()
    const updateEvent = vi.fn<CalendarClient['updateEvent']>(async () => {})
    renderPage(client({ eventsInRange: async () => [occurrence()], updateEvent }))

    await user.click(await screen.findByRole('button', { name: 'Standup' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateEvent).toHaveBeenCalled())
    const target = updateEvent.mock.calls[0]?.[0] as PlacedEvent
    expect(target.writeId).toBe('0')
    expect(target.event.id).toBe('eaaaaa0')
  })

  it('OPENS a series occurrence and asks for a scope after Save (K-2)', async () => {
    /*
     * The inversion. Until K-2 this test asserted that a repeating event opened a read-only note;
     * now it opens the editor, and the safety property moved from "no editor" to "no silent scope":
     * Save does not write, it asks, and the two answers are the two things the reader could mean.
     */
    const user = userEvent.setup()
    const updateEvent = vi.fn<CalendarClient['updateEvent']>(async () => {})
    renderPage(
      client({
        eventsInRange: async () => [
          occurrence({ title: 'Weekly' }, { writeId: '7', series: true }),
        ],
        updateEvent,
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Weekly' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    // Nothing has been written yet — the question is the whole point.
    expect(updateEvent).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: 'This event only' })).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'This event only' }))
    expect(updateEvent.mock.calls[0]?.[2]).toBe('occurrence')
  })

  it('says so when it cannot trace an occurrence back to a stored event', async () => {
    // The honest end of T1: no write id means no editor, and a sentence of its own — telling the
    // reader "this repeats" would be a different and untrue explanation.
    const user = userEvent.setup()
    renderPage(
      client({
        eventsInRange: async () => [
          occurrence({ title: 'Orphan' }, { writeId: null, series: false }),
        ],
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Orphan' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/cannot be traced back/)).toBeInTheDocument()
  })
})

describe('deleting an event (T7, T13)', () => {
  it('offers Undo rather than a confirmation, and restores what it deleted', async () => {
    /*
     * Delete is the one irreversible control on this screen and it went straight to the server
     * without a word (T13). The answer is the one mail triage already gives: do it, say so, and
     * keep the way back — a confirmation would tax every correct deletion to catch the rare wrong
     * one.
     */
    const user = userEvent.setup()
    const snapshot = { id: '0', uid: 'uid-1', title: 'Standup' } as unknown as CalendarEvent
    const restoreEvent = vi.fn(async () => {})
    renderPage(
      client({
        eventsInRange: async () => [occurrence()],
        destroyEvent: async () => snapshot,
        restoreEvent,
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Standup' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.getByText('Event deleted.')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(restoreEvent).toHaveBeenCalledWith(snapshot))
  })

  it('offers no Undo when nothing could be copied to restore', async () => {
    // A button labelled Undo that cannot restore is worse than no button: it is the one moment the
    // reader is relying on it.
    const user = userEvent.setup()
    renderPage(
      client({ eventsInRange: async () => [occurrence()], destroyEvent: async () => null }),
    )

    await user.click(await screen.findByRole('button', { name: 'Standup' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    )

    await waitFor(() => expect(screen.getByText('Event deleted.')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  it('speaks of DELETING when a delete fails, and repeats the reason the server gave', async () => {
    /*
     * T7. One `run` served create, update and delete, so a failed deletion said "The event could
     * not be saved." — a sentence about a different operation — while the server's own words
     * ("Deleting synthetic ids is not yet supported.") were received and dropped on the floor,
     * not shown and not even logged.
     */
    const user = userEvent.setup()
    renderPage(
      client({
        eventsInRange: async () => [occurrence()],
        destroyEvent: async () => {
          throw new CalendarSetError(
            'invalidProperties',
            'Deleting synthetic ids is not yet supported.',
          )
        },
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Standup' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    )

    await waitFor(() =>
      expect(screen.getByText('The event could not be deleted.')).toBeInTheDocument(),
    )
    expect(screen.getByText('Deleting synthetic ids is not yet supported.')).toBeInTheDocument()
    expect(screen.queryByText('The event could not be saved.')).not.toBeInTheDocument()
  })
})

describe('the month grid', () => {
  it('shows a multi-day event on every day it covers (T4)', async () => {
    // Keyed by its start alone, a three-day trip appeared on the 12th and left the 13th and 14th
    // empty — invisible to anyone looking at the days it actually spans.
    renderPage(
      client({
        eventsInRange: async () => [
          occurrence({
            title: 'Trip',
            start: '2026-08-12T00:00:00',
            duration: 'P3D',
            showWithoutTime: true,
          }),
        ],
      }),
    )

    expect(await screen.findAllByRole('button', { name: 'Trip' })).toHaveLength(3)
  })

  it('nests no button inside another (T9)', async () => {
    // React reported this twice on every visit ("`<button>` cannot be a descendant of
    // `<button>`"), and what a browser does with the inner control is undefined.
    const { container } = renderPage(client({ eventsInRange: async () => [occurrence()] }))
    await screen.findByRole('button', { name: 'Standup' })

    expect(container.querySelectorAll('button button')).toHaveLength(0)
  })

  it('selects the day it was clicked instead of starting an event there (T6)', async () => {
    // The URL never moved, so "the day I tapped" and "the day + will use" were different days and
    // nothing on screen said which was which.
    const user = userEvent.setup()
    renderPage(client())

    await user.click(await screen.findByRole('button', { name: 'Tuesday, August 25, 2026' }))

    expect(window.location.pathname).toContain('/calendar/2026-08-25')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('makes the hidden events of a full day reachable (T8)', async () => {
    /*
     * Five events in one cell showed three chips and a "+2 more" line sliced in half at the cell
     * boundary — and the line was a caption, so a click on it fell through to the cell. The two it
     * counted could not be reached in this view at all.
     */
    const user = userEvent.setup()
    const many = [1, 2, 3, 4, 5].map((n) =>
      occurrence({ id: `eaaaaa${n}`, title: `Meeting ${n}`, start: `2026-08-19T0${n}:00:00` }),
    )
    renderPage(client({ eventsInRange: async () => many }))

    const counter = await screen.findByRole('button', { name: '+3 more' })
    await user.click(counter)

    const dialog = await screen.findByRole('dialog')
    // All five, each one an activatable row — the two the cell could not hold included.
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(5)
    for (const n of [1, 2, 3, 4, 5]) {
      expect(within(dialog).getByText(`Meeting ${n}`)).toBeInTheDocument()
    }
  })

  it('does not show the previous month under the next month heading (T5)', async () => {
    /*
     * The fetch for the new month was still in flight, `events` still held the old month's, and
     * the grid drew August's events under a September heading as if they were real. A list is now
     * stamped with the window it answers about, so a stale one simply cannot be rendered.
     */
    const user = userEvent.setup()
    const eventsInRange = vi
      .fn<() => Promise<PlacedEvent[]>>()
      .mockResolvedValueOnce([occurrence()])
      .mockImplementationOnce(() => new Promise(() => {}))
    renderPage(client({ eventsInRange }))

    await screen.findByRole('button', { name: 'Standup' })
    await user.click(screen.getByRole('button', { name: 'Next month' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Standup' })).not.toBeInTheDocument(),
    )
  })
})

describe('the week view (T6)', () => {
  it('steps by a week, and says so', async () => {
    // Both arrows read "Next month" in every view and jumped one: 17–23 August was followed by
    // 21–27 September, and the weeks in between could not be reached at all.
    const user = userEvent.setup()
    renderPage(client())

    await user.click(await screen.findByRole('button', { name: 'Week' }))
    await user.click(await screen.findByRole('button', { name: 'Next week' }))

    expect(window.location.pathname).toContain('/calendar/2026-08-27')
  })

  it('names the week it is showing rather than the month', async () => {
    const user = userEvent.setup()
    renderPage(client())

    await user.click(await screen.findByRole('button', { name: 'Week' }))
    // 20 August 2026 is a Thursday; `en` starts its week on Sunday.
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'Aug 16 – Aug 22, 2026',
    )
  })

  it('gives whole-day events a band of their own (T4)', async () => {
    const user = userEvent.setup()
    renderPage(
      client({
        eventsInRange: async () => [
          occurrence({
            title: 'Trip',
            start: '2026-08-18T00:00:00',
            duration: 'P3D',
            showWithoutTime: true,
          }),
        ],
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Week' }))
    // 18–20 August: three of the seven columns, in the strip above the hour axis where an event
    // with no time of day belongs.
    expect(await screen.findAllByRole('button', { name: 'Trip' })).toHaveLength(3)
  })
})

/**
 * The availability layer (S-6).
 *
 * Three claims, and each is about a state the screen must NOT be allowed to reach:
 *
 *  - the picker exists only where the answer can be drawn (the week view has the time axis; the
 *    month and agenda do not), so there is no control whose effect the reader cannot see;
 *  - nothing is fetched until somebody is chosen — a person's diary is not something to ask for on
 *    the off-chance;
 *  - a `null` answer draws no hatch and SAYS so. An unhatched week would otherwise read as
 *    "free all week", which is a statement the client has no business making on the server's behalf.
 */
describe('showing somebody’s availability (S-6)', () => {
  const BOB = { id: 'p-bob', type: 'individual' as const, name: 'Bob Baker', email: 'bob@x.test' }

  it('offers the picker in the week view only', async () => {
    const user = userEvent.setup()
    renderPage(client({ listPrincipals: async () => [BOB] }))

    // The month view is the default, and it has no time axis to hatch.
    await screen.findByRole('button', { name: 'Week' })
    expect(screen.queryByLabelText('Show availability')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Week' }))
    expect(await screen.findByLabelText('Show availability')).toBeInTheDocument()
  })

  it('asks nobody about anybody until a person is chosen', async () => {
    const user = userEvent.setup()
    const getAvailability = vi.fn(async () => null)
    renderPage(client({ listPrincipals: async () => [BOB], getAvailability }))

    await user.click(await screen.findByRole('button', { name: 'Week' }))
    await screen.findByLabelText('Show availability')
    expect(getAvailability).not.toHaveBeenCalled()
  })

  it('draws a band per busy period once somebody is chosen', async () => {
    const user = userEvent.setup()
    renderPage(
      client({
        listPrincipals: async () => [BOB],
        getAvailability: async () => [
          {
            utcStart: new Date(2026, 7, 18, 10).toISOString(),
            utcEnd: new Date(2026, 7, 18, 12).toISOString(),
            busyStatus: 'confirmed' as const,
          },
        ],
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Week' }))
    await user.selectOptions(await screen.findByLabelText('Show availability'), 'p-bob')

    // The band itself is decoration; this sentence is the only form of it a screen reader gets,
    // and asserting on it is also the only honest way to assert on a background layer.
    expect(
      await screen.findByText(/Bob Baker is busy on .* from .* to .*/, { exact: false }),
    ).toBeInTheDocument()
  })

  it('says nothing came back rather than drawing an empty, free-looking week', async () => {
    const user = userEvent.setup()
    renderPage(client({ listPrincipals: async () => [BOB], getAvailability: async () => null }))

    await user.click(await screen.findByRole('button', { name: 'Week' }))
    await user.selectOptions(await screen.findByLabelText('Show availability'), 'p-bob')

    expect(
      await screen.findByText('No availability came back for that person.'),
    ).toBeInTheDocument()
  })

  it('is disabled, with a reason, when the directory is empty', async () => {
    const user = userEvent.setup()
    renderPage(client({ listPrincipals: async () => [] }))

    await user.click(await screen.findByRole('button', { name: 'Week' }))
    expect(await screen.findByText('There is nobody to ask.')).toBeInTheDocument()
    expect(await screen.findByLabelText('Show availability')).toBeDisabled()
  })
})

describe('the agenda', () => {
  it('shows a zone that differs from the reader’s', async () => {
    renderPage(
      client({
        eventsInRange: async () => [
          occurrence({ title: 'Tokyo call', timeZone: 'Etc/UTC', start: '2026-08-21T10:00:00' }),
        ],
      }),
    )
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Agenda' }))

    expect(await screen.findByText('Etc/UTC')).toBeInTheDocument()
  })

  it('shows NO zone for a whole-day event (T12)', async () => {
    /*
     * A whole-day event has no zone by definition, and the expanded query answers `Etc/UTC` for
     * one where a direct read answers `null`. The agenda printed that in the same place it prints a
     * real one, so a whole-day event looked as if it lived in a foreign zone.
     */
    renderPage(
      client({
        eventsInRange: async () => [
          occurrence({
            title: 'Holiday',
            timeZone: 'Etc/UTC',
            showWithoutTime: true,
            start: '2026-08-29T00:00:00',
            duration: 'P1D',
          }),
        ],
      }),
    )
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Agenda' }))

    await screen.findByText('Holiday')
    expect(screen.queryByText('Etc/UTC')).not.toBeInTheDocument()
  })
})

describe('offline (T3)', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  })

  /**
   * Render the screen with a replica that ALREADY holds August, and a server that answers nothing.
   *
   * This is the state a phone is in on a train: the month was synced this morning, the radio is off
   * now, and every request the screen could make will fail. Before K-8 that produced "The calendar
   * could not be loaded." over data the device was holding the whole time.
   */
  function renderWithReplicaOnly(placed: PlacedEvent[]) {
    db = freshDb()
    let seeded: Promise<void> = Promise.resolve()

    /**
     * Stands in for a window this device synced EARLIER and is now holding with no way to refresh
     * it: `stale: true` (a refresh is owed) and a `syncedAt` an hour old. The window is written
     * under the key the screen itself asks for, so the test cannot drift from the page's own idea of
     * which month it is looking at.
     */
    // The calendar list first and unconditionally: the screen has to know WHICH calendars to ask
    // about before it registers a window at all, so seeding it inside `seedFor` would deadlock.
    seeded = putCalendars(db, ACC, [CALENDAR]).catch(() => {})

    const seedFor = (key: string): void => {
      seeded = (async () => {
        const occurrences = placed.map(
          (item) => ({ ...item.event, baseEventId: item.writeId }) as CalendarEvent,
        )
        await putCalendarEvents(
          db,
          ACC,
          placed.map((item) => ({ ...item.event, id: item.writeId }) as CalendarEvent),
          false,
        )
        await putCalendarEvents(db, ACC, occurrences, true)
        await putCalendarQueryCache(db, {
          accountId: ACC,
          key,
          ids: occurrences.map((event) => event.id),
          objectIds: placed.map((item) => item.writeId as string),
          filter: null,
          stale: true,
          syncedAt: TODAY.getTime() - 3_600_000,
          lastUsedAt: 1,
        })
      })().catch(() => {})
    }

    // An engine that can reach nothing. It registers the window and refreshes NOTHING — which is
    // the offline contract: what the replica holds must survive a materialization that cannot run.
    setEngineFor(ACC, {
      accountId: ACC,
      watchCalendarQuery: (spec: { filter?: CalendarEventFilter | null }) => {
        const key = canonicalCalendarQueryKey({
          filter: spec.filter ?? null,
          expandRecurrences: true,
        })
        seedFor(key)
        return key
      },
      unwatchCalendarQuery: () => {},
      refreshCalendarWindow: async () => {},
    } as unknown as SyncEngine)

    // Every request this screen can make fails, exactly as it does with the radio off.
    const offlineClient = client({
      listCalendars: async () => {
        throw new Error('offline')
      },
      eventsInRange: async () => {
        throw new Error('offline')
      },
    })
    render(
      <RouterProvider>
        <ToastProvider>
          <ReplicaProvider accountId={ACC} db={db}>
            <CalendarPage client={offlineClient} today={TODAY} />
          </ReplicaProvider>
        </ToastProvider>
      </RouterProvider>,
    )
    return { seeded: () => seeded }
  }

  it('keeps showing the month it already had, and says it is not updating', async () => {
    /*
     * The whole of K-8 in one assertion. Every request this screen can make fails, and the event is
     * still on the grid — drawn from the replica, under a quiet line saying it is not being kept up
     * to date. Not an error pane, not a spinner, not an empty month.
     */
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    renderWithReplicaOnly([occurrence()])

    expect(await screen.findByRole('button', { name: 'Standup' })).toBeInTheDocument()
    const notice = await screen.findByRole('status')
    expect(notice.textContent).toContain('Not updating while offline')
    // And emphatically NOT the failure the screen used to show over exactly this data.
    expect(screen.queryByText('The calendar could not be loaded.')).not.toBeInTheDocument()
  })

  it('knows which calendars to draw even though the calendar list request failed', async () => {
    // The rail is read from the replica too. Without it the screen would not know WHICH calendars
    // to ask about, so the month filter would name none and the grid would be empty — the events
    // would be sitting in the replica, unreachable.
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    renderWithReplicaOnly([occurrence()])

    expect(await screen.findByRole('button', { name: 'Standup' })).toBeInTheDocument()
  })

  it('says a month it has never synced is not synced, rather than reporting a failure', async () => {
    // The other offline first-visit: nothing was ever stored for this window. That is "not synced
    // yet" with a sentence about what to do, not "could not be loaded" with a Try again that cannot.
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    renderPage(
      client({
        eventsInRange: async () => {
          throw new Error('offline')
        },
      }),
    )

    expect(await screen.findByText('This month has not been synced yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('refuses to open the editor and says why, instead of loading a chunk that is not there', async () => {
    /*
     * The `+` button was gated and the day cell and the chip were not. The dialog is a `lazy()`
     * chunk, so offline its import failed, the chunk boundary rendered nothing, and the entire
     * application went white — `document.body.innerHTML` was empty afterwards, and only a reload
     * brought it back.
     */
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const user = userEvent.setup()
    renderPage(client({ eventsInRange: async () => [occurrence()] }))

    await user.click(await screen.findByRole('button', { name: 'Standup' }))

    await waitFor(() =>
      expect(
        screen.getByText('You are offline. Events can only be opened and changed while connected.'),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('still refuses to open an occurrence it cannot trace, which needs no chunk', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const user = userEvent.setup()
    renderPage(
      client({
        eventsInRange: async () => [
          occurrence({ title: 'Orphan' }, { writeId: null, series: false }),
        ],
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Orphan' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})

describe('the phone header (F1)', () => {
  /*
   * The heading measured 32px of visible width against 76px of content on a 390px phone: "A…" for
   * "August 2026", "1…" for a week range. Five 44px controls of this screen's own plus the shell's
   * own buttons leave nothing for it, and none of those may shrink — so the heading leaves the row
   * instead of being squeezed inside it.
   *
   * Asserted structurally (is the heading in that row?) rather than by measurement: jsdom lays
   * nothing out, and the pixel widths were never the invariant — "the month is legible on a phone"
   * is.
   */
  it('takes the month out of the toolbar row', async () => {
    forcePhone()
    renderPage(client())

    const heading = await screen.findByRole('heading', { level: 1 })
    expect(toolbar().contains(heading), 'the heading shares no row with the buttons').toBe(false)
  })

  it('spells the month out again, now that there is room for it', async () => {
    // "Aug 2026" was the previous answer to the same pressure, and it did not work either — the
    // abbreviation bought 30px against a shortfall of 44.
    forcePhone()
    renderPage(client())

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('August 2026')
  })

  it('leaves the wide layout alone: there the heading IS the middle of the bar', async () => {
    // The strip beside the panes has room for both, and the pane title is where every other screen
    // states which list it is showing. This is the half that must not change.
    renderPage(client())

    const heading = await screen.findByRole('heading', { level: 1 })
    expect(toolbar().contains(heading)).toBe(true)
  })
})

/**
 * The calendar list (K-1).
 *
 * `Calendar/set` had been typed since M5.6 with no caller at all, so the calendars a reader owned
 * were a list they could look at. The assertion that matters most is not any of the buttons, though
 * — it is the one about `eventsInRange`: hiding a calendar has to become a question the SERVER is
 * asked, or it is a drawing trick that stops at the edge of this screen.
 */
describe('the calendar list', () => {
  const calendar = (over: Partial<Calendar> = {}): Calendar =>
    ({ ...CALENDAR, ...over }) as unknown as Calendar

  const WORK = calendar({ id: 'c1', name: 'Work', isDefault: true })
  const PRIVATE = calendar({ id: 'c2', name: 'Privat', isDefault: false })

  it('names only the VISIBLE calendars in the range query', async () => {
    /*
     * The whole reason K-1 is worth building. `eventsInRange` has taken `calendarIds` since M5.6 and
     * NOTHING ever passed one — so before this, a hidden calendar's events were fetched, drawn, and
     * then either filtered out on screen (a lie the moment you open the phone) or not filtered at
     * all. Now the server is told which calendars to answer about.
     */
    const seen: (readonly string[] | undefined)[] = []
    renderPage(
      client({
        listCalendars: async () => [WORK, calendar({ id: 'c2', name: 'Privat', isVisible: false })],
        eventsInRange: async (_from, _to, ids) => {
          seen.push(ids)
          return []
        },
      }),
    )

    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen.at(-1)).toEqual(['c1'])
  })

  it('treats a calendar with no `isVisible` at all as shown', async () => {
    // One-sided on purpose: only `false` hides. A server that does not send the property must not
    // end up with an empty calendar screen.
    const seen: (readonly string[] | undefined)[] = []
    renderPage(
      client({
        listCalendars: async () => [{ ...WORK, isVisible: undefined } as unknown as Calendar],
        eventsInRange: async (_from, _to, ids) => {
          seen.push(ids)
          return []
        },
      }),
    )

    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen.at(-1)).toEqual(['c1'])
  })

  it('writes the tick to the SERVER and asks again with what is left', async () => {
    const user = userEvent.setup()
    const updates: [string, unknown][] = []
    const seen: (readonly string[] | undefined)[] = []
    renderPage(
      client({
        listCalendars: async () => [WORK, PRIVATE],
        updateCalendar: async (id, patch) => {
          updates.push([id, patch])
        },
        eventsInRange: async (_from, _to, ids) => {
          seen.push(ids)
          return []
        },
      }),
    )

    await user.click(await screen.findByRole('checkbox', { name: 'Privat' }))

    await waitFor(() => expect(updates).toEqual([['c2', { isVisible: false }]]))
    // And the month is re-fetched WITHOUT it: the optimistic tick changes what the query asks for,
    // which is the difference between hiding a calendar and pretending to.
    await waitFor(() => expect(seen.at(-1)).toEqual(['c1']))
  })

  it('puts the tick back when the server refuses', async () => {
    const user = userEvent.setup()
    renderPage(
      client({
        listCalendars: async () => [WORK, PRIVATE],
        updateCalendar: async () => {
          throw new CalendarSetError('forbidden', 'Read-only calendar.')
        },
      }),
    )

    await user.click(await screen.findByRole('checkbox', { name: 'Privat' }))

    await waitFor(() =>
      expect(screen.getByText('The calendar could not be shown or hidden.')).toBeInTheDocument(),
    )
    // Re-read rather than patched back, so the screen ends up agreeing with the server rather than
    // with our guess about it.
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Privat' })).toBeChecked())
  })

  it('offers no Delete for the DEFAULT calendar', async () => {
    /*
     * The server would allow it — measured: `destroy` on the account's default calendar succeeds.
     * What it will NOT allow is appointing a replacement: `isDefault` is refused in create and in
     * update ("Field could not be set."), because on this server the flag belongs to the DAV
     * collection literally named `default`. So deleting it is a one-way door and it is not offered.
     */
    const user = userEvent.setup()
    renderPage(client({ listCalendars: async () => [WORK] }))

    await user.click(await screen.findByRole('button', { name: 'Options for Work' }))
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('offers no MENU AT ALL for a calendar the reader cannot write to', async () => {
    // Rights decide what is on the row, not whether the write is refused afterwards. A control that
    // always fails is how a screen teaches people to distrust it.
    renderPage(
      client({
        listCalendars: async () => [
          calendar({ id: 'c3', name: 'Team', myRights: { ...WORK.myRights, mayWriteAll: false } }),
        ],
      }),
    )

    expect(await screen.findByRole('checkbox', { name: 'Team' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Options for Team' })).not.toBeInTheDocument()
  })

  it('asks before deleting, names the calendar, and counts what goes with it', async () => {
    /*
     * The one control on this screen with a confirmation. An event is deleted with an Undo in the
     * toast because destroying one has an inverse; a calendar does not — measured, the destroy is
     * refused outright unless the client sends `onDestroyRemoveEvents: true`, and then it takes
     * every event with it. `create` + n × `CalendarEvent/set` would be a re-enactment with new ids.
     */
    const user = userEvent.setup()
    const destroyed: string[] = []
    renderPage(
      client({
        listCalendars: async () => [WORK, PRIVATE],
        countEvents: async () => 12,
        destroyCalendar: async (id) => {
          destroyed.push(id)
        },
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Options for Privat' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Privat')
    expect(dialog).toHaveTextContent('12 events')
    // Nothing has happened yet, which is the point of asking.
    expect(destroyed).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(destroyed).toEqual(['c2']))
  })

  it('will not let the reader agree to lose an unknown number of events', async () => {
    // The count arrives after the dialog opens, so the answer to a menu click is immediate. Until
    // it is known, Delete is out of reach: agreeing to lose "some events" is not agreement.
    const user = userEvent.setup()
    renderPage(
      client({
        listCalendars: async () => [WORK, PRIVATE],
        countEvents: () => new Promise<number>(() => {}),
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Options for Privat' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it('puts the list behind the view menu on a phone, where there is no rail', async () => {
    // Below 40em the rail is not narrowed, it is not rendered — a 215px rail beside a 390px phone is
    // two panes that both lose. The list becomes a screen-high sheet from the menu that already
    // carries Today.
    const user = userEvent.setup()
    forcePhone()
    renderPage(client({ listCalendars: async () => [WORK] }))

    expect(screen.queryByRole('checkbox', { name: 'Work' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Calendar view' }))
    await user.click(screen.getByRole('menuitem', { name: 'Calendars…' }))

    expect(await screen.findByRole('checkbox', { name: 'Work' })).toBeInTheDocument()
  })
})
