import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Calendar, CalendarEvent } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../app/route'
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
    createEvent: async (): Promise<void> => {},
    updateEvent: async (): Promise<void> => {},
    destroyEvent: async (): Promise<CalendarEvent | null> => null,
    restoreEvent: async (): Promise<void> => {},
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

function renderPage(c: CalendarClient) {
  return render(
    <RouterProvider>
      <ToastProvider>
        <CalendarPage client={c} today={TODAY} />
      </ToastProvider>
    </RouterProvider>,
  )
}

beforeEach(() => {
  window.history.pushState({}, '', '/')
})

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

  it('shows a series occurrence instead of pretending to edit it', async () => {
    const user = userEvent.setup()
    renderPage(
      client({
        eventsInRange: async () => [
          occurrence({ title: 'Weekly' }, { writeId: '7', series: true }),
        ],
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Weekly' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/This event repeats/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
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

  it('still shows a series occurrence, which needs neither chunk nor connection', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const user = userEvent.setup()
    renderPage(
      client({
        eventsInRange: async () => [
          occurrence({ title: 'Weekly' }, { writeId: '7', series: true }),
        ],
      }),
    )

    await user.click(await screen.findByRole('button', { name: 'Weekly' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})
