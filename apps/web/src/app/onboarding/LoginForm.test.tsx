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

    // The heading names the MAILBOX's server, which is the only open question on this screen.
    // Branding reaches the reader through the logo and the welcome step instead (FR-THEME-02).
    expect(
      screen.getByRole('heading', { name: 'Webmail for mail.example.com' }),
    ).toBeInTheDocument()
    // And the button says what it will do, because it navigates away to the server's own page.
    expect(screen.getByText(/You sign in on mail\.example\.com itself/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(onOAuth).toHaveBeenCalledTimes(1)
  })

  /**
   * The disclosure is the whole point of the layout: Stalwart accepts a second factor only over
   * OAuth, so an account with 2FA gets its correct password refused by the form below. Presenting
   * both as equals asked the reader to choose between a working flow and a broken one on
   * information they do not have.
   */
  it('keeps the password form collapsed until asked for, and focuses it on open', async () => {
    const user = userEvent.setup()
    render(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['oauth', 'basic']}
        oauthAvailable
        canEditServer={false}
        busy={false}
        onOAuth={vi.fn()}
        onBasicSubmit={vi.fn()}
      />,
    )

    const disclosure = screen.getByRole('button', { name: 'Sign in with a password instead' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()

    await user.click(disclosure)

    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Username')).toHaveFocus()
    // The hint names the server's actual behaviour, and points back to the button that works.
    expect(
      screen.getByText(/use an app password, or sign in through the server above/),
    ).toBeVisible()

    await user.click(disclosure)
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
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

    const oauth = screen.getByRole('button', { name: 'Sign in' })
    expect(oauth).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByText(/Signing in through the server needs an HTTPS connection/),
    ).toBeInTheDocument()
    // …and with OAuth unusable the password form is the way in, so it is NOT hidden behind a
    // disclosure the reader would have to discover.
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Sign in with a password instead' }),
    ).not.toBeInTheDocument()

    await user.click(oauth)
    expect(onOAuth).not.toHaveBeenCalled()
  })

  it('shows the password form outright when the deployment ranks Basic first', () => {
    render(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['basic', 'oauth']}
        oauthAvailable
        canEditServer={false}
        busy={false}
        onOAuth={vi.fn()}
        onBasicSubmit={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Sign in with a password instead' }),
    ).not.toBeInTheDocument()
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

    await user.click(screen.getByRole('button', { name: 'Sign in with a password instead' }))
    await user.type(screen.getByLabelText('Username'), 'alice')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByLabelText('Stay signed in'))
    await user.click(screen.getByRole('button', { name: 'Sign in with a password' }))

    expect(onBasicSubmit).toHaveBeenCalledWith('alice', 'secret', true, false)
  })

  /**
   * FR-AUTH-09. The two boxes make contradictory promises — one leaves a credential behind, the
   * other is about leaving nothing behind — so ticking the public one has to turn the other off
   * AND hold it off. Letting both be ticked would put a refresh token on precisely the machine the
   * user just said was not theirs.
   */
  it('public-computer mode turns "stay signed in" off and keeps it off', async () => {
    const user = userEvent.setup()
    const onBasicSubmit = vi.fn()
    render(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['basic']}
        oauthAvailable={false}
        canEditServer={false}
        busy={false}
        onOAuth={vi.fn()}
        onBasicSubmit={onBasicSubmit}
      />,
    )

    const stay = screen.getByLabelText('Stay signed in')
    await user.click(stay)
    expect(stay).toBeChecked()

    await user.click(screen.getByLabelText('Public or shared computer'))

    expect(stay).not.toBeChecked()
    expect(stay).toBeDisabled()
    // …and the warning names what this does and does not do, using the hoster's product name.
    expect(screen.getByText(/Keeps no mail and no sign-in/)).toHaveTextContent('Acme Mail')

    await user.type(screen.getByLabelText('Username'), 'alice')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Sign in with a password' }))

    expect(onBasicSubmit).toHaveBeenCalledWith('alice', 'secret', false, true)
  })

  it('tells a Basic-only deployment about app passwords without pointing at an absent button', () => {
    render(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['basic']}
        oauthAvailable={false}
        canEditServer={false}
        busy={false}
        onOAuth={vi.fn()}
        onBasicSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText(/use an app password\.$/)).toBeVisible()
    expect(screen.queryByText(/sign in through the server above/)).not.toBeInTheDocument()
  })

  it('carries public-computer mode into the OAUTH path too (FR-AUTH-09)', async () => {
    // The regression this pins is not hypothetical: the checkbox used to live inside the Basic
    // <form> and reach `onBasicSubmit` alone. On the shipped default config OAuth is the PRIMARY
    // button sitting directly above it, so ticking the box and clicking that button produced a
    // durable replica and a persisted refresh token — with the hint underneath still promising
    // that nothing would be kept. A checkbox that governs only one of two buttons is worse than
    // no checkbox, because it is believed.
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

    await user.click(screen.getByLabelText('Public or shared computer'))
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(onOAuth).toHaveBeenCalledWith(true)
  })

  it('leaves the OAuth path durable when the box is not ticked', async () => {
    // The counter-test: the flag must be the user's choice, not a constant. Without this, a fix
    // that simply passed `true` everywhere would look identical to the test above.
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

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(onOAuth).toHaveBeenCalledWith(false)
  })

  it('offers the public-computer option even when the server allows OAuth ONLY', () => {
    // `auth: ["oauth"]` is a supported deployment, and it renders no Basic form at all — which is
    // where the option used to live, so FR-AUTH-09 simply did not exist on such a server.
    render(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['oauth']}
        oauthAvailable
        canEditServer={false}
        busy={false}
        onOAuth={vi.fn()}
        onBasicSubmit={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Public or shared computer')).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Sign in with a password instead' }),
    ).not.toBeInTheDocument()
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

  /**
   * B12: the heading names the host, so the brand has to reach the reader some other way — or a
   * white-label deployment is unbranded on the one screen where the user decides whether they are
   * in the right place (FR-DEP-04). The alt text is the configured name, never "Waxwing".
   */
  it('carries the hoster branding as a logo, and omits it when none is configured', () => {
    const { rerender } = render(
      <LoginForm
        target={target}
        productName="Acme Mail"
        logoSrc="https://mail.example.com/webmail/branding/acme.svg"
        methods={['oauth', 'basic']}
        oauthAvailable
        canEditServer={false}
        busy={false}
        onOAuth={vi.fn()}
        onBasicSubmit={vi.fn()}
      />,
    )

    const logo = screen.getByRole('img', { name: 'Acme Mail' })
    expect(logo).toHaveAttribute('src', 'https://mail.example.com/webmail/branding/acme.svg')

    rerender(
      <LoginForm
        target={target}
        productName="Acme Mail"
        methods={['oauth', 'basic']}
        oauthAvailable
        canEditServer={false}
        busy={false}
        onOAuth={vi.fn()}
        onBasicSubmit={vi.fn()}
      />,
    )
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
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

  it('has no accessibility violations with the password form open', async () => {
    const user = userEvent.setup()
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

    await user.click(screen.getByRole('button', { name: 'Sign in with a password instead' }))
    await expectNoA11yViolations(container)
  })
})
