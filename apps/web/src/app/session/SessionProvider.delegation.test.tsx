/**
 * The S-4 probe as the {@link SessionProvider} really runs it — one batch, at connect, before
 * anything is built on the answer.
 *
 * `delegation.test.ts` pins the pure derivation; this pins the wiring: that the request is sent at
 * all, that it is ONE request however many accounts and areas are involved, and that a
 * single-account sign-in still sends nothing. Kept in a file of its own so the S-4 assertions do not
 * have to be threaded through the auth-flow suite next door.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Invocation, JmapClient } from '@waxwing/jmap'
import { MethodResponses } from '@waxwing/jmap'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_LIST_STATE, useListStore } from '../../mail/list-store'
import { useReadingStore } from '../../mail/reading-store'
import { resetReplicaForTests } from '../../sync'
import { DEFAULT_CONFIG } from '../config'
import { ServicesProvider } from '../services'
import { useSession } from './context'
import { SessionProvider } from './SessionProvider'
import { fakeJmapSession, makeFakeServices } from './test-fakes'

const FORBIDDEN = { type: 'forbidden', description: 'You do not have access to account shared-1' }

function Consumer() {
  const s = useSession()
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="accounts">{s.connected?.accounts.map((a) => a.id).join(',') ?? ''}</span>
      <span data-testid="contacts">
        {s.connected?.delegated
          .filter((a) => a.areas.contacts === 'granted')
          .map((a) => a.id)
          .join(',') ?? ''}
      </span>
      <span data-testid="files">
        {s.connected?.delegated
          .filter((a) => a.areas.files === 'granted')
          .map((a) => a.id)
          .join(',') ?? ''}
      </span>
      <button type="button" onClick={() => s.submitBasic('alice', 'pw', true)}>
        basic
      </button>
    </div>
  )
}

/**
 * A client that serves only `allowed` method names, and answers EVERY call in the batch — including
 * the refused ones, which is what the server does and what the one-batch design rests on.
 */
function fakeClient(session: JmapClient['session'], allowed: readonly string[]) {
  const call = vi.fn(async (invocations: Invocation[]) => {
    const responses: Invocation[] = invocations.map(([name, args, callId]) => {
      const accountId = (args as { accountId: string }).accountId
      return allowed.includes(name)
        ? [name, { accountId, state: 's', list: [], notFound: [] }, callId]
        : ['error', FORBIDDEN, callId]
    })
    return new MethodResponses(responses, 's0', undefined)
  })
  return { client: { session, call } as unknown as JmapClient, call }
}

async function signIn(client: JmapClient): Promise<void> {
  const user = userEvent.setup()
  const fake = makeFakeServices({ probePresent: true, client })
  render(
    <ServicesProvider value={fake.services}>
      <SessionProvider config={DEFAULT_CONFIG}>
        <Consumer />
      </SessionProvider>
    </ServicesProvider>,
  )
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('onboarding'))
  await user.click(screen.getByText('basic'))
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
}

afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  resetReplicaForTests()
  useListStore.setState(EMPTY_LIST_STATE)
  useReadingStore.setState({ handlers: null })
})

describe('the delegation probe at connect (S-4)', () => {
  const shared = fakeJmapSession('acc-1', 'alice@waxwing.test', {
    // The measured shape: a share of ANY one object advertises everything, mail included.
    shared: [{ id: 'shared-1', name: 'carol@waxwing.test' }],
  })

  it('THE ONE: a forbidden AddressBook/get leaves no contacts share — and no mail account', async () => {
    // Carol shared exactly one FILE. The session advertises mail, contacts and files for her.
    const { client, call } = fakeClient(shared, ['FileNode/get'])
    await signIn(client)

    expect(screen.getByTestId('contacts').textContent).toBe('')
    // …and because `Mailbox/get` was refused too, she is not in `accounts` — which is the list the
    // engine fleet runs one sync engine per entry of.
    expect(screen.getByTestId('accounts').textContent).toBe('acc-1')
    // The one area she really shared is the one that survives.
    expect(screen.getByTestId('files').textContent).toBe('shared-1')

    // ONE round trip for the whole question: three areas × one shared account, one batch.
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]?.[0]).toHaveLength(3)
  })

  it('keeps a shared account in every area the server does serve', async () => {
    const { client } = fakeClient(shared, ['Mailbox/get', 'AddressBook/get', 'FileNode/get'])
    await signIn(client)
    expect(screen.getByTestId('accounts').textContent).toBe('acc-1,shared-1')
    expect(screen.getByTestId('contacts').textContent).toBe('shared-1')
  })

  it('spends nothing at all on a sign-in with nothing shared', async () => {
    const { client, call } = fakeClient(fakeJmapSession(), [])
    await signIn(client)
    expect(screen.getByTestId('accounts').textContent).toBe('acc-1')
    expect(call).not.toHaveBeenCalled()
  })

  it('grants everything when the probe request itself fails — offline is not a denial', async () => {
    const client = {
      session: shared,
      call: vi.fn(async () => {
        throw new Error('offline')
      }),
    } as unknown as JmapClient
    await signIn(client)
    expect(screen.getByTestId('accounts').textContent).toBe('acc-1,shared-1')
    expect(screen.getByTestId('contacts').textContent).toBe('shared-1')
  })
})
