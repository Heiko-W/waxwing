import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Calendar } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../app/route'
import { ToastProvider } from '../ui'
import CalendarPage from './CalendarPage'
import type { CalendarClient, PlacedEvent } from './calendar-client'

/**
 * The screen's reporting, which is the part that was silently missing.
 *
 * `CalendarPageProps` already takes an injected client and a fixed `today` — the logic around the
 * grid is covered by `month-grid`/`week-grid`, so what is left to check here is what the reader is
 * told when something goes wrong.
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
    destroyEvent: async (): Promise<void> => {},
    ...over,
  }
}

const TODAY = new Date('2026-08-20T10:00:00Z')

function renderPage(c: CalendarClient) {
  return render(
    <RouterProvider>
      <ToastProvider>
        <CalendarPage client={c} today={TODAY} />
      </ToastProvider>
    </RouterProvider>,
  )
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
