/**
 * The onboarding container's one piece of logic: WHEN the app offers to delete itself (U2).
 *
 * A start-up can fail in a way that no retry fixes — stale local state was the observed case, with
 * no failed request anywhere — and the sign-in screen then offers nothing but the button that has
 * just failed. The escape hatch exists for exactly that, which is also why it must not appear
 * under a mistyped password: there it would invite someone to throw away their offline mail to fix
 * a typo.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../config'
import { ConfigProvider } from '../config-context'
import { SessionContext } from '../session/context'
import type { OnboardError, SessionContextValue } from '../session/types'
import { Onboarding } from './Onboarding'

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
