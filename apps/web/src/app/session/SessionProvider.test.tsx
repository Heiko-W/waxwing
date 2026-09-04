import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { JmapProblemError, JmapSessionOriginError } from '@waxwing/jmap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthConfigError, OAuthCallbackError } from '../../auth'
import { getInlineObjectUrl, putInlineObjectUrl, useComposerStore } from '../../compose'
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
import { NO_RESET_ERROR_KEYS } from '../onboarding/Onboarding'
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
      <span data-testid="offline">{String(s.connected?.offline ?? false)}</span>
      <span data-testid="error">{s.onboarding?.error?.key ?? ''}</span>
      <span data-testid="host">{s.onboarding?.target?.displayHost ?? ''}</span>
      <span data-testid="can-edit-server">{String(s.onboarding?.canEditServer ?? false)}</span>
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
      <button type="button" onClick={() => s.wipeLocalState()}>
        wipe-local
      </button>
    </div>
  )
}

function renderSession(options: FakeServicesOptions = {}, config: WaxwingConfig = DEFAULT_CONFIG) {
  const fake = makeFakeServices(options)
  mountSession(fake, config)
  return fake
}

/**
 * Mount another cold start against services that already exist — a second launch of the same
 * installed app, with whatever the first one left in the credential store (FR-OFF-01).
 */
function mountSession(
  fake: ReturnType<typeof makeFakeServices>,
  config: WaxwingConfig = DEFAULT_CONFIG,
) {
  return render(
    <ServicesProvider value={fake.services}>
      <SessionProvider config={config}>
        <Consumer />
      </SessionProvider>
    </ServicesProvider>,
  )
}

afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  resetReplicaForTests()
  useComposerStore.setState({ drafts: new Map(), focusedId: undefined, uploads: new Map() })
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

  it('reads a 401 out of a JSON problem body too, not only out of a JmapHttpError (U2)', async () => {
    // `errorFromResponse` picks the error class from the SHAPE OF THE BODY: Stalwart answers a
    // refused password with an RFC 7807 document, so it arrives as a `JmapProblemError` — which is
    // NOT a subclass of `JmapHttpError`. The old `instanceof JmapHttpError` check therefore missed
    // every real rejected credential and called it "something went wrong", and the onboarding
    // screen — which withholds its "reset this app" offer by matching the credential keys — put
    // the invitation to delete the local mailbox under a typo.
    const user = userEvent.setup()
    renderSession({
      probePresent: true,
      connectError: new JmapProblemError({ type: 'about:blank', detail: 'Unauthorized' }, 401),
    })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic'))

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('auth.error.invalidCredentialsBasic'),
    )
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
        notJunk: () => true,
        trash: () => true,
        toggleFlag: () => {},
        markUnread: () => {},
        openMove: () => {},
        openLabels: () => {},
        requestDelete: () => {},
        print: () => {},
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

  /**
   * The same defect, one module further (R-03): the composer's drafts, its in-flight uploads and the
   * `blob:` previews of pasted images are module singletons too, and NOTHING on the sign-out path
   * touched them. `AppShell` mounts the composer host as soon as there are drafts, so the next
   * person to sign in on this tab saw the previous person's windows — and the first tab switch
   * flushed them into THEIR Drafts folder on the server. "Sign out and remove data" was no help:
   * that wipe is about IndexedDB and web storage, and none of this is stored.
   *
   * Checked in BOTH modes, because the public-computer promise (FR-AUTH-09) is the stronger one:
   * there, leaving must not depend on the user picking the right menu item at all.
   */
  it.each([
    ['durable', 'basic'],
    ['public-computer', 'basic-public'],
  ])('clears the composer on sign-out (%s)', async (_mode, button) => {
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    await user.click(screen.getByText(button))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    let id = ''
    act(() => {
      id = useComposerStore.getState().openDraft({ subject: 'private to alice' })
      putInlineObjectUrl('cid-1@waxwing.local', 'blob:pasted-screenshot')
      useComposerStore.getState().addUpload(id, {
        tempId: 't1',
        name: 'contract.pdf',
        type: 'application/pdf',
        size: 10,
        inline: false,
        cid: null,
        previewUrl: null,
        status: 'uploading',
        progress: 0,
        error: null,
      })
    })
    expect(useComposerStore.getState().drafts.size).toBe(1)

    await user.click(screen.getByText('signout'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('onboarding'))

    await waitFor(() => expect(useComposerStore.getState().drafts.size).toBe(0))
    expect(useComposerStore.getState().uploads.size).toBe(0)
    expect(getInlineObjectUrl('cid-1@waxwing.local')).toBeNull()
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

  /*
   * A start that THREW leaves a stash nothing will ever consume: no redirect happened. The three
   * keys were cleaned up three different ways — the failed first sign-in removed the
   * public-computer flag only, the failed re-auth removed nothing — which is harmless in effect (a
   * boot that is not a callback drops target and route as stale) and is exactly the shape a fourth
   * key would have inherited from whichever line was copied.
   */
  it.each([
    ['a first sign-in', 'oauth-public', false],
    ['a re-auth', 'reauth-oauth', true],
  ])('leaves no handshake stash behind when %s cannot start', async (_name, button, viaReauth) => {
    const user = userEvent.setup()
    if (viaReauth) sessionStorage.setItem('waxwing.onboard.publicComputer', 'true')
    const fake = renderSession({
      startLoginError: new AuthConfigError('no discovery document'),
      isRedirectCallback: viaReauth,
    })
    if (viaReauth) {
      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
      await user.click(screen.getByText('expire'))
    } else {
      await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    }

    await user.click(screen.getByText(button))

    await waitFor(() => expect(fake.spies.startLogin).toHaveBeenCalled())
    await waitFor(() => {
      expect(sessionStorage.getItem('waxwing.onboard.target')).toBeNull()
      expect(sessionStorage.getItem('waxwing.onboard.route')).toBeNull()
      expect(sessionStorage.getItem('waxwing.onboard.publicComputer')).toBeNull()
    })
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

  /**
   * The one click that used to undo the whole mode. Re-auth is a full-page redirect, so it wipes
   * `ephemeralRef` exactly as the first sign-in does — and the stash had already been spent by the
   * callback that got us here. Without carrying it across, "sign in again" at a shared terminal
   * persisted an AuthRecord and a 30-day refresh token and moved the replica back to its permanent
   * name.
   */
  it('carries public-computer mode through an OAuth RE-auth redirect', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem('waxwing.onboard.publicComputer', 'true')
    const fake = renderSession({ isRedirectCallback: true })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(currentReplicaName().startsWith(EPHEMERAL_DB_PREFIX)).toBe(true)
    // Spent by the callback — the re-auth below has to put it back itself.
    expect(sessionStorage.getItem('waxwing.onboard.publicComputer')).toBeNull()

    await user.click(screen.getByText('expire'))
    await user.click(screen.getByText('reauth-oauth'))

    await waitFor(() =>
      expect(fake.spies.startLogin).toHaveBeenLastCalledWith({
        method: 'oauth',
        publicComputer: true,
      }),
    )
    expect(sessionStorage.getItem('waxwing.onboard.publicComputer')).toBe('true')
  })

  it('leaves a DURABLE session durable through an OAuth re-auth — the counter-test', async () => {
    const user = userEvent.setup()
    const fake = renderSession({ isRedirectCallback: true })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    await user.click(screen.getByText('expire'))
    await user.click(screen.getByText('reauth-oauth'))

    await waitFor(() =>
      expect(fake.spies.startLogin).toHaveBeenLastCalledWith({
        method: 'oauth',
        publicComputer: false,
      }),
    )
    expect(sessionStorage.getItem('waxwing.onboard.publicComputer')).toBeNull()
  })

  /**
   * A failed exchange must not silently downgrade the session. The stash used to be dropped before
   * `completeRedirect`, so a retry after a stale PKCE transaction ran as an ordinary sign-in.
   */
  it('keeps the stash when the redirect exchange fails', async () => {
    sessionStorage.setItem('waxwing.onboard.publicComputer', 'true')
    renderSession({ isRedirectCallback: true, completeRedirectError: new Error('stale pkce') })

    await waitFor(() => expect(screen.getByTestId('step')).not.toHaveTextContent('none'))
    expect(sessionStorage.getItem('waxwing.onboard.publicComputer')).toBe('true')
  })

  /**
   * The registry holds no secret but it does hold an identity, it lives in `localStorage`, and no
   * production path ever removed a row — so a row written by a public-computer session was
   * permanent, and the account menu offered it to the next person at the machine.
   */
  it('writes no account-registry row for an ephemeral session', async () => {
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic-public'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    expect(localStorage.getItem('waxwing.accounts')).toBeNull()
  })

  it('writes one for an ordinary session — the counter-test', async () => {
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    expect(localStorage.getItem('waxwing.accounts')).toContain('alice')
  })

  /**
   * Re-reading the registry after the wipe must not write it back (found by the end-to-end
   * web-storage assertion, not by the unit test that stopped at `wipeLocalData`).
   *
   * `endSession` re-reads it so the module-scoped store cannot resurrect the old rows from memory
   * — and the re-read went through `emit`, which PERSISTS. That re-created `waxwing.accounts`
   * moments after "remove data" deleted it: an empty value, but a key, and "this origin holds a
   * Waxwing account list" is exactly the statement the wipe removes.
   */
  it('leaves no account-registry key behind after signing out and removing data', async () => {
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    await user.click(screen.getByText('basic'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(localStorage.getItem('waxwing.accounts')).not.toBeNull()

    localStorage.clear() // what `wipeLocalData` does to this origin
    await user.click(screen.getByText('signout'))
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    expect(localStorage.getItem('waxwing.accounts')).toBeNull()
  })

  /**
   * A PLAIN sign-out, which is the whole point: the mode's promise is that leaving does not depend
   * on the user finding the second menu item. `wipeLocalData` only runs on the explicit "remove
   * data" path, so `waxwing.connect.target` — which server this person reads mail on — used to
   * stay behind for the next person at the terminal.
   */
  it('clears the web storages on a plain sign-out from an ephemeral session', async () => {
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    await user.click(screen.getByText('basic-public'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    localStorage.setItem('waxwing.connect.target', '{"origin":"https://mail.example"}')

    await user.click(screen.getByText('signout'))
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    expect(localStorage.getItem('waxwing.connect.target')).toBeNull()
  })

  /**
   * FR-AUTH-09 names leaving without a menu click as the core scenario, and that is the one exit
   * with no clean-up at all: `pagehide` deletes the replica and nothing else. The registry write
   * was already stopped for ephemeral sessions (W-05); the connect target was not, so on an
   * `allowCustomServer` deployment the guest's mail host stayed in `localStorage` for the next
   * person — and a later durable boot started against it.
   */
  it('writes no connect target for an ephemeral session (R-77)', async () => {
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic-public'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    expect(localStorage.getItem('waxwing.connect.target')).toBeNull()
  })

  it('writes one for an ordinary session — the counter-test (R-77)', async () => {
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))

    expect(localStorage.getItem('waxwing.connect.target')).not.toBeNull()
  })

  it("leaves a DURABLE session's preferences alone on a plain sign-out — the counter-test", async () => {
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    await user.click(screen.getByText('basic'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    localStorage.setItem('waxwing.theme', 'dark')

    await user.click(screen.getByText('signout'))
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    // Plain sign-out is a session boundary, not a data one — see SECURITY.md §3.
    expect(localStorage.getItem('waxwing.theme')).toBe('dark')
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

describe('SessionProvider — an error that already knows what is wrong', () => {
  it('names the misconfigured session field instead of "something went wrong" (U1)', async () => {
    // `packages/jmap` refuses a Session whose apiUrl is on another origin — correctly, since every
    // request would attach the Authorization header to that host. The refusal carried the field,
    // the URL and the permitted origin; `errToOnboard` threw all three away and rendered the
    // generic sentence, leaving an operator with nothing to act on and a "try again" that returns
    // the identical refusal forever.
    const user = userEvent.setup()
    renderSession({
      probePresent: true,
      connectError: new JmapSessionOriginError(
        'apiUrl',
        'https://elsewhere.test/jmap',
        'https://mail.test',
      ),
    })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic'))

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('onboarding.error.sessionOrigin'),
    )
  })
})

describe('SessionProvider — the way out when nothing works', () => {
  it('hands the local-data reset to the services seam (U2)', async () => {
    const user = userEvent.setup()
    const fake = makeFakeServices({ probePresent: true })
    const resetLocalData = vi.fn(async () => {})
    render(
      <ServicesProvider value={{ ...fake.services, resetLocalData }}>
        <SessionProvider config={DEFAULT_CONFIG}>
          <Consumer />
        </SessionProvider>
      </ServicesProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('wipe-local'))

    expect(resetLocalData).toHaveBeenCalledTimes(1)
  })
})

describe('SessionProvider — sign-out clears the screen first', () => {
  /** A `logout` that hangs until the test lets go, standing in for the slow half of the teardown. */
  function pendingLogout(fake: ReturnType<typeof renderSession>): () => void {
    let release: () => void = () => {}
    fake.spies.logout.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    return () => release()
  }

  async function signedIn() {
    const user = userEvent.setup()
    const fake = renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    await user.click(screen.getByText('basic'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    return { user, fake }
  }

  it('shows the login form while the clean-up is still running (M3)', async () => {
    // The measured defect: the account name, the folder tree and the whole Inbox stayed on screen
    // for a mean of 6.1 s after the click, because the login dispatch was the LAST statement of the
    // teardown. Clearing the display is instant and cannot fail; the wipe is I/O. Order matters
    // most on the shared machine the user is walking away from.
    const { user, fake } = await signedIn()
    const release = pendingLogout(fake)

    await user.click(screen.getByText('signout'))

    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(screen.getByTestId('status')).toHaveTextContent('onboarding')
    expect(screen.getByTestId('account')).toHaveTextContent('')

    await act(async () => {
      release()
    })
  })

  it('holds a new sign-in until the clean-up it would race is done', async () => {
    // The cost of clearing first: the login form is usable while `resetReplica()` and
    // `controllerRef.current = null` are still ahead. A session opened in that window would be
    // dismantled by the teardown that follows it.
    const { user, fake } = await signedIn()
    const release = pendingLogout(fake)

    await user.click(screen.getByText('signout'))
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    await user.click(screen.getByText('basic'))
    expect(screen.getByTestId('status')).toHaveTextContent('onboarding')

    await act(async () => {
      release()
    })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
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

/**
 * "Your place is kept" is what the re-auth dialog says, and the OAuth leg is the one that has to
 * work for it: the redirect_uri is the app root by construction, so whatever the reader was
 * looking at survives only if this component stashed it.
 */
describe('SessionProvider — the OAuth redirect keeps the whole route', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('stashes the query alongside the path on a re-auth redirect (R-31)', async () => {
    // The path alone is not the place. `?account=` is what says WHICH mailbox `e1` belongs to, so
    // restoring `/mail/a/e1` without it lands on a different message of the reader's own account —
    // or on an empty reading pane.
    const user = userEvent.setup()
    renderSession({ isRedirectCallback: true })
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    window.history.replaceState(null, '', '/mail/a/e1?account=shared-1&q=rechnung&full=1')

    await user.click(screen.getByText('expire'))
    await user.click(screen.getByText('reauth-oauth'))

    await waitFor(() =>
      expect(sessionStorage.getItem('waxwing.onboard.route')).toBe(
        JSON.stringify('/mail/a/e1?account=shared-1&q=rechnung&full=1'),
      ),
    )
  })

  it('stashes the deep link on the FIRST OAuth sign-in too (R-81)', async () => {
    // Nobody signing in from a link has a session to re-auth: public computer, or anyone who
    // signed out. The stash existed only on the re-auth leg, so the link was discarded and they
    // landed in the Inbox.
    const user = userEvent.setup()
    renderSession({ probePresent: true })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    window.history.replaceState(null, '', '/contacts/c42?q=weber')

    await user.click(screen.getByText('oauth-plain'))

    await waitFor(() =>
      expect(sessionStorage.getItem('waxwing.onboard.route')).toBe(
        JSON.stringify('/contacts/c42?q=weber'),
      ),
    )
  })

  it('restores path and query before the router mounts', async () => {
    sessionStorage.setItem('waxwing.onboard.route', JSON.stringify('/mail/a/e1?account=shared-1'))

    renderSession({ isRedirectCallback: true })

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(window.location.pathname).toBe('/mail/a/e1')
    expect(window.location.search).toBe('?account=shared-1')
    // Single-use, like the other two halves of the handshake stash.
    expect(sessionStorage.getItem('waxwing.onboard.route')).toBeNull()
  })
})

/**
 * A callback that fails is still the reader's sign-in attempt, and until now the app answered it by
 * forgetting which server they had asked for, freezing the field they would need to say it again,
 * and offering to delete their mailbox.
 */
describe('SessionProvider — a failed OAuth callback', () => {
  const MANUAL_TARGET = {
    connectUrl: 'https://mail.example.org',
    issuer: 'https://mail.example.org',
    displayHost: 'mail.example.org',
    fromProbe: false,
  }

  it('keeps the manually entered server, and keeps its field editable (R-32)', async () => {
    // `targetRef` is still null during boot, so the catch fell through to `fallbackTarget()` — the
    // app's own origin, as a `fromProbe` target, which `canEditServer` refuses to unlock. The
    // reader had typed `mail.example.org`, was declined at the IdP, and got a sign-in form for
    // `localhost` that they could not correct without reloading the page.
    sessionStorage.setItem('waxwing.onboard.target', JSON.stringify(MANUAL_TARGET))
    renderSession({
      isRedirectCallback: true,
      completeRedirectError: new OAuthCallbackError('OAuth callback failed'),
    })

    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(screen.getByTestId('host')).toHaveTextContent('mail.example.org')
    expect(screen.getByTestId('can-edit-server')).toHaveTextContent('true')
    // Fail-closed like the public-computer half: the retry must still know the server.
    expect(sessionStorage.getItem('waxwing.onboard.target')).toBe(JSON.stringify(MANUAL_TARGET))
  })

  it('names an IdP refusal as one, and offers no reset for it (R-32)', async () => {
    // `access_denied` is the reader pressing "Deny". Answering a deliberate choice with "Something
    // went wrong" plus a button that deletes the local mailbox is the wrong sentence twice over.
    renderSession({
      isRedirectCallback: true,
      completeRedirectError: new OAuthCallbackError('OAuth callback failed', {
        code: 'access_denied',
      }),
    })

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('onboarding.error.oauthDenied'),
    )
  })

  it('distinguishes a spent transaction from a refusal', async () => {
    renderSession({
      isRedirectCallback: true,
      completeRedirectError: new OAuthCallbackError('No pending authorization request'),
    })

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('onboarding.error.oauthCallback'),
    )
  })

  it('withholds the reset button under both OAuth-callback errors', () => {
    // The set is what `Onboarding` matches on; both new keys have to be in it or the screen offers
    // to delete the mailbox under a failure that has nothing to do with local state.
    expect(NO_RESET_ERROR_KEYS.has('onboarding.error.oauthDenied')).toBe(true)
    expect(NO_RESET_ERROR_KEYS.has('onboarding.error.oauthCallback')).toBe(true)
    // The counter-test: a genuinely unexplained failure still gets the way out (U2).
    expect(NO_RESET_ERROR_KEYS.has('onboarding.error.generic')).toBe(false)
  })

  /**
   * R-84. `markEphemeral()` has to run BEFORE the exchange (`setReplicaName` throws once the
   * replica is open), so a failed exchange left the throwaway replica name and the ref in force —
   * while the login form underneath starts with the box unticked. A password retry with "stay
   * signed in" then produced exactly the combination the two settings exclude: durable credentials
   * on disk, a replica `pagehide` deletes, and no registry row.
   */
  it('drops the public-computer state so the next choice decides (R-84)', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem('waxwing.onboard.publicComputer', 'true')
    renderSession({
      isRedirectCallback: true,
      completeRedirectError: new OAuthCallbackError('OAuth callback failed'),
    })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))

    expect(currentReplicaName()).toBe(REPLICA_DB_NAME)

    // And the retry the form actually offers — "stay signed in", box unticked — stays durable.
    await user.click(screen.getByText('basic'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(currentReplicaName()).toBe(REPLICA_DB_NAME)
    expect(localStorage.getItem('waxwing.accounts')).toContain('alice')
  })
})

/**
 * THE OFFLINE COLD START (FR-OFF-01, R-78, ADR-041).
 *
 * The installed app is opened with no network. Everything is on the device — the credentials, the
 * replica, the JMAP Session document — and until this shipped, the reader got the sign-in form
 * with "Could not reach the server" on it, in front of a mailbox that was fully there.
 *
 * `origin` on the fake session is the app's own here, and that is not a harness detail: a stored
 * document is re-validated against the URL the app connects to (`sessionFromStore`), because the
 * four URLs in it are where the `Authorization` header goes.
 */
describe('SessionProvider — the offline cold start (FR-OFF-01)', () => {
  const onLine = (value: boolean) =>
    Object.defineProperty(navigator, 'onLine', { configurable: true, value })

  const sameOrigin = () =>
    fakeJmapSession('acc-1', 'alice@waxwing.test', { origin: window.location.origin })

  afterEach(() => onLine(true))

  it('THE ONE: a second launch with no network opens the mailbox, not the sign-in form', async () => {
    // The whole round trip, in the order it happens on a device: one connect that succeeds and
    // stores its Session document, then a cold start with the plug pulled. Deliberately NOT a
    // hand-written stored value — what the offline boot opens has to be what the connect actually
    // wrote, or this test would pass against a provider that stores something else entirely.
    const fake = makeFakeServices({ restore: fakeAuthSession('basic'), session: sameOrigin() })
    const first = mountSession(fake)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(screen.getByTestId('offline')).toHaveTextContent('false')
    expect(fake.spies.rememberJmapSession).toHaveBeenCalledTimes(1)
    first.unmount()

    onLine(false)
    fake.goOffline()
    mountSession(fake)

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(screen.getByTestId('account')).toHaveTextContent('alice@waxwing.test')
    expect(screen.getByTestId('accounts')).toHaveTextContent('acc-1')
    // Named honestly: the session came out of the store, and the reconnect reads exactly this.
    expect(screen.getByTestId('offline')).toHaveTextContent('true')
    // And the client was BUILT, not fetched — the connect was attempted and failed first.
    expect(fake.spies.connect).toHaveBeenCalledTimes(2)
    expect(fake.spies.clientFromSession).toHaveBeenCalledTimes(1)
  })

  it('keeps the delegated accounts a share granted, because a dead probe is not a denial', async () => {
    // `probeSharedAreas` cannot run offline, and `deriveDelegation` reads an absent verdict as
    // "granted everywhere" — the rule `sharing/probe.ts` already states for a probe that did not
    // answer. A rail that empties itself when the network drops is worse than one showing a
    // section that turns out to be empty.
    const fake = makeFakeServices({
      restore: fakeAuthSession('basic'),
      session: fakeJmapSession('acc-1', 'alice@waxwing.test', {
        origin: window.location.origin,
        shared: [{ id: 'shared-1', name: 'team@waxwing.test' }],
      }),
    })
    const first = mountSession(fake)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    first.unmount()

    onLine(false)
    fake.goOffline()
    mountSession(fake)
    await waitFor(() => expect(screen.getByTestId('offline')).toHaveTextContent('true'))
    expect(screen.getByTestId('accounts').textContent).toBe('acc-1,shared-1')
  })

  it('reconnects on the `online` event and stops calling itself offline', async () => {
    const fake = makeFakeServices({ restore: fakeAuthSession('basic'), session: sameOrigin() })
    const first = mountSession(fake)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    first.unmount()

    onLine(false)
    fake.goOffline()
    mountSession(fake)
    await waitFor(() => expect(screen.getByTestId('offline')).toHaveTextContent('true'))

    onLine(true)
    fake.goOnline()
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })

    await waitFor(() => expect(screen.getByTestId('offline')).toHaveTextContent('false'))
    // A whole connect, not a `refreshSession()`: `accounts` and `delegated` are re-derived, which
    // is what the sidebar and the engine fleet read.
    expect(fake.spies.connect).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('status')).toHaveTextContent('ready')
  })

  it('stays offline, and stays quiet, when the reconnect fails too', async () => {
    const fake = makeFakeServices({ restore: fakeAuthSession('basic'), session: sameOrigin() })
    const first = mountSession(fake)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    first.unmount()

    onLine(false)
    fake.goOffline()
    mountSession(fake)
    await waitFor(() => expect(screen.getByTestId('offline')).toHaveTextContent('true'))

    // The `online` event fires on a connection that is not actually usable — a captive portal, a
    // train tunnel's edge. The reader must not be thrown back to a sign-in form for it.
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => expect(fake.spies.connect).toHaveBeenCalledTimes(3))
    expect(screen.getByTestId('status')).toHaveTextContent('ready')
    expect(screen.getByTestId('offline')).toHaveTextContent('true')
  })

  it('shows the sign-in form when there is no stored document at all', async () => {
    // The upgrade case, and the honest one: a device that signed in before this shipped has
    // credentials and no document. Nothing to open, so nothing is claimed.
    onLine(false)
    renderSession({ restore: fakeAuthSession('basic'), connectError: new TypeError('fetch') })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(screen.getByTestId('error')).toHaveTextContent('onboarding.error.network')
  })

  it('refuses a document stored under a different connect URL, same origin or not', async () => {
    // Same ORIGIN, different deployment: a pinned `sessionUrl` is an operator-editable path, and
    // two JMAP servers behind one origin are two servers. The origin check in `sessionFromStore`
    // cannot see this one, which is why the provenance is recorded and compared as well.
    onLine(false)
    const fake = renderSession({
      restore: fakeAuthSession('basic'),
      connectError: new TypeError('fetch'),
      storedJmapSession: {
        connectUrl: `${window.location.origin}/other/.well-known/jmap`,
        document: sameOrigin(),
      },
    })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(fake.spies.clientFromSession).not.toHaveBeenCalled()
  })

  it('refuses a stored document whose URLs have moved origin', async () => {
    // Anything that can write to the store could otherwise nominate a host, and the first request
    // after the network returned would carry the `Authorization` header to it.
    onLine(false)
    const fake = renderSession({
      restore: fakeAuthSession('basic'),
      connectError: new TypeError('fetch'),
      storedJmapSession: { document: fakeJmapSession('acc-1', 'alice@waxwing.test') },
    })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(fake.spies.clientFromSession).not.toHaveBeenCalled()
  })

  it('refuses a stored document with no mail account left in it', async () => {
    // Structurally a Session, on the right origin, and useless: the account this app reads mail
    // from is gone. The message on the form stays the true one — the connect failed — rather than
    // a verdict about a stored file the reader cannot see.
    onLine(false)
    renderSession({
      restore: fakeAuthSession('basic'),
      connectError: new TypeError('fetch'),
      storedJmapSession: { document: { ...sameOrigin(), primaryAccounts: {} } },
    })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(screen.getByTestId('status')).toHaveTextContent('onboarding')
    expect(screen.getByTestId('error')).toHaveTextContent('onboarding.error.network')
  })

  it('does NOT open the replica when the browser says it is online (a captive portal)', async () => {
    // The deliberate narrow reading. With the device claiming a connection, "could not reach
    // {{host}}" is a fault the reader can act on — a portal to sign in to, a server that is down,
    // a host that has moved. Opening a read-only replica would hide it behind a working-looking
    // app, and no `online` event would ever come to end that state.
    onLine(true)
    const fake = renderSession({
      restore: fakeAuthSession('basic'),
      connectError: new TypeError('Failed to fetch'),
      storedJmapSession: { document: sameOrigin() },
    })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(fake.spies.clientFromSession).not.toHaveBeenCalled()
  })

  it('does NOT open the replica for a server that answered — a 401 is not offline', async () => {
    // The credentials have expired while the device was away. That is a sign-in, not an offline
    // start, and showing the mailbox would promise a session that the first request will refuse.
    onLine(false)
    const fake = renderSession({
      restore: fakeAuthSession('basic'),
      connectError: new JmapProblemError({ type: 'about:blank', detail: 'Unauthorized' }, 401),
      storedJmapSession: { document: sameOrigin() },
    })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(fake.spies.clientFromSession).not.toHaveBeenCalled()
  })

  it('Basic without "stay signed in" gets the sign-in form, exactly as before (FR-AUTH-04)', async () => {
    // There is no `restore()` on this path and there must not be one: no AuthRecord, therefore no
    // stored document either (the controller's own guard). The sign-in form is the right answer,
    // and it is the answer whether or not there is a network.
    onLine(false)
    const fake = renderSession({ restore: null })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(fake.spies.clientFromSession).not.toHaveBeenCalled()
    expect(fake.spies.connect).not.toHaveBeenCalled()
  })
})

/**
 * A PROBE MAY ONLY STATE WHAT IT MEASURED (FR-OFF-01, follow-up to R-78).
 *
 * `services.probe` reported a request that got no answer as "no server here", and boot step C read
 * that as the cue to open the MANUAL server-entry step. So the one reader who could do least about
 * it — no stored session, no network — was handed the most technical screen this app has, asking
 * for an address it had no way to check. The silence is not a measurement; the last server this
 * browser actually used is.
 */
describe('SessionProvider — the probe got no answer (FR-OFF-01)', () => {
  const durable = {
    connectUrl: 'https://mail.example.org',
    issuer: 'https://mail.example.org',
    displayHost: 'mail.example.org',
    fromProbe: false,
  }

  it('THE ONE: offers the last server used, not the server-entry dialog', async () => {
    localStorage.setItem('waxwing.connect.target', JSON.stringify(durable))
    renderSession({ probeResult: 'unknown' })

    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(screen.getByTestId('host')).toHaveTextContent('mail.example.org')
  })

  it('falls back to the server-entry step only when there is nothing to fall back to', async () => {
    // A genuinely first launch with no connection. There is nothing true to say about which server
    // this is, so the app does not invent one — the form itself carries the offline sentence.
    renderSession({ probeResult: 'unknown' })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('connect'))
  })

  it('ignores a durable target that is not one', async () => {
    // `localStorage` is user-writable and survives every version of this app. A value without a
    // `connectUrl` would produce a sign-in form for `undefined`.
    localStorage.setItem('waxwing.connect.target', JSON.stringify({ displayHost: 'x' }))
    renderSession({ probeResult: 'unknown' })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('connect'))
  })

  it('a server that answered 404 still means "no server here"', async () => {
    // The counter-test, and the reason the third answer had to be its own value: a measured
    // absence must keep opening the server-entry step, durable target or not.
    localStorage.setItem('waxwing.connect.target', JSON.stringify(durable))
    renderSession({ probeResult: 'absent' })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('connect'))
  })

  it('a server that answered still wins over the durable target', async () => {
    localStorage.setItem('waxwing.connect.target', JSON.stringify(durable))
    renderSession({ probeResult: 'present' })
    await waitFor(() => expect(screen.getByTestId('step')).toHaveTextContent('login'))
    expect(screen.getByTestId('host')).toHaveTextContent('localhost')
  })
})
