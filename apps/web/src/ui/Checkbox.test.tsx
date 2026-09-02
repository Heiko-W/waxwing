import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Checkbox } from './Checkbox'

describe('Checkbox', () => {
  it('toggles when its label is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Checkbox label="Remember me" onChange={onChange} />)
    await user.click(screen.getByLabelText('Remember me'))
    expect(onChange).toHaveBeenCalled()
    expect(screen.getByLabelText('Remember me')).toBeChecked()
  })

  it('reflects the indeterminate flag on the DOM node and clears it when it flips off', () => {
    const { rerender } = render(<Checkbox label="Select all" indeterminate />)
    const checkbox = screen.getByLabelText('Select all') as HTMLInputElement
    expect(checkbox.indeterminate).toBe(true)
    rerender(<Checkbox label="Select all" indeterminate={false} />)
    expect(checkbox.indeterminate).toBe(false)
  })

  it('stays indeterminate across a click that keeps the flag set', async () => {
    // `indeterminate` has no HTML attribute, so React never restores it — and a native click clears
    // it. A caller that stays mixed ACROSS the click (the message list's select-all over a folder
    // whose loaded window is not the whole folder, R-08) got a blank box while the prop still said
    // mixed, because the effect was keyed on a value that had not changed.
    function StaysMixed() {
      const [clicks, setClicks] = useState(0)
      return (
        <Checkbox
          label={`Select all (${String(clicks)})`}
          indeterminate
          checked={false}
          onChange={() => setClicks((n) => n + 1)}
        />
      )
    }
    const user = userEvent.setup()
    render(<StaysMixed />)
    const checkbox = screen.getByLabelText('Select all (0)') as HTMLInputElement
    expect(checkbox.indeterminate).toBe(true)
    await user.click(checkbox)
    await screen.findByLabelText('Select all (1)')
    expect(checkbox.indeterminate).toBe(true)
  })

  it('forwards both object and callback refs', () => {
    const objectRef = { current: null as HTMLInputElement | null }
    render(<Checkbox aria-label="one" ref={objectRef} />)
    expect(objectRef.current).toBeInstanceOf(HTMLInputElement)

    let fromCallback: HTMLInputElement | null = null
    render(
      <Checkbox
        aria-label="two"
        ref={(node) => {
          fromCallback = node
        }}
      />,
    )
    expect(fromCallback).toBeInstanceOf(HTMLInputElement)
  })

  it('supports a control-only variant via aria-label', async () => {
    const { container } = render(<Checkbox aria-label="Select all messages" />)
    expect(screen.getByLabelText('Select all messages')).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations when labelled', async () => {
    const { container } = render(<Checkbox label="Remember me" />)
    await expectNoA11yViolations(container)
  })
})
