import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCallback, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { Menu } from './Menu'

function Harness({
  onClosed = vi.fn(),
  dismissOnBackdrop = true,
}: {
  onClosed?: () => void
  dismissOnBackdrop?: boolean
}) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => {
    setOpen(false)
    onClosed()
  }, [onClosed])
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <Dialog
        open={open}
        onClose={close}
        title="Confirm deletion"
        dismissOnBackdrop={dismissOnBackdrop}
      >
        <p>This cannot be undone.</p>
        <Button>Inside</Button>
      </Dialog>
    </>
  )
}

// A Dialog containing a Menu — the nested-overlay case for Escape dispatch.
function NestedHarness() {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <Dialog open={open} onClose={close} title="Parent">
        <Menu
          triggerLabel="Inner actions"
          trigger="Inner"
          items={[{ id: 'archive', label: 'Archive', onSelect: () => {} }]}
        />
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

  it('traps Tab focus, wrapping at both ends', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    const close = screen.getByRole('button', { name: 'Close' })
    const inside = screen.getByRole('button', { name: 'Inside' })
    inside.focus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    expect(inside).toHaveFocus()
  })

  it('locks body scroll while open and restores it on close', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(document.body.style.overflow).toBe('hidden')
    await user.keyboard('{Escape}')
    expect(document.body.style.overflow).toBe('')
  })

  it('closes on a backdrop press but not on a press inside the panel', async () => {
    render(<Harness />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }))
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement
    fireEvent.mouseDown(screen.getByText('This cannot be undone.'))
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.mouseDown(backdrop)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('honors dismissOnBackdrop={false}', async () => {
    render(<Harness dismissOnBackdrop={false} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }))
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement
    fireEvent.mouseDown(backdrop)
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })

  it('Escape closes only the innermost overlay (Menu inside Dialog)', async () => {
    const user = userEvent.setup()
    render(<NestedHarness />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await user.click(screen.getByRole('button', { name: 'Inner actions' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has no accessibility violations while open', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await expectNoA11yViolations(document.body)
  })

  // A `role="dialog"` container is not sectioning content, so an HTML <header> inside it still maps
  // to the `banner` landmark — a second, unnamed banner alongside the shell's. The browser sweep
  // reported it as `landmark-unique` on every screen that could open a dialog.
  it('contributes no banner or contentinfo landmark', () => {
    render(
      <Dialog open onClose={() => {}} title="Settings" footer={<button type="button">OK</button>}>
        <p>body</p>
      </Dialog>,
    )
    expect(screen.queryByRole('banner')).toBeNull()
    expect(screen.queryByRole('contentinfo')).toBeNull()
    // …while the title and the footer content are still there, so this is not just an empty dialog.
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument()
  })
})
