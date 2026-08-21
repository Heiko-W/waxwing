import { render, screen } from '@testing-library/react'
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
