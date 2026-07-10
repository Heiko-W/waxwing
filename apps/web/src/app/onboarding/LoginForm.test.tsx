import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../../test/axe'
import type { ConnectTarget } from '../session/types'
import { LoginForm } from './LoginForm'

const target: ConnectTarget = {
  connectUrl: 'https://mail.example.com',
  issuer: 'https://mail.example.com',
  displayHost: 'mail.example.com',
  fromProbe: false,
}

describe('LoginForm', () => {
  it('shows the target host and triggers OAuth when available', async () => {
    const user = userEvent.setup()
    const onOAuth = vi.fn()
    render(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['oauth', 'basic']}
        oauthAvailable
        canEditServer={false}
        busy={false}
        onOAuth={onOAuth}
        onBasicSubmit={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Sign in to mail.example.com' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign in securely' }))
    expect(onOAuth).toHaveBeenCalledTimes(1)
  })

  it('disables OAuth with an explanation on an insecure origin', async () => {
    const user = userEvent.setup()
    const onOAuth = vi.fn()
    render(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['oauth', 'basic']}
        oauthAvailable={false}
        canEditServer={false}
        busy={false}
        onOAuth={onOAuth}
        onBasicSubmit={vi.fn()}
      />,
    )

    const oauth = screen.getByRole('button', { name: 'Sign in securely' })
    expect(oauth).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/Secure sign-in needs an HTTPS connection/)).toBeInTheDocument()

    await user.click(oauth)
    expect(onOAuth).not.toHaveBeenCalled()
  })

  it('submits the Basic credentials with the stay-signed-in choice', async () => {
    const user = userEvent.setup()
    const onBasicSubmit = vi.fn()
    render(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['oauth', 'basic']}
        oauthAvailable
        canEditServer={false}
        busy={false}
        onOAuth={vi.fn()}
        onBasicSubmit={onBasicSubmit}
      />,
    )

    await user.type(screen.getByLabelText('Username'), 'alice')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByLabelText('Stay signed in'))
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(onBasicSubmit).toHaveBeenCalledWith('alice', 'secret', true)
  })

  it('offers a back link only when the server is editable', async () => {
    const user = userEvent.setup()
    const onBack = vi.fn()
    const { rerender } = render(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['basic']}
        oauthAvailable
        canEditServer
        busy={false}
        onOAuth={vi.fn()}
        onBasicSubmit={vi.fn()}
        onBack={onBack}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Use a different server' }))
    expect(onBack).toHaveBeenCalledTimes(1)

    rerender(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['basic']}
        oauthAvailable
        canEditServer={false}
        busy={false}
        onOAuth={vi.fn()}
        onBasicSubmit={vi.fn()}
        onBack={onBack}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Use a different server' })).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['oauth', 'basic']}
        oauthAvailable
        canEditServer
        busy={false}
        onOAuth={vi.fn()}
        onBasicSubmit={vi.fn()}
        onBack={vi.fn()}
      />,
    )
    await expectNoA11yViolations(container)
  })
})
