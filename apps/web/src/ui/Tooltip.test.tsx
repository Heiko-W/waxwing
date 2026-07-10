import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
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
