import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Calendar, CalendarEvent } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import EventDialog, { parseDurationMinutes } from './EventDialog'

/**
 * The event editor's own behaviour — the parts that never reach the network.
 *
 * Two findings live here. **T14**: a length the app would not send produced no response from the
 * app at all — no request went out, the dialog sat there, and the only feedback was the browser's
 * native bubble, in the browser's language and gone on the next keystroke. And the field could not
 * be emptied: `Number('')` is 0, so a controlled numeric field snapped back to `0` the moment it
 * was cleared. **T11**: a location and an attendee list came down from the server on every read
 * and were shown nowhere.
 */

const CALENDAR = { id: 'c1', name: 'Work', isDefault: true } as unknown as Calendar

const EXISTING = {
  id: '0',
  uid: 'uid-1',
  calendarIds: { c1: true },
  title: 'Review',
  start: '2026-08-20T10:00:00',
  duration: 'PT60M',
} as unknown as CalendarEvent

function renderDialog(over: Partial<React.ComponentProps<typeof EventDialog>> = {}) {
  const onSubmit = vi.fn()
  render(
    <EventDialog
      event={null}
      defaultDate={new Date(2026, 7, 20, 9, 0)}
      calendars={[CALENDAR]}
      busy={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
      {...over}
    />,
  )
  return { onSubmit }
}

const duration = (): HTMLInputElement =>
  screen.getByLabelText('Length in minutes') as HTMLInputElement

describe('parseDurationMinutes', () => {
  it('accepts a plain count of minutes', () => {
    expect(parseDurationMinutes('90')).toBe(90)
    expect(parseDurationMinutes(' 90 ')).toBe(90)
  })

  it('refuses everything that is not a length', () => {
    for (const bad of ['', '0', '-30', '1.5', 'soon', '1e3']) {
      expect(parseDurationMinutes(bad), bad).toBeNull()
    }
  })

  it('refuses a value that is a typo rather than a length', () => {
    // 999 999 999 minutes is about nineteen centuries, and the field took it.
    expect(parseDurationMinutes('999999999')).toBeNull()
    expect(parseDurationMinutes(String(365 * 24 * 60))).toBe(525_600)
  })
})

describe('the length field (T14)', () => {
  it('can be emptied and typed again', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.clear(duration())
    // The defect: this read "0" the instant the field went blank, so the value could only be
    // overtyped, never cleared and retyped.
    expect(duration().value).toBe('')

    await user.type(duration(), '45')
    expect(duration().value).toBe('45')
  })

  it('answers in the page when the value will not be sent', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderDialog()

    await user.type(screen.getByLabelText('Title'), 'Standup')
    await user.clear(duration())
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText('Enter a length between 1 and 525600 minutes.')).toBeInTheDocument()
    expect(duration()).toHaveAttribute('aria-invalid', 'true')
    // And nothing went out: the walkthrough measured zero JMAP calls here, which was correct — it
    // was the silence that was wrong.
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('takes the complaint back as soon as the reader answers it', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderDialog()

    await user.type(screen.getByLabelText('Title'), 'Standup')
    await user.clear(duration())
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await user.type(duration(), '30')

    expect(screen.queryByText(/Enter a length/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ durationMinutes: 30 }))
  })

  it('is not asked for at all on a whole-day event', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderDialog()

    await user.type(screen.getByLabelText('Title'), 'Holiday')
    await user.click(screen.getByLabelText('All day'))
    expect(screen.queryByLabelText('Length in minutes')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ allDay: true }))
  })
})

describe('what the editor cannot edit (T11)', () => {
  it('shows a location and the attendees the event carries', async () => {
    renderDialog({
      event: {
        ...EXISTING,
        locations: { l1: { '@type': 'Location', name: 'Besprechungsraum 3, Verl' } },
        participants: { p1: { '@type': 'Participant', name: 'Bob Baker' } },
      } as unknown as CalendarEvent,
    })

    expect(screen.getByText('Location')).toBeInTheDocument()
    expect(screen.getByText('Besprechungsraum 3, Verl')).toBeInTheDocument()
    expect(screen.getByText('Participants')).toBeInTheDocument()
    expect(screen.getByText('Bob Baker')).toBeInTheDocument()
  })

  it('falls back to a participant’s address when it has no name', () => {
    renderDialog({
      event: {
        ...EXISTING,
        participants: { p1: { '@type': 'Participant', email: 'bob@waxwing.test' } },
      } as unknown as CalendarEvent,
    })

    expect(screen.getByText('bob@waxwing.test')).toBeInTheDocument()
  })

  it('says nothing where there is nothing to say', () => {
    // An empty "Location: —" row is a field the dialog does not have, dressed up as one it does.
    renderDialog({ event: EXISTING })
    expect(screen.queryByText('Location')).not.toBeInTheDocument()
    expect(screen.queryByText('Participants')).not.toBeInTheDocument()
  })
})

describe('the actions row (T13)', () => {
  it('separates Delete from the pair beside it', () => {
    /*
     * Delete stood immediately left of Cancel: two adjacent buttons, one of which discards the
     * dialog and the other the event. The separation itself is a CSS rule (`margin-inline-end:
     * auto`), which no DOM assertion can see — what this pins is that the hook for it is still on
     * the button, so the rule cannot be silently orphaned by a refactor.
     */
    renderDialog({ event: EXISTING, onDestroy: () => {} })
    expect(screen.getByRole('button', { name: 'Delete' }).className).toMatch(/deleteAction/)
  })

  it('offers no Delete while creating', () => {
    renderDialog()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })
})

/**
 * Reminders (K-5) in the editor.
 *
 * The gap: `alerts` reached no property list, so an alarm set on a phone was invisible here. The
 * risk in closing it: the editor now NAMES the property in a patch, so everything it cannot model is
 * one save away from deletion. Both halves are asserted.
 */
describe('reminders', () => {
  const withAlerts = (alerts: Record<string, unknown>): CalendarEvent =>
    ({ ...EXISTING, alerts }) as unknown as CalendarEvent

  const DISPLAY_15 = {
    '@type': 'Alert',
    action: 'display',
    trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' },
  }
  const EMAIL_1H = {
    '@type': 'Alert',
    action: 'email',
    trigger: { '@type': 'OffsetTrigger', offset: '-PT1H' },
  }

  it('SHOWS the reminder the server sent, which nothing in this app used to', async () => {
    renderDialog({ event: withAlerts({ k1: DISPLAY_15 }) })
    expect(await screen.findByLabelText('Alert')).toHaveValue('-PT15M')
  })

  it('offers a second reminder only once the first is set', async () => {
    const user = userEvent.setup()
    renderDialog({ event: EXISTING })

    // One empty row, and no invitation to fill in a second: two blank "Alert" rows tell every
    // reader that two are expected.
    expect(screen.queryByLabelText('Second alert')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Alert'), '-PT15M')
    expect(await screen.findByLabelText('Second alert')).toBeInTheDocument()
  })

  it('sends the chosen reminder with the save', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderDialog({ event: EXISTING })

    await user.selectOptions(screen.getByLabelText('Alert'), '-PT30M')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit.mock.calls[0]?.[0].alerts.offsets).toEqual(['-PT30M'])
  })

  it('says an emptied list is EMPTIED, not untouched', async () => {
    // The distinction the whole design turns on: `undefined` leaves `alerts` out of the patch,
    // an empty EventAlerts writes `alerts: null`. The dialog always knows which, because it read
    // the alerts on the way in.
    const user = userEvent.setup()
    const { onSubmit } = renderDialog({ event: withAlerts({ k1: DISPLAY_15 }) })

    await user.selectOptions(screen.getByLabelText('Alert'), '')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit.mock.calls[0]?.[0].alerts).toEqual({ offsets: [], opaque: {} })
  })

  it('reports an EMAIL reminder without offering to edit it, and carries it through', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderDialog({ event: withAlerts({ k1: DISPLAY_15, k2: EMAIL_1H }) })

    // Counted, not listed: saying how many there are is the difference between "this app keeps
    // them" and a reader concluding they are gone.
    expect(screen.getByText(/1 further reminder is kept unchanged/)).toBeInTheDocument()
    // And not editable — the only value in the picker is the display alarm.
    expect(screen.getByLabelText('Alert')).toHaveValue('-PT15M')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit.mock.calls[0]?.[0].alerts.opaque).toEqual({ k2: EMAIL_1H })
  })

  it('offers the WHOLE-DAY values once the event has no time of day', async () => {
    // A whole-day event starts at midnight, so a reminder has to name a clock time or it fires
    // while the reader is asleep. Apple's values, and the first one is nine hours AFTER the start.
    const user = userEvent.setup()
    renderDialog({ event: EXISTING })

    await user.click(screen.getByLabelText('All day'))
    const options = within(screen.getByLabelText('Alert')).getAllByRole('option')
    expect(options.map((option) => (option as HTMLOptionElement).value)).toEqual([
      '',
      'PT9H',
      '-PT15H',
      '-PT39H',
      '-PT159H',
    ])
  })

  it('keeps a stored value the fixed list does not contain', async () => {
    // Same stance as the calendar colour picker: a value this app did not offer is still a value
    // somebody chose, and switching the row to "All day" must not silently discard it.
    renderDialog({
      event: withAlerts({
        k1: {
          '@type': 'Alert',
          action: 'display',
          trigger: { '@type': 'OffsetTrigger', offset: '-PT7M' },
        },
      }),
    })
    expect(await screen.findByLabelText('Alert')).toHaveValue('-PT7M')
  })
})
