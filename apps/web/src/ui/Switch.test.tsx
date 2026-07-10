import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Switch } from './Switch'

function Controlled() {
  const [on, setOn] = useState(false)
  return <Switch checked={on} onCheckedChange={setOn} label="Unread only" />
}

describe('Switch', () => {
  it('exposes role=switch with a name and checked state', () => {
    render(<Controlled />)
    expect(screen.getByRole('switch', { name: 'Unread only' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('toggles on click and via Space/Enter', async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    const toggle = screen.getByRole('switch')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    toggle.focus()
    await user.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<Controlled />)
    await expectNoA11yViolations(container)
  })
})
