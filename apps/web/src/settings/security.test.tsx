/**
 * Settings → Account & security (X-1, X-2, X-4, X-5, X-6).
 *
 * Two of the assertions here are the reason the file exists at all, and neither is about layout:
 *
 *  - **The section does not exist without the capability.** `urn:stalwart:jmap` is a PROPRIETARY
 *    Stalwart extension and product principle 6 permits it only as a progressive enhancement. The
 *    first `describe` renders the whole settings page against a plain JMAP server and asserts the
 *    rail has no such row — and against a Stalwart-shaped session, where the URN sits on the
 *    ACCOUNT and not on the session, and asserts it does.
 *  - **Nothing keeps a copy of an app-password secret.** It is shown once and then gone: the test
 *    watches `localStorage`, `sessionStorage`, every `console` method and the DOM across the whole
 *    create-reveal-dismiss flow.
 *
 * The JMAP client is a fake. What is asserted is the contract the section owes: which blocks appear
 * for which permissions, that encryption at rest is reported and never offered, that a password
 * change re-authenticates a Basic session, and that a refusal reaches the reader with the server's
 * own sentence in it.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import { SessionContext } from '../app/session/context'
import type { JmapSession, SessionContextValue } from '../app/session/types'
import { type ReplicaDb, ReplicaProvider } from '../sync'
import { freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { SecuritySection } from './SecuritySection'
import SettingsPage from './SettingsPage'
import {
  type SelfServiceClient,
  type SelfServiceSnapshot,
  STALWART_CAPABILITY,
  StalwartSetError,
} from './stalwart-client'
import type { AppPasswordView, SpamSampleView } from './stalwart-model'

const ACC = 'b'
const SECTION = 'Account & security'
/** The shape the server hands out once, and never again. */
const SECRET = 'app_aaaaaakdgrsdybtl9rwtd3ya2kzttbbot70a'

const PHONE: AppPasswordView = {
  id: 'b',
  description: 'iPhone Mail',
  createdAt: '2026-06-03T09:14:00Z',
  expiresAt: null,
  expired: false,
  restricted: false,
}

const SAMPLE: SpamSampleView = {
  id: 's1',
  from: 'newsletter@example.test',
  subject: 'Half price everything',
  isSpam: true,
}

const FULL: SelfServiceSnapshot = {
  appPasswords: [PHONE],
  passwordReadable: true,
  language: 'en_US',
  encryption: { kind: 'off' },
  publicKeys: [],
  spamSamples: [SAMPLE],
}

interface Calls {
  loads: number
  readonly created: { description: string; expiresAt: string | null }[]
  readonly destroyed: string[]
  readonly passwords: [string, string][]
  readonly languages: string[]
  readonly samples: string[]
}

interface Fake {
  readonly client: SelfServiceClient
  readonly calls: Calls
}

function fakeClient(
  options: {
    snapshot?: SelfServiceSnapshot
    /** Thrown by every write; the fake then applies nothing. */
    onWrite?: () => never
  } = {},
): Fake {
  let current = options.snapshot ?? FULL
  const calls: Calls = {
    loads: 0,
    created: [],
    destroyed: [],
    passwords: [],
    languages: [],
    samples: [],
  }

  const client: SelfServiceClient = {
    load: async () => {
      calls.loads += 1
      return current
    },
    createAppPassword: async (input) => {
      calls.created.push(input)
      options.onWrite?.()
      // A second app password, MASKED — exactly as a re-read comes back from the server.
      current = {
        ...current,
        appPasswords: [
          ...(current.appPasswords ?? []),
          { ...PHONE, id: 'c', description: input.description },
        ],
      }
      return { id: 'c', secret: SECRET }
    },
    destroyAppPassword: async (id) => {
      calls.destroyed.push(id)
      options.onWrite?.()
      current = {
        ...current,
        appPasswords: (current.appPasswords ?? []).filter((one) => one.id !== id),
      }
    },
    changePassword: async (currentSecret, secret) => {
      calls.passwords.push([currentSecret, secret])
      options.onWrite?.()
    },
    setLanguage: async (locale) => {
      calls.languages.push(locale)
      options.onWrite?.()
      current = { ...current, language: locale }
    },
    destroySpamSample: async (id) => {
      calls.samples.push(id)
      options.onWrite?.()
      current = {
        ...current,
        spamSamples: (current.spamSamples ?? []).filter((one) => one.id !== id),
      }
    },
  }

  return { client, calls }
}

function renderSection(client: SelfServiceClient, session?: SessionContextValue) {
  const tree = (
    <ConfigProvider config={DEFAULT_CONFIG}>
      <ToastProvider>
        <SecuritySection client={client} />
      </ToastProvider>
    </ConfigProvider>
  )
  return render(
    session === undefined ? (
      tree
    ) : (
      <SessionContext.Provider value={session}>{tree}</SessionContext.Provider>
    ),
  )
}

// ─── the capability gate ─────────────────────────────────────────────────────────────────────

/**
 * A session shaped like the real thing.
 *
 * `stalwart: true` puts `urn:stalwart:jmap` in `accountCapabilities` and NOWHERE ELSE, which is
 * where the pinned fixture (v0.16.18) puts it — 17 top-level URNs, none of them this one.
 */
function jmapSession(options: { stalwart: boolean }): JmapSession {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:mail': {},
    },
    accounts: {
      [ACC]: {
        name: 'alice@waxwing.test',
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {},
          ...(options.stalwart ? { [STALWART_CAPABILITY]: {} } : {}),
        },
      },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': ACC },
    username: 'alice@waxwing.test',
    apiUrl: 'http://localhost:18080/jmap/',
    state: 's',
  } as unknown as JmapSession
}

function sessionValue(options: {
  stalwart: boolean
  method?: 'basic' | 'oauth'
  reportAuthExpired?: () => void
}): SessionContextValue {
  return {
    status: 'ready',
    onboarding: null,
    reauth: null,
    reportAuthExpired: options.reportAuthExpired ?? (() => {}),
    connected: {
      jmapSession: jmapSession({ stalwart: options.stalwart }),
      accountId: ACC,
      username: 'alice@waxwing.test',
      method: options.method ?? 'basic',
      accounts: [{ id: ACC, name: 'alice@waxwing.test', isPersonal: true, isReadOnly: false }],
      // Never reached in these tests: every section that would use it takes an injected client.
      client: {
        async call() {
          throw new Error('not used')
        },
      },
    },
  } as unknown as SessionContextValue
}

let db: ReplicaDb

function renderSettings(session: SessionContextValue) {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <ReplicaProvider accountId={ACC} db={db}>
              <SettingsPage />
            </ReplicaProvider>
          </SessionContext.Provider>
        </ToastProvider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

beforeEach(() => {
  db = freshDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the section exists only where the server offers it (product principle 6)', () => {
  it('is absent — down to its row in the rail — on a server without `urn:stalwart:jmap`', async () => {
    renderSettings(sessionValue({ stalwart: false }))

    const rail = await screen.findByRole('navigation', { name: 'Settings' })
    expect(within(rail).queryByRole('link', { name: SECTION })).not.toBeInTheDocument()
    // …and the page is otherwise alive, so this cannot pass by rendering nothing at all.
    expect(within(rail).getByRole('link', { name: 'General' })).toBeInTheDocument()
  })

  it('appears where Stalwart advertises it — on the ACCOUNT, not on the session', async () => {
    // The one shape that can fail: a probe of `session.capabilities` alone finds nothing here and
    // hides the section on the very server it was built for.
    const session = sessionValue({ stalwart: true })
    const advertised = (session.connected?.jmapSession as unknown as { capabilities: object })
      .capabilities
    expect(Object.keys(advertised)).not.toContain(STALWART_CAPABILITY)

    renderSettings(session)

    const rail = await screen.findByRole('navigation', { name: 'Settings' })
    expect(within(rail).getByRole('link', { name: SECTION })).toBeInTheDocument()
  })
})

// ─── the secret ──────────────────────────────────────────────────────────────────────────────

describe('an app-password secret is shown once and kept nowhere', () => {
  it('never reaches storage, a log or the DOM after it is dismissed', async () => {
    const user = userEvent.setup()
    const logs: unknown[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(...args)
      })
    }
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    const { client } = fakeClient()
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Create app password…' }))
    await user.type(screen.getByLabelText('What is it for?'), 'iPad Mail')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    // Shown, in full, once.
    expect(await screen.findByText(SECRET)).toBeInTheDocument()

    // The copy button hands it to the clipboard — and to nothing else.
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET))

    await user.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(screen.queryByText(SECRET)).not.toBeInTheDocument())
    expect(document.body.innerHTML).not.toContain(SECRET)
    // `app_` on its own, in case a future change stores a prefix or a truncation of it.
    expect(JSON.stringify({ ...localStorage })).not.toContain('app_')
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('app_')
    expect(JSON.stringify(logs)).not.toContain('app_')
  })

  it('does not bring the last secret back when the dialog is opened again', async () => {
    // The dialog stays MOUNTED so focus can return to the button that opened it — which is exactly
    // how a secret survives a close unless something clears it.
    const user = userEvent.setup()
    const { client } = fakeClient()
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Create app password…' }))
    await user.type(screen.getByLabelText('What is it for?'), 'iPad Mail')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByText(SECRET)
    await user.click(screen.getByRole('button', { name: 'Done' }))

    await user.click(await screen.findByRole('button', { name: 'Create app password…' }))

    expect(screen.queryByText(SECRET)).not.toBeInTheDocument()
    expect(screen.getByLabelText('What is it for?')).toHaveValue('')
  })

  it('says it will not be shown again, before the reader can dismiss it', async () => {
    const user = userEvent.setup()
    const { client, calls } = fakeClient()
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Create app password…' }))
    await user.type(screen.getByLabelText('What is it for?'), 'iPad Mail')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(
      await screen.findByText(
        'This is the only time it is shown. If it gets lost, revoke it here and create a new one.',
      ),
    ).toBeInTheDocument()
    expect(calls.created).toEqual([{ description: 'iPad Mail', expiresAt: null }])
  })

  it('refuses to create one without a name rather than sending a doomed request', async () => {
    // The server answers `validationFailed` on a missing description; asking here is faster and
    // says why in the reader's language.
    const user = userEvent.setup()
    const { client, calls } = fakeClient()
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Create app password…' }))
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(screen.getByText('Give it a name, so you can tell it apart later.')).toBeInTheDocument()
    expect(calls.created).toEqual([])
  })
})

// ─── the blocks ──────────────────────────────────────────────────────────────────────────────

describe('<SecuritySection>', () => {
  it('lists an app password with the date it was made', async () => {
    const { client } = fakeClient()
    renderSection(client)

    expect(await screen.findByText('iPhone Mail')).toBeInTheDocument()
    expect(screen.getByText(/^Created /)).toBeInTheDocument()
  })

  it('says an expired password no longer works, instead of listing it like the others', async () => {
    const { client } = fakeClient({
      snapshot: {
        ...FULL,
        appPasswords: [{ ...PHONE, expiresAt: '2020-01-01T00:00:00Z', expired: true }],
      },
    })
    renderSection(client)

    expect(await screen.findByText('Expired — this password no longer works.')).toBeInTheDocument()
  })

  it('reports a password an administrator narrowed, rather than letting it look broken', async () => {
    const { client } = fakeClient({
      snapshot: { ...FULL, appPasswords: [{ ...PHONE, restricted: true }] },
    })
    renderSection(client)

    expect(await screen.findByText(/Limited to certain rights or addresses/)).toBeInTheDocument()
  })

  it('revokes an app password only after the reader confirms it', async () => {
    const user = userEvent.setup()
    const { client, calls } = fakeClient()
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Revoke iPhone Mail' }))
    expect(calls.destroyed).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Revoke' }))

    await waitFor(() => expect(calls.destroyed).toEqual(['b']))
    await waitFor(() => expect(screen.queryByText('iPhone Mail')).not.toBeInTheDocument())
  })

  it('hides the password block where the server will not let this account read it', async () => {
    // An external LDAP/SQL directory strips `sysAccountPassword*`. FR-SRV-02: hidden, never broken.
    const { client } = fakeClient({ snapshot: { ...FULL, passwordReadable: false } })
    renderSection(client)

    await screen.findByText('iPhone Mail')
    expect(screen.queryByRole('button', { name: 'Change password…' })).not.toBeInTheDocument()
  })

  it('hides the app-password block where the server will not let this account read it', async () => {
    const { client } = fakeClient({ snapshot: { ...FULL, appPasswords: null } })
    renderSection(client)

    await screen.findByRole('button', { name: 'Change password…' })
    expect(screen.queryByRole('button', { name: 'Create app password…' })).not.toBeInTheDocument()
  })

  it('says so plainly when the account may do none of it', async () => {
    const { client } = fakeClient({
      snapshot: {
        appPasswords: null,
        passwordReadable: false,
        language: null,
        encryption: null,
        publicKeys: [],
        spamSamples: null,
      },
    })
    renderSection(client)

    expect(
      await screen.findByText('Your server offers none of these settings for this account.'),
    ).toBeInTheDocument()
  })
})

describe('encryption at rest is reported, never offered', () => {
  it('states that it is off without putting a switch on the screen', async () => {
    const { client } = fakeClient()
    renderSection(client)

    expect(
      await screen.findByText('Off. Your server stores your messages unencrypted.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('explains what an ENABLED setting means for this client, and offers no way to change it', async () => {
    // The switch exists in the registry. Offering it would mean offering to make the reader's
    // mailbox unreadable in the app they threw it from — this client has no OpenPGP stack.
    const { client } = fakeClient({
      snapshot: {
        ...FULL,
        encryption: { kind: 'on', cipher: 'Aes256', keyLabel: 'Alice OpenPGP' },
      },
    })
    renderSection(client)

    expect(await screen.findByText('On — Aes256')).toBeInTheDocument()
    expect(screen.getByText('Key: Alice OpenPGP')).toBeInTheDocument()
    expect(screen.getByText(/has no OpenPGP support and cannot display them/)).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /encrypt/i })).not.toBeInTheDocument()
  })
})

describe('the language of the messages the SERVER writes', () => {
  it('shows what is set and writes what is chosen', async () => {
    const user = userEvent.setup()
    const { client, calls } = fakeClient()
    renderSection(client)

    const select = await screen.findByLabelText('Language of server messages')
    expect(select).toHaveValue('en_US')

    await user.selectOptions(select, 'de_DE')

    await waitFor(() => expect(calls.languages).toEqual(['de_DE']))
  })

  it('offers only the twelve the server can actually write in', async () => {
    const { client } = fakeClient()
    renderSection(client)

    const select = await screen.findByLabelText('Language of server messages')
    expect(within(select).getAllByRole('option')).toHaveLength(12)
  })

  it('is absent where the settings singleton is not readable', async () => {
    const { client } = fakeClient({ snapshot: { ...FULL, language: null } })
    renderSection(client)

    await screen.findByText('iPhone Mail')
    expect(screen.queryByLabelText('Language of server messages')).not.toBeInTheDocument()
  })
})

describe('spam training samples', () => {
  it('lists what the server kept, and deletes one', async () => {
    const user = userEvent.setup()
    const { client, calls } = fakeClient()
    renderSection(client)

    expect(await screen.findByText('Half price everything')).toBeInTheDocument()
    expect(screen.getByText('newsletter@example.test')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Delete the copy of Half price everything' }),
    )

    await waitFor(() => expect(calls.samples).toEqual(['s1']))
  })

  it('offers no way to ADD one — the account is not permitted to', async () => {
    const { client } = fakeClient()
    renderSection(client)

    await screen.findByText('Half price everything')
    expect(screen.queryByRole('button', { name: /add.*sample/i })).not.toBeInTheDocument()
  })
})

// ─── the password ────────────────────────────────────────────────────────────────────────────

describe('changing the account password', () => {
  async function openAndFill(
    user: ReturnType<typeof userEvent.setup>,
    values: { current: string; next: string; confirm: string },
  ): Promise<void> {
    await user.click(await screen.findByRole('button', { name: 'Change password…' }))
    await user.type(screen.getByLabelText('Current password'), values.current)
    await user.type(screen.getByLabelText('New password'), values.next)
    await user.type(screen.getByLabelText('Repeat new password'), values.confirm)
    await user.click(screen.getByRole('button', { name: 'Change password' }))
  }

  it('sends the current password with the new one, because the server requires it', async () => {
    const user = userEvent.setup()
    const { client, calls } = fakeClient()
    renderSection(client, sessionValue({ stalwart: true }))

    await openAndFill(user, { current: 'old-Pw1!', next: 'new-Pw1!', confirm: 'new-Pw1!' })

    await waitFor(() => expect(calls.passwords).toEqual([['old-Pw1!', 'new-Pw1!']]))
  })

  it('catches a mistyped repeat before the server ever sees it', async () => {
    const user = userEvent.setup()
    const { client, calls } = fakeClient()
    renderSection(client, sessionValue({ stalwart: true }))

    await openAndFill(user, { current: 'old-Pw1!', next: 'new-Pw1!', confirm: 'new-Pw2!' })

    expect(screen.getByText('The two new passwords are not the same.')).toBeInTheDocument()
    expect(calls.passwords).toEqual([])
  })

  it('asks a Basic session to sign in again — the stored credential is now the wrong one', async () => {
    // Waxwing signs in over HTTP Basic and re-sends those credentials on every request. Without
    // this the reader would keep working until some unrelated request came back 401 and the app
    // asked for a password out of nowhere.
    const user = userEvent.setup()
    const reportAuthExpired = vi.fn()
    const { client } = fakeClient()
    renderSection(client, sessionValue({ stalwart: true, method: 'basic', reportAuthExpired }))

    await openAndFill(user, { current: 'old-Pw1!', next: 'new-Pw1!', confirm: 'new-Pw1!' })

    await waitFor(() => expect(reportAuthExpired).toHaveBeenCalledTimes(1))
  })

  it('leaves an OAuth session alone — its access token is still good', async () => {
    const user = userEvent.setup()
    const reportAuthExpired = vi.fn()
    const { client } = fakeClient()
    renderSection(client, sessionValue({ stalwart: true, method: 'oauth', reportAuthExpired }))

    await openAndFill(user, { current: 'old-Pw1!', next: 'new-Pw1!', confirm: 'new-Pw1!' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(reportAuthExpired).not.toHaveBeenCalled()
  })

  it('quotes the server when it refuses, because `forbidden` alone does not say which refusal', async () => {
    // "Current secret is incorrect." and "Operation not allowed." (an external directory owns the
    // password) are the same `type`. The server's own sentence is the only thing that tells them
    // apart, and matching English server prose to translate it would break on the next release.
    const user = userEvent.setup()
    const { client } = fakeClient({
      onWrite: () => {
        throw new StalwartSetError('forbidden', 'Current secret is incorrect.')
      },
    })
    renderSection(client, sessionValue({ stalwart: true }))

    await openAndFill(user, { current: 'wrong', next: 'new-Pw1!', confirm: 'new-Pw1!' })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Your server refused this change.')
    expect(alert).toHaveTextContent('It said: Current secret is incorrect.')
  })
})

describe('accessibility', () => {
  it('has no WCAG A/AA violations in the section', async () => {
    const { client } = fakeClient()
    const { container } = renderSection(client)
    await screen.findByText('iPhone Mail')

    await expectNoA11yViolations(container)
  })

  it('has none in the dialog that shows the secret either', async () => {
    const user = userEvent.setup()
    const { client } = fakeClient()
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Create app password…' }))
    await user.type(screen.getByLabelText('What is it for?'), 'iPad Mail')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByText(SECRET)

    // The dialog renders through a portal, so it is under document.body, not the RTL container.
    await expectNoA11yViolations()
  })
})
