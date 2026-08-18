import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthConfigError } from '../../auth'
import { EMPTY_LIST_STATE, useListStore } from '../../mail/list-store'
import { useReadingStore } from '../../mail/reading-store'
import { usePaletteUi } from '../../shortcuts'
import {
  currentReplicaName,
  EPHEMERAL_DB_PREFIX,
  getReplica,
  REPLICA_DB_NAME,
  resetReplicaForTests,
} from '../../sync'
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
      <button type="button" onClick={() => s.submitBasic('alice', 'pw', false, true)}>
        basic-public
      </button>
      <button type="button" onClick={() => s.chooseOAuth(true)}>
        oauth-public
      </button>
      <button type="button" onClick={() => s.chooseOAuth()}>
        oauth-plain
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
  resetReplicaForTests()
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

  it('names the host it could not reach, instead of blaming the connection', async () => {
    // A failed fetch is a TypeError. The message used to be "check your connection", which is the
    // wrong advice for the common case: Waxwing guesses the server from the email domain, so the
    // connection is fine and the ADDRESS is wrong. The host is the one fact that lets a reader fix
    // it, and the server field is right above the error.
    const user = userEvent.setup()
    renderSession({ probePresent: true, connectError: new TypeError('Failed to fetch') })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic'))

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('onboarding.error.networkHost'),
    )
  })

  it('says the server has no OAuth rather than "something went wrong" (FR-SRV-02)', async () => {
    // The sign-in screen offers whatever config.server.auth lists; the server is never asked. On a
    // deployment without OAuth the primary button therefore throws AuthConfigError on click, and
    // the reader used to get "Something went wrong. Please try again." — advice that repeats the
    // same failure forever. Basic is enabled here, so the message points at it.
    const user = userEvent.setup()
    renderSession({ startLoginError: new AuthConfigError('no discovery document') })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('oauth-plain'))

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('onboarding.error.oauthUnavailable'),
    )
  })

  it('does not point at a password form the deployment has disabled', async () => {
    const user = userEvent.setup()
    renderSession(
      { startLoginError: new AuthConfigError('no discovery document') },
      {
        ...DEFAULT_CONFIG,
        server: { ...DEFAULT_CONFIG.server, auth: ['oauth'] },
      },
    )
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('oauth-plain'))

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent(
        'onboarding.error.oauthUnavailableNoFallback',
      ),
    )
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

/**
 * Public-computer mode at the session level (FR-AUTH-09).
 *
 * The unit tests around `sync/ephemeral.ts` cover the sweep and the naming; these cover the wiring,
 * which is where the mode was actually broken: the choice reached the Basic path only, so on the
 * shipped default config — where OAuth is the primary button — it did nothing at all.
 */
describe('SessionProvider — public-computer mode', () => {
  it('routes a Basic sign-in into a throwaway replica', async () => {
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic-public'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    expect(currentReplicaName().startsWith(EPHEMERAL_DB_PREFIX)).toBe(true)
  })

  it('carries the choice through the OAuth redirect, on BOTH halves', async () => {
    // Two halves with different owners, and each is load-bearing: the controller needs the flag to
    // keep the refresh token out of storage, and this component needs it to name the replica when
    // the callback lands. A full-page redirect destroys every ref in between, so the app half rides
    // in sessionStorage and the auth half rides inside the PKCE transaction.
    const user = userEvent.setup()
    const fake = renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('oauth-public'))

    await waitFor(() =>
      expect(fake.spies.startLogin).toHaveBeenCalledWith({ method: 'oauth', publicComputer: true }),
    )
    expect(sessionStorage.getItem('waxwing.onboard.publicComputer')).toBe('true')
  })

  it('leaves an ordinary OAuth sign-in durable — the counter-test', async () => {
    const user = userEvent.setup()
    const fake = renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('oauth-plain'))

    await waitFor(() =>
      expect(fake.spies.startLogin).toHaveBeenCalledWith({
        method: 'oauth',
        publicComputer: false,
      }),
    )
    expect(sessionStorage.getItem('waxwing.onboard.publicComputer')).toBeNull()
  })

  it('names the replica BEFORE connecting when the callback comes back', async () => {
    // Ordering is the whole fix here. `setReplicaName` throws once the replica is open, and the
    // first `getReplica()` happens as the session goes ready — so if this ran after connect, the
    // public-computer session would have written its mail into the durable database already.
    sessionStorage.setItem('waxwing.onboard.publicComputer', 'true')
    renderSession({ isRedirectCallback: true })

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(currentReplicaName().startsWith(EPHEMERAL_DB_PREFIX)).toBe(true)
    // Single-use: a later ordinary sign-in must not inherit it.
    expect(sessionStorage.getItem('waxwing.onboard.publicComputer')).toBeNull()
  })

  it('an ordinary callback stays on the durable replica — the counter-test', async () => {
    renderSession({ isRedirectCallback: true })

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(currentReplicaName()).toBe(REPLICA_DB_NAME)
  })

  it('sign-out puts the next session back on the durable replica', async () => {
    // Both directions used to leak. The name survived sign-out, so the NEXT ordinary sign-in wrote
    // into a throwaway database that the following startup sweep deleted; and `sharedDb` survived
    // too, so `setReplicaName` threw for the next public-computer sign-in — the mode became
    // unavailable for the rest of the page load, reported only as a generic connection error.
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic-public'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    // Open it, the way the sync engine does once a session is ready.
    getReplica()
    expect(currentReplicaName().startsWith(EPHEMERAL_DB_PREFIX)).toBe(true)

    await user.click(screen.getByText('signout'))
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    expect(currentReplicaName()).toBe(REPLICA_DB_NAME)

    // And the mode still works afterwards — this is the half that threw.
    await user.click(screen.getByText('basic-public'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(currentReplicaName().startsWith(EPHEMERAL_DB_PREFIX)).toBe(true)
    expect(screen.getByTestId('error')).toHaveTextContent('')
  })

  it('reports a failed data wipe instead of showing a clean login form', async () => {
    // A rejected logout means the credential store is still on disk — another connection blocked
    // the delete. That outcome used to be swallowed by `.catch(() => {})` and followed by an
    // unconditional login screen, which is exactly the impression the user must not be given.
    const user = userEvent.setup()
    const fake = renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    await user.click(screen.getByText('basic'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    fake.spies.logout.mockRejectedValueOnce(new Error('another connection is holding it open'))
    await user.click(screen.getByText('signout'))

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('auth.error.signOutIncomplete'),
    )
  })
})

describe('SessionProvider — the boot path cannot hang', () => {
  it('renders a login step even when the configured server URL is unusable', async () => {
    // `config.ts` now rejects an unparseable `sessionUrl` before it reaches here, so this config is
    // constructed by hand — on purpose. The defect was never the bad value; it was that `boot()`'s
    // only error handler called the very function that had just thrown, so the second throw escaped
    // as an unhandled rejection out of `void boot()`. React error boundaries do not see async
    // rejections, so nothing rendered: the app sat on `status: 'booting'` — a spinner, forever.
    const broken: WaxwingConfig = {
      ...DEFAULT_CONFIG,
      server: { ...DEFAULT_CONFIG.server, sessionUrl: 'mail.example.com/.well-known/jmap' },
    }

    renderSession({ probePresent: true }, broken)

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('onboarding'))
    expect(screen.getByTestId('step')).toHaveTextContent('login')
  })
})
