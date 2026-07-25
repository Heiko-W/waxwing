import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_LIST_STATE, useListStore } from '../../mail/list-store'
import { useReadingStore } from '../../mail/reading-store'
import { usePaletteUi } from '../../shortcuts'
import { DEFAULT_CONFIG, type WaxwingConfig } from '../config'
import { ServicesProvider } from '../services'
import { useSession } from './context'
import { SessionProvider } from './SessionProvider'
import {
  type FakeServicesOptions,
  fakeAuthSession,
  fakeJmapSession,
  makeFakeServices,
} from './test-fakes'

function Consumer() {
  const s = useSession()
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="step">{s.onboarding?.step ?? 'none'}</span>
      <span data-testid="reauth">{s.reauth?.method ?? 'none'}</span>
      <span data-testid="account">{s.connected?.username ?? ''}</span>
      <span data-testid="accounts">{s.connected?.accounts.map((a) => a.id).join(',') ?? ''}</span>
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
  useListStore.setState(EMPTY_LIST_STATE)
  useReadingStore.setState({ handlers: null })
  usePaletteUi.getState().closeOverlays()
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

  it('lifts delegated mail accounts into the connected session, own first (M4.4)', async () => {
    const user = userEvent.setup()
    renderSession({
      probePresent: true,
      session: fakeJmapSession('acc-1', 'alice@waxwing.test', {
        shared: [
          { id: 'shared-1', name: 'team@waxwing.test', isReadOnly: true },
          // A contacts-only share must NOT be lifted into the mail-account list.
          { id: 'cal-1', name: 'calendars@waxwing.test', mail: false },
        ],
      }),
    })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    await user.click(screen.getByText('basic'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    // Own account first, then the mail-capable share; the calendars-only share is excluded.
    expect(screen.getByTestId('accounts').textContent).toBe('acc-1,shared-1')
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

  /**
   * Sign-out is an in-SPA transition: the module graph survives it, so every module-scoped singleton
   * the previous account touched is still loaded. The keyboard layer's stores (M3.8) hold that
   * account's list window — its selected email ids, its roving row, the open message's handlers.
   * JMAP ids are per-account and short (Stalwart hands out `a`, `b`, …) and the window key carries no
   * account id, so account B's Inbox window can be byte-identical to account A's: the selection would
   * survive the switch and one `e` would dispatch a move for account A's ids under account B.
   */
  it('resets the module-scoped keyboard state on sign-out (no cross-account carry-over)', async () => {
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    await user.click(screen.getByText('basic'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    act(() => {
      useListStore.getState().setWindow('inbox|date', ['e1', 'e2'], 'inbox')
      useListStore.getState().select({ type: 'toggle', id: 'e1' })
      useReadingStore.getState().set({
        emailId: 'e1',
        mailboxId: 'inbox',
        bodyReady: true,
        compose: () => {},
        archive: () => true,
        junk: () => true,
        trash: () => true,
        toggleFlag: () => {},
        markUnread: () => {},
        openMove: () => {},
        openLabels: () => {},
        requestDelete: () => {},
      })
      usePaletteUi.getState().openPalette()
    })

    await user.click(screen.getByText('signout'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('onboarding'))

    await waitFor(() => expect(useListStore.getState().ids).toEqual([]))
    expect(useListStore.getState().selection.selected.size).toBe(0)
    expect(useListStore.getState().windowKey).toBe('')
    expect(useListStore.getState().sourceMailboxId).toBeNull()
    expect(useReadingStore.getState().handlers).toBeNull()
    expect(usePaletteUi.getState().paletteOpen).toBe(false)
  })
})
