import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('reflects the indeterminate flag on the DOM node', () => {
    render(<Checkbox label="Select all" indeterminate />)
    expect((screen.getByLabelText('Select all') as HTMLInputElement).indeterminate).toBe(true)
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
