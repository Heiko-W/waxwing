/**
 * The re-auth overlay's dismissal behaviour (FR-AUTH-06, SECURITY.md §3).
 *
 * The dialog appears unannounced over whatever the reader was doing, when the session expires
 * mid-read or mid-write. Escape and the ✕ labelled "Close" — the two gestures everyone uses to
 * mean "never mind" — were wired to `cancelReauth`, which is Sign out; for a public-computer
 * session that additionally wipes the local copy of the mailbox. The body text directly above them
 * says "your place is kept".
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../../test/axe'
import { SessionContext } from '../session/context'
import type { SessionContextValue } from '../session/types'
import { ReauthDialog } from './ReauthDialog'

function renderReauth(method: 'oauth' | 'basic') {
  const cancelReauth = vi.fn()
  const resolveReauthOAuth = vi.fn()
  const resolveReauthBasic = vi.fn()
  const value = {
    status: 'ready',
    onboarding: null,
    connected: null,
    reauth: { method, requiresRedirect: method === 'oauth', busy: false, error: null },
    cancelReauth,
    resolveReauthOAuth,
    resolveReauthBasic,
  } as unknown as SessionContextValue
  render(
    <SessionContext.Provider value={value}>
      <ReauthDialog />
    </SessionContext.Provider>,
  )
  return { cancelReauth, resolveReauthOAuth, resolveReauthBasic }
}

describe('ReauthDialog — the only way out is a labelled button', () => {
  it('does not sign out on Escape', async () => {
    const { cancelReauth } = renderReauth('oauth')

    await userEvent.setup().keyboard('{Escape}')

    expect(cancelReauth).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('offers no "Close" button that would sign out', () => {
    renderReauth('oauth')

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('does not sign out on Escape in the Basic variant either', async () => {
    // The inline-credentials variant is where typing is in flight, so a reflex Escape is likelier.
    const { cancelReauth } = renderReauth('basic')

    await userEvent.setup().keyboard('{Escape}')

    expect(cancelReauth).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('signs out from the button that says Sign out — the counter-test', async () => {
    const { cancelReauth } = renderReauth('oauth')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }))

    expect(cancelReauth).toHaveBeenCalledTimes(1)
  })

  it('opens with focus on "Sign in", not on the destructive button next to it', () => {
    // With the ✕ gone, "Sign out" is the first focusable in DOM order — and this dialog arrives
    // unannounced, so the next reflex Enter must not be the one that ends the session.
    renderReauth('oauth')

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sign in' }))
  })

  it('has no accessibility violations while open', async () => {
    renderReauth('basic')

    await expectNoA11yViolations(document.body)
  })
})
