import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { Menu, type MenuItemSpec } from './Menu'

function makeItems(onArchive = vi.fn(), onDelete = vi.fn()): MenuItemSpec[] {
  return [
    { id: 'archive', label: 'Archive', onSelect: onArchive },
    { id: 'delete', label: 'Delete', onSelect: onDelete, destructive: true },
  ]
}

describe('Menu', () => {
  it('opens on click and lists its menuitems', async () => {
    const user = userEvent.setup()
    render(<Menu triggerLabel="Actions" trigger="Actions" items={makeItems()} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  })

  it('activates an item, closes, and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const onArchive = vi.fn()
    render(<Menu triggerLabel="Actions" trigger="Actions" items={makeItems(onArchive)} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }))
    expect(onArchive).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('moves focus with arrow keys and closes on Escape', async () => {
    const user = userEvent.setup()
    render(<Menu triggerLabel="Actions" trigger="Actions" items={makeItems()} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('has no accessibility violations while open', async () => {
    const user = userEvent.setup()
    render(<Menu triggerLabel="Actions" trigger="Actions" items={makeItems()} />)
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    await expectNoA11yViolations(document.body)
  })
})
