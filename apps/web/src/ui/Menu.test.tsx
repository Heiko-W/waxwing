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

  it('opens on the last item with ArrowUp', async () => {
    const user = userEvent.setup()
    render(<Menu triggerLabel="Actions" trigger="Actions" items={makeItems()} />)
    screen.getByRole('button', { name: 'Actions' }).focus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
  })

  it('activates the focused item with Enter and Space', async () => {
    const user = userEvent.setup()
    const onArchive = vi.fn()
    const onDelete = vi.fn()
    const { rerender } = render(
      <Menu triggerLabel="Actions" trigger="Actions" items={makeItems(onArchive, onDelete)} />,
    )
    const trigger = screen.getByRole('button', { name: 'Actions' })
    trigger.focus()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onArchive).toHaveBeenCalledOnce()
    expect(trigger).toHaveFocus()

    rerender(
      <Menu triggerLabel="Actions" trigger="Actions" items={makeItems(onArchive, onDelete)} />,
    )
    trigger.focus()
    await user.keyboard('{ArrowDown}{ArrowDown} ')
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('skips a disabled item in arrow nav and never activates it', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    const items: MenuItemSpec[] = [
      { id: 'archive', label: 'Archive', onSelect: vi.fn() },
      { id: 'move', label: 'Move', onSelect: onMove, disabled: true },
      { id: 'delete', label: 'Delete', onSelect: vi.fn() },
    ]
    render(<Menu triggerLabel="Actions" trigger="Actions" items={items} />)
    screen.getByRole('button', { name: 'Actions' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    expect(screen.getByRole('menuitem', { name: 'Move' })).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('menuitem', { name: 'Move' }))
    expect(onMove).not.toHaveBeenCalled()
  })

  it('jumps to an item by type-ahead', async () => {
    const user = userEvent.setup()
    render(<Menu triggerLabel="Actions" trigger="Actions" items={makeItems()} />)
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    await user.keyboard('d')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
  })

  it('has no accessibility violations while open', async () => {
    const user = userEvent.setup()
    render(<Menu triggerLabel="Actions" trigger="Actions" items={makeItems()} />)
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    await expectNoA11yViolations(document.body)
  })
})

describe('a menu near the bottom of the window opens upward', () => {
  it('flips when there is no room below, and stays put when there is', async () => {
    const user = userEvent.setup()
    // jsdom reports zeros for every rect, so the trigger's geometry is supplied — which is also the
    // only part of this that matters: the decision is arithmetic on a rect and a viewport.
    const rect = (top: number) =>
      ({
        top,
        bottom: top + 34,
        left: 10,
        right: 44,
        width: 34,
        height: 34,
        x: 10,
        y: top,
      }) as DOMRect

    render(
      <Menu
        triggerLabel="Actions"
        trigger="A"
        items={[{ id: 'a', label: 'Archive', onSelect: () => {} }]}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Actions' })

    // 40px of room under the trigger in an 800px window: the menu cannot fit below.
    window.innerHeight = 800
    trigger.getBoundingClientRect = () => rect(726)
    await user.click(trigger)
    const flipped = screen.getByRole('menu')
    // The trigger's top, less the gap — the menu is then pulled fully above that point by
    // `translateY(-100%)`, so the gap ends up between its bottom edge and the trigger.
    expect(flipped.style.top).toBe('722px')
    expect(flipped.className).toContain('flipped')

    await user.keyboard('{Escape}')

    // Near the top, with the whole window below it, nothing moves.
    trigger.getBoundingClientRect = () => rect(20)
    await user.click(trigger)
    const normal = screen.getByRole('menu')
    expect(normal.style.top).toBe('58px')
    expect(normal.className).not.toContain('flipped')
  })
})

/**
 * A menu never leaves the viewport, however many items it has.
 *
 * Flipping alone was never enough, and the folder-actions menu is where that showed. It carries nine
 * entries since "Folder info…" and "Share…" were added; measured on a 390 × 844 phone it is 406 px
 * tall. The old rule asked whether 240 px fitted below the trigger, 279 px did, so the menu opened
 * downward and ran to y = 975 — 131 px past the bottom of the screen, with its last two items
 * unreachable by pointer and invisible.
 *
 * Two halves, and both are needed. The ESTIMATE has to know how tall this menu wants to be, or the
 * flip keeps declining for anything longer than six items. The CEILING has to exist, or a menu
 * taller than both sides is merely off the other edge instead — nine items do not fit in half of a
 * phone whichever way they open.
 *
 * jsdom lays nothing out, so the geometry is supplied. That is the whole of the decision anyway:
 * arithmetic on a rect, a viewport and a count.
 */
describe('a long menu is bounded by the viewport', () => {
  const rect = (top: number) =>
    ({
      top,
      bottom: top + 40,
      left: 10,
      right: 44,
      width: 34,
      height: 40,
      x: 10,
      y: top,
    }) as DOMRect

  const nine = () =>
    Array.from({ length: 9 }, (_, index) => ({
      id: `i${index}`,
      label: `Item ${index}`,
      onSelect: () => {},
    }))

  it('flips a nine-item menu that the old six-item estimate said would fit', async () => {
    const user = userEvent.setup()
    render(<Menu triggerLabel="Actions" trigger="A" items={nine()} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })

    // The measured case: a folder row at y = 525 in an 844px phone. 275px below, 521px above.
    window.innerHeight = 844
    trigger.getBoundingClientRect = () => rect(525)
    await user.click(trigger)

    const menu = screen.getByRole('menu')
    // 275px is more than the old fixed 240, which is exactly why this used to open downward.
    expect(menu.className, 'nine items do not fit in 275px').toContain('flipped')
    // And it is given the room above as a ceiling, so `translateY(-100%)` cannot take it past y = 0.
    expect(menu.style.maxBlockSize).toBe('521px')
  })

  it('bounds a menu that opens downward to the room below it', async () => {
    const user = userEvent.setup()
    render(<Menu triggerLabel="Actions" trigger="A" items={nine()} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })

    window.innerHeight = 844
    trigger.getBoundingClientRect = () => rect(60)
    await user.click(trigger)

    const menu = screen.getByRole('menu')
    expect(menu.className).not.toContain('flipped')
    // 844 − 100 − 4. The menu is shorter than that today; the ceiling is what keeps it true when a
    // tenth item is added by someone who never reads this file.
    expect(menu.style.maxBlockSize).toBe('740px')
  })
})
