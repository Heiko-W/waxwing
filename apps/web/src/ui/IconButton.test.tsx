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

/**
 * The visible hint a pointer gets (D-02).
 *
 * HIG `buttons`, macOS: "the system displays a tooltip after people hover over a button for a
 * moment. A tooltip displays a brief phrase that explains what a button does" — and, in the same
 * section, "buttons that contain text don't need to display a tooltip", which is the whole reason
 * this component needs one.
 *
 * Sixty-two call sites had an accessible name and nothing a sighted pointer user could read.
 * `ui/Tooltip` was fully built and, outside the dev gallery, had no callers at all — a per-site
 * opt-in that was never going to happen. This is the primitive doing it once.
 */
describe('IconButton — the pointer hint', () => {
  it('shows the label as a tooltip', () => {
    render(
      <IconButton label="Move to Trash">
        <svg aria-hidden="true" />
      </IconButton>,
    )
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toHaveAttribute(
      'title',
      'Move to Trash',
    )
  })

  it('keeps the accessible name coming from aria-label, not from title', () => {
    // The two happen to be equal by default, and that must not be what the name depends on: a
    // caller may replace the title with something longer, and the announced name must not follow.
    render(
      <IconButton label="Command palette" title="Command palette (Ctrl+K)">
        <svg aria-hidden="true" />
      </IconButton>,
    )
    const button = screen.getByRole('button', { name: 'Command palette' })
    expect(button).toHaveAttribute('title', 'Command palette (Ctrl+K)')
  })
})
