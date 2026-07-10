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
