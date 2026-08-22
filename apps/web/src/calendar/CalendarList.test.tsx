/**
 * The calendar rail's share affordance (S-2).
 *
 * The one that has to hold: **a calendar the reader may not share offers no way to try.**
 * `myRights.mayShare` is the server's answer for the current user, and a calendar shared WITH them
 * comes back with it `false` and `shareWith: null` — only the owner ever sees the grant map. Drawing
 * the icon anyway would open a dialog listing nobody over something the server will refuse, which is
 * how a UI teaches people to distrust it.
 *
 * The rest is about the row staying legible: the "shared" marker is an icon PLUS a word (WCAG 1.4.1
 * — the icon alone is a shape nobody has been taught, and a tint would be the colour-only failure
 * outright), and it appears only when somebody really has access.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Calendar, CalendarRights } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { CalendarList } from './CalendarList'

const ALL_RIGHTS: CalendarRights = {
  mayReadFreeBusy: true,
  mayReadItems: true,
  mayWriteAll: true,
  mayWriteOwn: true,
  mayUpdatePrivate: true,
  mayRSVP: true,
  mayShare: true,
  mayDelete: true,
}

function calendar(over: Partial<Calendar> = {}): Calendar {
  return {
    id: 'c1',
    name: 'Work',
    description: null,
    color: null,
    timeZone: null,
    sortOrder: 0,
    isDefault: false,
    isSubscribed: true,
    isVisible: true,
    myRights: ALL_RIGHTS,
    ...over,
  } as Calendar
}

function renderList(calendars: readonly Calendar[], onShare?: (calendar: Calendar) => void) {
  return render(
    <CalendarList
      calendars={calendars}
      canCreate={false}
      disabled={false}
      onToggle={() => {}}
      onCreate={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      {...(onShare === undefined ? {} : { onShare })}
    />,
  )
}

describe('who is offered the share control', () => {
  /* THE test. Without the `mayShare` check this passes an icon to a dialog that cannot save. */
  it('offers nothing on a calendar whose `myRights.mayShare` is false', () => {
    renderList([calendar({ myRights: { ...ALL_RIGHTS, mayShare: false } })], () => {})
    expect(screen.queryByRole('button', { name: 'Share Work' })).not.toBeInTheDocument()
  })

  it('offers nothing when `myRights` never arrived at all', () => {
    renderList([calendar({ myRights: undefined as unknown as CalendarRights })], () => {})
    expect(screen.queryByRole('button', { name: 'Share Work' })).not.toBeInTheDocument()
  })

  it('offers nothing when the screen passes no handler — offline, or no session', () => {
    renderList([calendar()])
    expect(screen.queryByRole('button', { name: 'Share Work' })).not.toBeInTheDocument()
  })

  it('offers it on a calendar the reader owns', async () => {
    const onShare = vi.fn()
    renderList([calendar()], onShare)
    await userEvent.click(screen.getByRole('button', { name: 'Share Work' }))
    expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }))
  })

  it('names the row it belongs to, so a rail of four is not four identical buttons', () => {
    renderList([calendar(), calendar({ id: 'c2', name: 'Private' })], () => {})
    expect(screen.getByRole('button', { name: 'Share Work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share Private' })).toBeInTheDocument()
  })

  it('goes quiet while a write is in flight, like every other control on the row', () => {
    render(
      <CalendarList
        calendars={[calendar()]}
        canCreate={false}
        disabled
        onToggle={() => {}}
        onCreate={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onShare={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Share Work' })).toBeDisabled()
  })
})

describe('the "shared" marker', () => {
  it('is absent on a calendar nobody has access to', () => {
    renderList([calendar({ shareWith: null })], () => {})
    expect(screen.queryByText('Shared')).not.toBeInTheDocument()
  })

  it('is absent on an empty grant map — the property WAS fetched and it is empty', () => {
    renderList([calendar({ shareWith: {} })], () => {})
    expect(screen.queryByText('Shared')).not.toBeInTheDocument()
  })

  it('appears once somebody has access', () => {
    renderList([calendar({ shareWith: { 'p-bob': ALL_RIGHTS } })], () => {})
    expect(screen.getByText('Shared')).toBeInTheDocument()
  })

  /*
   * WCAG 1.4.1. The person glyph is `aria-hidden`, so the WORD is the whole of the marker for a
   * screen reader — and it is also what keeps the marker from being a colour or a shape alone for
   * everyone else.
   */
  it('carries a word, not an icon alone', () => {
    renderList([calendar({ shareWith: { 'p-bob': ALL_RIGHTS } })], () => {})
    const row = screen.getByText('Work').closest('li')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText('Shared')).toBeInTheDocument()
  })
})

describe('accessibility', () => {
  it('has no violations with a shared calendar and a share button on the row', async () => {
    const { container } = renderList([calendar({ shareWith: { 'p-bob': ALL_RIGHTS } })], () => {})
    await expectNoA11yViolations(container)
  })
})
