import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { SplitPane } from './SplitPane'

function Fixture() {
  return (
    <SplitPane
      label="Resize sidebar"
      defaultPrimarySize={300}
      minPrimarySize={160}
      maxPrimarySize={480}
      step={20}
    >
      <div>Primary</div>
      <div>Secondary</div>
    </SplitPane>
  )
}

describe('SplitPane', () => {
  it('exposes a separator with an orientation and value range', () => {
    render(<Fixture />)
    const separator = screen.getByRole('separator', { name: 'Resize sidebar' })
    expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    expect(separator).toHaveAttribute('aria-valuenow', '300')
    expect(separator).toHaveAttribute('aria-valuemin', '160')
    expect(separator).toHaveAttribute('aria-valuemax', '480')
  })

  it('resizes with the keyboard and clamps to the range', async () => {
    const user = userEvent.setup()
    render(<Fixture />)
    const separator = screen.getByRole('separator')
    separator.focus()
    await user.keyboard('{ArrowRight}')
    expect(separator).toHaveAttribute('aria-valuenow', '320')
    await user.keyboard('{Home}')
    expect(separator).toHaveAttribute('aria-valuenow', '160')
    await user.keyboard('{ArrowLeft}')
    expect(separator).toHaveAttribute('aria-valuenow', '160')
    await user.keyboard('{End}')
    expect(separator).toHaveAttribute('aria-valuenow', '480')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<Fixture />)
    await expectNoA11yViolations(container)
  })
})
