import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type WaxwingConfig } from '../config'
import { ServicesProvider } from '../services'
import { useSession } from './context'
import { SessionProvider } from './SessionProvider'
import { type FakeServicesOptions, fakeAuthSession, makeFakeServices } from './test-fakes'

function Consumer() {
  const s = useSession()
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="step">{s.onboarding?.step ?? 'none'}</span>
      <span data-testid="reauth">{s.reauth?.method ?? 'none'}</span>
      <span data-testid="account">{s.connected?.username ?? ''}</span>
      <span data-testid="error">{s.onboarding?.error?.key ?? ''}</span>
      <button type="button" onClick={() => s.submitBasic('alice', 'pw', true)}>
        basic
      </button>
      <button type="button" onClick={() => s.reportAuthExpired()}>
        expire
      </button>
      <button type="button" onClick={() => s.resolveReauthBasic('alice', 'pw2')}>
        reauth-basic
      </button>
      <button type="button" onClick={() => s.resolveReauthOAuth()}>
        reauth-oauth
      </button>
      <button type="button" onClick={() => s.signOut()}>
        signout
      </button>
    </div>
  )
}

function renderSession(options: FakeServicesOptions = {}, config: WaxwingConfig = DEFAULT_CONFIG) {
  const fake = makeFakeServices(options)
  render(
    <ServicesProvider value={fake.services}>
      <SessionProvider config={config}>
        <Consumer />
      </SessionProvider>
    </ServicesProvider>,
  )
  return fake
}

afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('SessionProvider', () => {
  it('probes same-origin on boot and lands on the login step (FR-AUTH-01)', async () => {
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(screen.getByTestId('status')).toHaveTextContent('onboarding')
  })

  it('falls back to the manual connect step when no server answers (FR-AUTH-02)', async () => {
    renderSession({ probePresent: false })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('connect'))
  })

  it('signs in with Basic and connects to a ready session', async () => {
    const user = userEvent.setup()
    const fake = renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic'))

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(screen.getByTestId('account')).toHaveTextContent('alice@waxwing.test')
    expect(fake.spies.startLogin).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'basic', username: 'alice' }),
    )
    expect(fake.spies.connect).toHaveBeenCalledTimes(1)
  })

  it('surfaces a connect failure as an onboarding error without leaving the login step', async () => {
    const user = userEvent.setup()
    renderSession({ probePresent: true, connectError: new Error('boom') })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic'))

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('onboarding.error.generic'),
    )
    expect(screen.getByTestId('status')).toHaveTextContent('onboarding')
  })

  it('restores a persisted session on cold boot (FR-AUTH-03)', async () => {
    renderSession({ restore: fakeAuthSession('basic') })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
  })

  it('completes an OAuth redirect callback into a ready session', async () => {
    const fake = renderSession({ isRedirectCallback: true })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(fake.spies.completeRedirect).toHaveBeenCalledTimes(1)
  })

  it('opens a Basic re-auth overlay and reconnects in place (FR-AUTH-06)', async () => {
    const user = userEvent.setup()
    const fake = renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    await user.click(screen.getByText('basic'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    await user.click(screen.getByText('expire'))
    expect(screen.getByTestId('reauth')).toHaveTextContent('basic')
    // Still ready underneath — the shell never unmounts.
    expect(screen.getByTestId('status')).toHaveTextContent('ready')

    await user.click(screen.getByText('reauth-basic'))
    await waitFor(() => expect(screen.getByTestId('reauth')).toHaveTextContent('none'))
    expect(screen.getByTestId('status')).toHaveTextContent('ready')
    // Re-auth preserves the "stay signed in" opt-in (FR-AUTH-04): it must not wipe the
    // persisted credentials by re-logging-in without the flag.
    expect(fake.spies.startLogin).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'basic', staySignedIn: true }),
    )
  })

  it('routes an OAuth re-auth through a full-page redirect', async () => {
    const user = userEvent.setup()
    const fake = renderSession({ isRedirectCallback: true })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    await user.click(screen.getByText('expire'))
    expect(screen.getByTestId('reauth')).toHaveTextContent('oauth')

    await user.click(screen.getByText('reauth-oauth'))
    await waitFor(() => expect(fake.spies.navigate).toHaveBeenCalledWith('oauth'))
  })

  it('signs out back to the login step (FR-AUTH-05)', async () => {
    const user = userEvent.setup()
    const fake = renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    await user.click(screen.getByText('basic'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    await user.click(screen.getByText('signout'))

    await waitFor(() => expect(fake.spies.logout).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('status')).toHaveTextContent('onboarding')
  })
})
