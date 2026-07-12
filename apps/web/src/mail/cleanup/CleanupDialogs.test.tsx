import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../app/config'
import { ConfigProvider } from '../../app/config-context'
import { type MailboxRow, toMailboxRow } from '../../sync'
import { mailbox } from '../../sync/test-utils'
import { expectNoA11yViolations } from '../../test/axe'
import { DeleteOlderDialog, EmptyFolderDialog } from './CleanupDialogs'

function box(over: Parameters<typeof mailbox>[1] = {}): MailboxRow {
  return toMailboxRow('a', mailbox('trash', { name: 'Trash', role: 'trash', ...over }))
}

function withConfig(node: ReactNode) {
  return <ConfigProvider config={DEFAULT_CONFIG}>{node}</ConfigProvider>
}

describe('EmptyFolderDialog', () => {
  it('shows the message count and a static retention caution, then confirms', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      withConfig(
        <EmptyFolderDialog
          mailbox={box({ totalEmails: 5 })}
          onClose={() => {}}
          onConfirm={onConfirm}
        />,
      ),
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('5')
    expect(screen.getByText(/deletes these on the server/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Empty folder' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('has no axe violations', async () => {
    render(
      withConfig(
        <EmptyFolderDialog
          mailbox={box({ totalEmails: 2 })}
          onClose={() => {}}
          onConfirm={() => {}}
        />,
      ),
    )
    await expectNoA11yViolations(document.body)
  })
})

describe('DeleteOlderDialog', () => {
  it('destroy mode: warns permanent, defaults to 30, confirms a valid day count', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      withConfig(
        <DeleteOlderDialog
          mode="destroy"
          mailbox={box()}
          onClose={() => {}}
          onConfirm={onConfirm}
        />,
      ),
    )
    const input = screen.getByLabelText(/older than/i)
    expect(input).toHaveValue(30)
    expect(screen.getByText(/permanently delete/i)).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, '7')
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }))
    expect(onConfirm).toHaveBeenCalledWith(7)
  })

  it('trash mode: confirms as a recoverable move to Trash', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      withConfig(
        <DeleteOlderDialog
          mode="trash"
          mailbox={box({ name: 'Inbox', role: 'inbox' })}
          onClose={() => {}}
          onConfirm={onConfirm}
        />,
      ),
    )
    expect(screen.getByText(/to the trash/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }))
    expect(onConfirm).toHaveBeenCalledWith(30)
  })

  it('rejects an empty, non-positive, or over-cap day count', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      withConfig(
        <DeleteOlderDialog
          mode="destroy"
          mailbox={box()}
          onClose={() => {}}
          onConfirm={onConfirm}
        />,
      ),
    )
    const input = screen.getByLabelText(/older than/i)
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByText(/number of days/i)).toBeInTheDocument()
    // Over the 3650-day cap is rejected too (guards daysAgoIso against an out-of-range Date).
    await user.type(input, '99999')
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
