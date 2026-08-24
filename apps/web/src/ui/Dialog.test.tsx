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

/**
 * The discard guard (HIG `modality`: "help people avoid data loss by getting confirmation before
 * closing a modal view … regardless of whether people use a dismiss gesture or a button").
 *
 * The case this was written for is not exotic. On a 390 px phone the backdrop is not a thin margin
 * — the panel is centred in `position: fixed; inset: 0`, so above and below a short dialog there is
 * a large press target, and a thumb reaching to dismiss the keyboard lands on it. The event editor,
 * the Sieve rule form and the label form all closed on that press and threw the form away, with no
 * undo behind them.
 */
function GuardedHarness({ onClosed = vi.fn() }: { onClosed?: () => void }) {
  const [open, setOpen] = useState(true)
  const close = useCallback(() => {
    setOpen(false)
    onClosed()
  }, [onClosed])
  return (
    <Dialog open={open} onClose={close} title="Edit event" confirmDiscard>
      <label htmlFor="t">
        Title
        <input id="t" />
      </label>
    </Dialog>
  )
}

describe('Dialog — confirming a discard', () => {
  it('closes without asking while nothing has been entered', async () => {
    // The guard must not tax the reader who opened a form and changed their mind about opening it.
    const user = userEvent.setup()
    const onClosed = vi.fn()
    render(<GuardedHarness onClosed={onClosed} />)
    await user.keyboard('{Escape}')
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('asks before Escape throws typed input away', async () => {
    const user = userEvent.setup()
    const onClosed = vi.fn()
    render(<GuardedHarness onClosed={onClosed} />)
    await user.type(screen.getByLabelText('Title'), 'Dentist')
    await user.keyboard('{Escape}')
    expect(onClosed, 'Escape discarded the form without asking').not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Discard your changes?' })).toBeInTheDocument()
  })

  it('asks before a backdrop press throws typed input away', async () => {
    // The phone case. `fireEvent` rather than `user.click`, because the assertion is specifically
    // about a press landing on the backdrop element itself and not on the panel.
    const user = userEvent.setup()
    const onClosed = vi.fn()
    const { container } = render(<GuardedHarness onClosed={onClosed} />)
    await user.type(screen.getByLabelText('Title'), 'Dentist')
    const backdrop = container.ownerDocument.querySelector('[role="dialog"]')?.parentElement
    expect(backdrop).not.toBeNull()
    if (backdrop) fireEvent.mouseDown(backdrop)
    expect(onClosed).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Discard your changes?' })).toBeInTheDocument()
  })

  it('asks before the close button throws typed input away', async () => {
    // Three ways out, one guard. Leaving the button unguarded would only move the loss.
    const user = userEvent.setup()
    const onClosed = vi.fn()
    render(<GuardedHarness onClosed={onClosed} />)
    await user.type(screen.getByLabelText('Title'), 'Dentist')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClosed).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Discard your changes?' })).toBeInTheDocument()
  })

  it('keeps editing when the confirmation is declined', async () => {
    const user = userEvent.setup()
    const onClosed = vi.fn()
    render(<GuardedHarness onClosed={onClosed} />)
    await user.type(screen.getByLabelText('Title'), 'Dentist')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onClosed).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Edit event' })).toBeInTheDocument()
    expect(screen.getByLabelText('Title')).toHaveValue('Dentist')
  })

  it('discards when the confirmation is accepted', async () => {
    const user = userEvent.setup()
    const onClosed = vi.fn()
    render(<GuardedHarness onClosed={onClosed} />)
    await user.type(screen.getByLabelText('Title'), 'Dentist')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('does not guard a dialog that did not ask for it', async () => {
    // Most dialogs here hold a choice rather than typing; an extra confirmation on those is
    // friction for nothing, which is why the guard is opt-in.
    const user = userEvent.setup()
    const onClosed = vi.fn()
    render(
      <Dialog open onClose={onClosed} title="Move to">
        <input aria-label="Filter" />
      </Dialog>,
    )
    await user.type(screen.getByLabelText('Filter'), 'arch')
    await user.keyboard('{Escape}')
    expect(onClosed).toHaveBeenCalledTimes(1)
  })
})
