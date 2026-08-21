/**
 * The calendar editor (K-1) — the name, and above all the colour.
 *
 * The colour is the interesting half, for two reasons that have nothing to do with taste.
 *
 * **It is a value stored on the SERVER**, read by Apple Calendar and every CalDAV client on the
 * account, so it cannot be a `--waxwing-*` token: a token resolves to a different colour under a
 * different theme and to nothing at all outside this app. That is why `CALENDAR_COLORS` is literal
 * hex and why a foreign value is kept rather than snapped to the nearest of ours.
 *
 * **And it may never be the only thing saying which one is chosen** (WCAG 1.4.1). Every swatch is a
 * real radio labelled with its colour name, and the chosen name is spelled out under the row.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Calendar } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import CalendarDialog, { CALENDAR_COLORS, CalendarDeleteDialog } from './CalendarDialog'

const calendar = (over: Partial<Calendar> = {}): Calendar =>
  ({
    id: 'c2',
    name: 'Privat',
    color: CALENDAR_COLORS[0]?.value ?? null,
    isDefault: false,
    ...over,
  }) as unknown as Calendar

function renderDialog(over: Partial<React.ComponentProps<typeof CalendarDialog>> = {}) {
  const onSubmit = vi.fn()
  render(
    <CalendarDialog
      calendar={null}
      busy={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
      {...over}
    />,
  )
  return { onSubmit }
}

describe('the colour picker', () => {
  it('names every colour, so none of them is only a colour', () => {
    renderDialog()
    for (const entry of CALENDAR_COLORS) {
      expect(
        screen.getByRole('radio', { name: new RegExp(entry.key, 'i') }),
        entry.key,
      ).toBeInTheDocument()
    }
  })

  it('is a radio GROUP, not eight toggles', () => {
    // Eight buttons with `aria-pressed` would put eight stops in the Tab order and announce eight
    // independent switches. These are mutually exclusive, which is what a radio group means — and
    // it is where the arrow-key navigation comes from without a line of code.
    renderDialog()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(CALENDAR_COLORS.length)
    expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(1)
  })

  it('spells out which colour is chosen', async () => {
    // The tick on the swatch says "this one" to anyone who can see the row; this line says it to
    // anyone who cannot.
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('radio', { name: 'Green' }))
    expect(screen.getByText('Chosen: Green')).toBeInTheDocument()
  })

  it('KEEPS a colour this palette does not offer', async () => {
    /*
     * Another client chose `#123456` deliberately. Snapping it to the nearest of our eight on the
     * next rename would be the same class of damage as dropping an alert we do not model — quiet,
     * invisible here, and visible to whoever set it.
     */
    const user = userEvent.setup()
    const { onSubmit } = renderDialog({ calendar: calendar({ color: '#123456' }) })

    expect(screen.getByText('Chosen: Current color')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Privat', color: '#123456' })
  })

  it('does not offer a native colour input', () => {
    // `<input type="color">` hands the choice to an OS dialog: no say over its appearance, poor
    // keyboard handling, different on every platform — and sixteen million values where a calendar
    // wants eight that can be NAMED.
    const { container } = render(
      <CalendarDialog calendar={null} busy={false} onCancel={() => {}} onSubmit={() => {}} />,
    )
    expect(container.querySelector('input[type="color"]')).toBeNull()
  })
})

describe('the calendar editor', () => {
  it('refuses an empty name before the server has to', async () => {
    // Measured: `Calendar/set` answers `invalidProperties: "Field could not be set."` for an empty
    // name, and a server error is a poor way to report a typo.
    renderDialog()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('submits the name it was given, trimmed', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderDialog()

    await user.type(screen.getByLabelText('Name'), '  Privat  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit.mock.calls[0]?.[0].name).toBe('Privat')
  })
})

describe('the delete confirmation', () => {
  it('names the calendar and counts what goes with it', () => {
    render(
      <CalendarDeleteDialog
        calendar={calendar()}
        eventCount={12}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('12 events')
    expect(screen.getByRole('dialog')).toHaveTextContent('Privat')
  })

  it('does not let the reader agree to an unknown number', () => {
    render(
      <CalendarDeleteDialog
        calendar={calendar()}
        eventCount={null}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
  })
})
