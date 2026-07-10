import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Select } from './Select'

function Fixture({ invalid = false }: { invalid?: boolean }) {
  return (
    <>
      <label htmlFor="sort">Sort</label>
      <Select id="sort" invalid={invalid} defaultValue="date">
        <option value="date">Date</option>
        <option value="from">From</option>
      </Select>
    </>
  )
}

describe('Select', () => {
  it('reflects the invalid state via aria-invalid', () => {
    render(<Fixture invalid />)
    expect(screen.getByLabelText('Sort')).toHaveAttribute('aria-invalid', 'true')
  })

  it('changes value via the keyboard/native control', async () => {
    const user = userEvent.setup()
    render(<Fixture />)
    await user.selectOptions(screen.getByLabelText('Sort'), 'from')
    expect(screen.getByLabelText('Sort')).toHaveValue('from')
  })

  it('has no accessibility violations when labelled', async () => {
    const { container } = render(<Fixture />)
    await expectNoA11yViolations(container)
  })
})
