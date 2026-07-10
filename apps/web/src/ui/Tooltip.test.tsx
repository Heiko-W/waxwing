import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Tooltip } from './Tooltip'

describe('Tooltip', () => {
  it('opens on focus and describes the trigger', async () => {
    render(
      <Tooltip content="Archive this thread">
        <button type="button">Archive</button>
      </Tooltip>,
    )
    const trigger = screen.getByRole('button', { name: 'Archive' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    trigger.focus()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Archive this thread')
    expect(trigger).toHaveAttribute('aria-describedby', tip.id)
  })

  it('dismisses on Escape', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip content="Hint">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    screen.getByRole('button').focus()
    await screen.findByRole('tooltip')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens on hover only after the delay', () => {
    vi.useFakeTimers()
    try {
      render(
        <Tooltip content="Hint" openDelay={300}>
          <button type="button">Trigger</button>
        </Tooltip>,
      )
      const trigger = screen.getByRole('button')
      fireEvent.pointerEnter(trigger)
      expect(screen.queryByRole('tooltip')).toBeNull()
      act(() => vi.advanceTimersByTime(299))
      expect(screen.queryByRole('tooltip')).toBeNull()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the pending open if the pointer leaves before the delay', () => {
    vi.useFakeTimers()
    try {
      render(
        <Tooltip content="Hint" openDelay={300}>
          <button type="button">Trigger</button>
        </Tooltip>,
      )
      const trigger = screen.getByRole('button')
      fireEvent.pointerEnter(trigger)
      fireEvent.pointerLeave(trigger)
      act(() => vi.advanceTimersByTime(400))
      expect(screen.queryByRole('tooltip')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays open while focused even after the pointer leaves', () => {
    vi.useFakeTimers()
    try {
      render(
        <Tooltip content="Hint">
          <button type="button">Trigger</button>
        </Tooltip>,
      )
      const trigger = screen.getByRole('button')
      act(() => {
        fireEvent.focus(trigger)
      })
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
      act(() => {
        fireEvent.pointerLeave(trigger)
        vi.advanceTimersByTime(300)
      })
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('has no accessibility violations while open', async () => {
    render(
      <Tooltip content="Hint">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    screen.getByRole('button').focus()
    await screen.findByRole('tooltip')
    await expectNoA11yViolations(document.body)
  })
})
