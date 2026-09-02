/**
 * Leaving a settings section with something typed in it (M5.1/M5.3, R-86).
 *
 * The dialog editors on this screen — a filter rule, a template — confirm before they discard, and
 * the two INLINE forms did not. The identity editor and the vacation responder are rows of their
 * section's card by design (a signature editor in a modal on a phone is a worse screen), and that
 * design left them with no guard at all: a stray tap on another rail entry, or on the phone's
 * "‹ Settings" back link, unmounted a half-typed multi-line signature without a word.
 *
 * Driven through the real `SettingsPage`, because the guard is a collaboration: the form reports
 * that it holds unsaved input, and the page is the one that owns the links.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import { SessionContext } from '../app/session/context'
import type { JmapSession, SessionContextValue } from '../app/session/types'
import { type ReplicaDb, ReplicaProvider } from '../sync'
import { freshDb } from '../sync/test-utils'
import { ToastProvider } from '../ui'
import SettingsPage from './SettingsPage'

const ACC = 'a'

const VACATION = {
  id: 'singleton',
  isEnabled: false,
  fromDate: null,
  toDate: null,
  subject: null,
  textBody: null,
  htmlBody: null,
}

/** A session that offers the vacation responder on the ACCOUNT, the way Stalwart does. */
function jmapSession(): JmapSession {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
    accounts: {
      [ACC]: {
        name: 'alice@waxwing.test',
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {},
          'urn:ietf:params:jmap:vacationresponse': {},
        },
      },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': ACC },
    username: 'alice@waxwing.test',
    apiUrl: 'http://localhost:18080/jmap/',
    downloadUrl: '',
    uploadUrl: '',
    eventSourceUrl: '',
    state: 's',
  } as unknown as JmapSession
}

function sessionValue(): SessionContextValue {
  return {
    status: 'ready',
    onboarding: null,
    reauth: null,
    reportAuthExpired: () => {},
    connected: {
      jmapSession: jmapSession(),
      accountId: ACC,
      username: 'alice@waxwing.test',
      method: 'basic',
      accounts: [{ id: ACC, name: 'alice@waxwing.test', isPersonal: true, isReadOnly: false }],
      client: {
        async call() {
          return { get: () => ({ state: 'st-1', list: [VACATION] }) }
        },
      },
    },
  } as unknown as SessionContextValue
}

let db: ReplicaDb

function renderSettings() {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ToastProvider>
          <SessionContext.Provider value={sessionValue()}>
            <ReplicaProvider accountId={ACC} db={db}>
              <SettingsPage />
            </ReplicaProvider>
          </SessionContext.Provider>
        </ToastProvider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

async function openVacation(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const rail = await screen.findByRole('navigation', { name: 'Settings' })
  await user.click(within(rail).getByRole('link', { name: 'Vacation responder' }))
  await screen.findByLabelText('Send automatic replies')
}

async function railLink(name: string): Promise<HTMLElement> {
  const rail = await screen.findByRole('navigation', { name: 'Settings' })
  return within(rail).getByRole('link', { name })
}

beforeEach(() => {
  db = freshDb()
})

describe('leaving a settings section with unsaved input', () => {
  it('asks before another rail entry throws the draft away', async () => {
    const user = userEvent.setup()
    renderSettings()
    await openVacation(user)

    await user.click(screen.getByLabelText('Send automatic replies'))
    await user.click(await railLink('General'))

    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument()
    // Still here — the click was intercepted, not merely announced after the fact.
    expect(screen.getByLabelText('Send automatic replies')).toBeInTheDocument()
  })

  it('keeps the draft when the reader says so', async () => {
    const user = userEvent.setup()
    renderSettings()
    await openVacation(user)

    await user.click(screen.getByLabelText('Send automatic replies'))
    await user.click(await railLink('General'))
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }))

    await waitFor(() => expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Send automatic replies')).toBeChecked()
  })

  it('goes where the reader asked once they have confirmed', async () => {
    const user = userEvent.setup()
    renderSettings()
    await openVacation(user)

    await user.click(screen.getByLabelText('Send automatic replies'))
    await user.click(await railLink('General'))
    await user.click(await screen.findByRole('button', { name: 'Discard' }))

    expect(await screen.findByLabelText('Language')).toBeInTheDocument()
    expect(screen.queryByLabelText('Send automatic replies')).not.toBeInTheDocument()
  })

  it('does not ask when nothing was changed — the counter-test', async () => {
    // A prompt in front of a reader with nothing to lose is a prompt they learn to click through,
    // which is why this is compared against the LOADED value rather than against "was touched".
    const user = userEvent.setup()
    renderSettings()
    await openVacation(user)

    // Toggle and toggle back: the form now matches the server again.
    await user.click(screen.getByLabelText('Send automatic replies'))
    await user.click(screen.getByLabelText('Send automatic replies'))
    await user.click(await railLink('General'))

    expect(await screen.findByLabelText('Language')).toBeInTheDocument()
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument()
  })
})
