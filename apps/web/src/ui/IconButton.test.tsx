import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Bell } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { IconButton } from './IconButton'

describe('IconButton', () => {
  it('takes its accessible name from the label prop', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <IconButton label="Notifications" onClick={onClick}>
        <Bell />
      </IconButton>,
    )
    await user.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('has no accessibility violations (icon hidden, label present)', async () => {
    const { container } = render(
      <IconButton label="Notifications">
        <Bell />
      </IconButton>,
    )
    await expectNoA11yViolations(container)
  })
})
