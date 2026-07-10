import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCallback, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Button } from './Button'
import { Dialog } from './Dialog'

function Harness({ onClosed = vi.fn() }: { onClosed?: () => void }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => {
    setOpen(false)
    onClosed()
  }, [onClosed])
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <Dialog open={open} onClose={close} title="Confirm deletion">
        <p>This cannot be undone.</p>
        <Button>Inside</Button>
      </Dialog>
    </>
  )
}

describe('Dialog', () => {
  it('is a modal labelled by its title and traps focus on open', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('Confirm deletion')
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('closes on Escape and restores focus to the opener', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open' })
    await user.click(opener)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('closes via the close button', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has no accessibility violations while open', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await expectNoA11yViolations(document.body)
  })
})
