/**
 * The onboarding container's one piece of logic: WHEN the app offers to delete itself (U2).
 *
 * A start-up can fail in a way that no retry fixes — stale local state was the observed case, with
 * no failed request anywhere — and the sign-in screen then offers nothing but the button that has
 * just failed. The escape hatch exists for exactly that, which is also why it must not appear
 * under a mistyped password: there it would invite someone to throw away their offline mail to fix
 * a typo.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { JmapProblemError } from '@waxwing/jmap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type WaxwingConfig } from '../config'
import { ConfigProvider } from '../config-context'
import { ServicesProvider } from '../services'
import { SessionContext } from '../session/context'
import { SessionProvider } from '../session/SessionProvider'
import { makeFakeServices } from '../session/test-fakes'
import type { OnboardError, SessionContextValue } from '../session/types'
import { Onboarding } from './Onboarding'

afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

function renderOnboarding(error: OnboardError | null) {
  const wipeLocalState = vi.fn()
  const value = {
    status: 'onboarding',
    onboarding: {
      step: 'connect',
      target: null,
      methods: [],
      oauthAvailable: false,
      canEditServer: true,
      busy: false,
      error,
    },
    connected: null,
    reauth: null,
    submitConnect: vi.fn(),
    chooseOAuth: vi.fn(),
    submitBasic: vi.fn(),
    editServer: vi.fn(),
    reportAuthExpired: vi.fn(),
    resolveReauthOAuth: vi.fn(),
    resolveReauthBasic: vi.fn(),
    cancelReauth: vi.fn(),
    signOut: vi.fn(),
    signOutAndWipe: vi.fn(),
    wipeLocalState,
    getClient: () => null,
    getAuthProvider: () => null,
  } satisfies SessionContextValue

  render(
    <ConfigProvider config={DEFAULT_CONFIG}>
      <SessionContext.Provider value={value}>
        <Onboarding />
      </SessionContext.Provider>
    </ConfigProvider>,
  )
  return { wipeLocalState }
}

const RESET = /Reset this app on this device/

describe('the local-reset escape hatch', () => {
  it('is absent while nothing has gone wrong', () => {
    renderOnboarding(null)
    expect(screen.queryByRole('button', { name: RESET })).not.toBeInTheDocument()
  })

  it('is absent under a rejected credential — that is a typo, not a wedged app', () => {
    renderOnboarding({ key: 'auth.error.invalidCredentialsBasic' })
    expect(screen.queryByRole('button', { name: RESET })).not.toBeInTheDocument()
  })

  it('appears under an error nobody can act on, and wipes only after being told what it does', async () => {
    const user = userEvent.setup()
    const { wipeLocalState } = renderOnboarding({ key: 'onboarding.error.generic' })

    await user.click(screen.getByRole('button', { name: RESET }))
    // The sentence has to arrive BEFORE the click that cannot be undone.
    expect(screen.getByText(/deletes everything/i)).toBeInTheDocument()
    expect(wipeLocalState).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete and reload' }))
    expect(wipeLocalState).toHaveBeenCalledTimes(1)
  })

  it('appears under the misconfigured-origin refusal, which is the case with no other way out', () => {
    renderOnboarding({
      key: 'onboarding.error.sessionOrigin',
      values: { field: 'apiUrl', url: 'https://elsewhere.test/jmap', origin: 'https://mail.test' },
    })
    expect(screen.getByRole('button', { name: RESET })).toBeInTheDocument()
  })
})

/**
 * The same question asked of the WHOLE chain, because the exclusion list above is a list of KEYS
 * and nothing in that test makes the keys (U2).
 *
 * `Onboarding` withholds the escape hatch by matching `auth.error.invalidCredentials*`, and the
 * unit tests above hand those keys in directly — so the screen was green while a real refused
 * password produced `onboarding.error.generic` and the offer to delete the mailbox appeared under
 * a typo. What was missing was never the list; it was the mapping that feeds it. These two drive
 * `SessionProvider` for real, from a failing `connect()` to the rendered screen, and the pair is
 * the actual claim: the offer appears for the failure that has no other way out, and for no other.
 */
describe('the escape hatch against a real failure, not against a key (U2)', () => {
  /** A deployment whose only method is a password, so the form is open rather than disclosed. */
  const BASIC_ONLY: WaxwingConfig = {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, auth: ['basic'] },
  }

  async function signIn(connectError: Error) {
    const fake = makeFakeServices({ probePresent: true, connectError })
    render(
      <ServicesProvider value={fake.services}>
        <ConfigProvider config={BASIC_ONLY}>
          <SessionProvider config={BASIC_ONLY}>
            <Onboarding />
          </SessionProvider>
        </ConfigProvider>
      </ServicesProvider>,
    )
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Username'), 'alice@waxwing.test')
    await user.type(screen.getByLabelText('Password'), 'not-my-password')
    await user.click(screen.getByRole('button', { name: 'Sign in with a password' }))
  }

  it('says the credentials were refused, and offers no reset, when the server sends 401', async () => {
    /*
     * The body is what makes this a regression test rather than a restatement.
     *
     * Stalwart answers a refused password with an RFC 7807 problem document, so
     * `errorFromResponse` builds a `JmapProblemError` — not a `JmapHttpError`, which it is not a
     * subclass of. The old `instanceof JmapHttpError` check in `errToOnboard` therefore missed
     * every real 401 and fell through to "Something went wrong", which is not on the exclusion
     * list, which put "Reset this app on this device" under a typo.
     */
    await signIn(new JmapProblemError({ type: 'about:blank', detail: 'Unauthorized' }, 401))

    expect(await screen.findByText(/Wrong username or password/)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: RESET })).not.toBeInTheDocument(),
    )
  })

  it('still offers the reset when the app itself could not start', async () => {
    // The failure the hatch exists for: no status, nothing named, and the button that just failed
    // is the only other thing on screen.
    await signIn(new Error('boot failed'))

    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: RESET })).toBeInTheDocument()
  })
})
