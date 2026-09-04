import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../../test/axe'
import { ConnectForm } from './ConnectForm'

describe('ConnectForm', () => {
  it('renders the branded welcome without a hardcoded product name', () => {
    render(<ConnectForm productName="Acme Mail" busy={false} onSubmit={vi.fn()} />)

    expect(screen.getByRole('heading', { name: /Acme Mail/ })).toBeInTheDocument()
    expect(screen.queryByText(/Waxwing/)).toBeNull()
  })

  it('submits the trimmed email or server value', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ConnectForm productName="Acme Mail" busy={false} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Email address or server'), '  alice@example.com  ')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(onSubmit).toHaveBeenCalledWith('alice@example.com')
  })

  it('shows a localized, interpolated error and marks the input invalid', () => {
    render(
      <ConnectForm
        productName="Acme Mail"
        busy={false}
        error={{ key: 'onboarding.error.discovery', values: { domain: 'example.com' } }}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('No mail server was found for example.com.')).toBeInTheDocument()
    expect(screen.getByLabelText('Email address or server')).toHaveAttribute('aria-invalid', 'true')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ConnectForm productName="Acme Mail" busy={false} onSubmit={vi.fn()} />,
    )
    await expectNoA11yViolations(container)
  })
})

/**
 * Offline this screen asks for a server it cannot check (FR-OFF-01). Before the offline cold start
 * landed you mostly got here by signing out, which happens while connected; now it is a normal way
 * to arrive, and a Continue button that silently does nothing would be the worst of the options.
 */
describe('ConnectForm — offline', () => {
  it('says why Continue cannot work, in words on the screen', () => {
    render(<ConnectForm productName="Acme Mail" busy={false} offline onSubmit={vi.fn()} />)

    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    // Named by the control, so a screen reader reaches it from the button — and VISIBLE, because
    // a statement nobody can read is not a statement.
    const noteId = button.getAttribute('aria-describedby')
    expect(noteId).not.toBeNull()
    const note = document.getElementById(noteId as string)
    expect(note).toBeVisible()
    expect(note?.textContent ?? '').toMatch(/offline/i)
  })

  it('does not submit — not from the button, and not from Return in the field', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ConnectForm productName="Acme Mail" busy={false} offline onSubmit={onSubmit} />)

    const field = screen.getByLabelText('Email address or server')
    await user.type(field, 'alice@example.com')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    // The second half is the one the button alone cannot cover: implicit submission.
    await user.type(field, '{Enter}')

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('is silent about it while connected', () => {
    render(<ConnectForm productName="Acme Mail" busy={false} onSubmit={vi.fn()} />)

    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(screen.queryByText(/offline/i)).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ConnectForm productName="Acme Mail" busy={false} offline onSubmit={vi.fn()} />,
    )
    await expectNoA11yViolations(container)
  })
})
