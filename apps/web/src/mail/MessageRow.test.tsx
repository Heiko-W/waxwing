import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type EmailRow, toEmailRow } from '../sync'
import { email } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { MessageRow } from './MessageRow'

function row(over: Parameters<typeof email>[1] = {}): EmailRow {
  return toEmailRow('a', email('e1', over))
}

function grid(children: ReactNode) {
  return render(<div role="grid">{children}</div>)
}

const noop = () => {}

const baseProps = {
  id: 'r1',
  rowIndex: 1,
  selected: false,
  active: false,
  focused: false,
  density: 'comfortable' as const,
  onOpen: noop,
  onSelectToggle: noop,
  onSelectRange: noop,
  onActivate: noop,
}

describe('MessageRow', () => {
  it('renders sender, subject, preview and a localized time', () => {
    grid(
      <MessageRow
        {...baseProps}
        email={row({
          from: [{ name: 'Alice Adams', email: 'alice@waxwing.test' }],
          subject: 'Hello there',
          preview: 'A short preview',
          keywords: { $seen: true },
        })}
      />,
    )
    expect(screen.getByText('Alice Adams')).toBeInTheDocument()
    expect(screen.getByText('Hello there')).toBeInTheDocument()
    expect(screen.getByText('A short preview')).toBeInTheDocument()
    expect(screen.getByRole('row')).toHaveAttribute('aria-selected', 'false')
  })

  it('falls back to the email address, then a no-sender / no-subject label', () => {
    grid(<MessageRow {...baseProps} email={row({ from: null, subject: null, keywords: {} })} />)
    expect(screen.getByText('(No sender)')).toBeInTheDocument()
    expect(screen.getByText('(No subject)')).toBeInTheDocument()
  })

  it('announces unread / flagged / attachment / answered indicators', () => {
    grid(
      <MessageRow
        {...baseProps}
        email={row({ keywords: { $flagged: true, $answered: true }, hasAttachment: true })}
      />,
    )
    // $seen absent → unread
    expect(screen.getByText('Unread')).toBeInTheDocument()
    expect(screen.getByText('Flagged')).toBeInTheDocument()
    expect(screen.getByText('Has attachment')).toBeInTheDocument()
    expect(screen.getByText('Answered')).toBeInTheDocument()
  })

  it('renders a skeleton (decorative cells) for a not-yet-hydrated row, keeping its grid position', () => {
    grid(<MessageRow {...baseProps} rowIndex={7} email={undefined} />)
    const rowEl = screen.getByRole('row')
    expect(rowEl).toHaveAttribute('aria-rowindex', '7')
    expect(rowEl).toHaveAttribute('aria-selected', 'false')
    // The decorative skeleton content is hidden from assistive tech.
    expect(screen.queryByRole('gridcell')).toBeNull()
  })

  it('carries its absolute aria-rowindex', () => {
    grid(<MessageRow {...baseProps} rowIndex={42} email={row({ keywords: { $seen: true } })} />)
    expect(screen.getByRole('row')).toHaveAttribute('aria-rowindex', '42')
  })

  it('marks the active row aria-current and a selected row aria-selected', () => {
    grid(<MessageRow {...baseProps} email={row({ keywords: { $seen: true } })} active selected />)
    const rowEl = screen.getByRole('row')
    expect(rowEl).toHaveAttribute('aria-current', 'page')
    expect(rowEl).toHaveAttribute('aria-selected', 'true')
  })

  it('opens on a plain click but not when the checkbox is clicked', async () => {
    const onOpen = vi.fn()
    const onSelectToggle = vi.fn()
    grid(
      <MessageRow
        {...baseProps}
        email={row({ keywords: { $seen: true } })}
        onOpen={onOpen}
        onSelectToggle={onSelectToggle}
      />,
    )
    screen.getByRole('row').click()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('renders label swatches for custom keywords with accessible names', () => {
    grid(
      <MessageRow
        {...baseProps}
        email={row({ keywords: { $seen: true, work: true, receipts: true } })}
        labels={new Map([['work', { name: 'Work', color: 'red' }]])}
      />,
    )
    // Registered keyword shows its display name; a discovered one falls back to the bare keyword.
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('receipts')).toBeInTheDocument()
  })

  it('caps the visible swatches per density and announces the overflow', () => {
    grid(
      <MessageRow
        {...baseProps}
        density="comfortable"
        email={row({ keywords: { a: true, b: true, c: true, d: true, e: true } })}
      />,
    )
    expect(screen.getByText('+2')).toBeInTheDocument() // 5 custom keywords, 3 shown
    expect(screen.getByText('2 more labels')).toBeInTheDocument()
  })

  it('has no axe violations in a grid', async () => {
    const { container } = grid(
      <div role="rowgroup">
        <MessageRow {...baseProps} email={row({ keywords: { $seen: true } })} />
      </div>,
    )
    await expectNoA11yViolations(container)
  })
})

describe('the roving row is visible, not just announced (M4.7, WCAG 2.4.7)', () => {
  it('marks the focused row, and does not confuse it with selected or open', () => {
    // The grid keeps focus on its scroller and moves `aria-activedescendant`, so a screen reader is
    // told which row is current. Before this, a SIGHTED keyboard user was not: j/k changed nothing
    // on screen unless the row happened to also be checked or open. The three states are
    // independent — this pins that they render independently too.
    const { container, rerender } = grid(
      <MessageRow {...baseProps} email={row()} focused={true} selected={false} active={false} />,
    )
    const rendered = container.querySelector('[role="row"]')
    const focusedClass = rendered?.className.split(' ').find((c) => c.includes('rowFocused'))
    expect(focusedClass, 'a focused row carries its own class').toBeDefined()

    rerender(
      <div role="grid">
        <MessageRow {...baseProps} email={row()} focused={false} selected={true} active={true} />
      </div>,
    )
    const other = container.querySelector('[role="row"]')
    expect(other?.className).not.toContain('rowFocused')
    // …and the two states it must not be mistaken for are still expressed.
    expect(other?.getAttribute('aria-selected')).toBe('true')
    expect(other?.getAttribute('aria-current')).toBe('page')
  })
})
