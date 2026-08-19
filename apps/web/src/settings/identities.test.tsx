/**
 * Settings → Identities (M5.1, FR-CMP-06, RFC 8621 §6).
 *
 * The JMAP client is a fake and so is the editor (the real one lazy-loads Squire, which jsdom cannot
 * run). What is asserted is the contract the section actually owes: the `/set` shapes it sends —
 * with the `ifInState` that came from the `/get` — the immutability of an existing address, the
 * confirmation a destroy goes through, the two failures the RFC lets a server name, and the mirror
 * into the replica that the composer's From selector reads.
 *
 * The error tests assert the TRANSLATED TEXT rather than the key. `failureText()` spells its keys
 * out precisely because a computed one would render as `settings.identities.error.conflict` on
 * screen the day the key moves, and a `toHaveTextContent('settings.identities…')` assertion would
 * happily agree.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Id, Identity, IdentityCreate, IdentityWritable } from '@waxwing/jmap'
import { JmapMethodError } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeEngine, type FakeEngine, fakeEditorFactory } from '../compose/test-editor'
import { putIdentities, type ReplicaDb, ReplicaProvider, useIdentities } from '../sync'
import { freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { IdentitiesSection } from './IdentitiesSection'
import { type IdentityClient, IdentitySetError, type IdentitySnapshot } from './identity-client'

function identity(over: Partial<Identity> & Pick<Identity, 'id' | 'email'>): Identity {
  return {
    name: '',
    replyTo: null,
    bcc: null,
    textSignature: '',
    htmlSignature: '',
    mayDelete: true,
    ...over,
  }
}

/** The server's default address: signed, reply-to'd, and undeletable (RFC 8621 §6 `mayDelete`). */
const PRIMARY = identity({
  id: 'id-1',
  name: 'Alice Adams',
  email: 'alice@x.test',
  replyTo: [{ name: 'Alice', email: 'reply@x.test' }],
  textSignature: 'Regards, Alice',
  htmlSignature: '<div>Regards</div>',
  mayDelete: false,
})
const ALIAS = identity({ id: 'id-2', name: 'Sales', email: 'sales@x.test' })

interface Calls {
  lists: number
  readonly creates: Array<{ identity: IdentityCreate; ifInState: string }>
  readonly updates: Array<{ id: Id; patch: IdentityWritable; ifInState: string }>
  readonly destroys: Array<{ id: Id; ifInState: string }>
}

interface Fake {
  readonly client: IdentityClient
  readonly calls: Calls
  /** Rewrite what the NEXT `list` answers — another client having written in the meantime. */
  setServer(identities: readonly Identity[], state: string): void
}

function fakeClient(
  options: {
    identities?: readonly Identity[]
    /** Throws to make a write fail; the fake applies nothing in that case. */
    onWrite?: () => void
  } = {},
): Fake {
  let current: readonly Identity[] = options.identities ?? [PRIMARY, ALIAS]
  let state = 'st-1'
  const calls: Calls = { lists: 0, creates: [], updates: [], destroys: [] }
  const snapshot = (): IdentitySnapshot => ({ identities: current, state })

  const client: IdentityClient = {
    list: async () => {
      calls.lists += 1
      return snapshot()
    },
    create: async (created, ifInState) => {
      calls.creates.push({ identity: created, ifInState })
      options.onWrite?.()
      const made = identity({ ...created, id: 'id-new' })
      current = [...current, made]
      state = 'st-2'
      return { snapshot: snapshot(), id: made.id }
    },
    update: async (id, patch, ifInState) => {
      calls.updates.push({ id, patch, ifInState })
      options.onWrite?.()
      current = current.map((one) => (one.id === id ? { ...one, ...patch } : one))
      state = 'st-2'
      return snapshot()
    },
    destroy: async (id, ifInState) => {
      calls.destroys.push({ id, ifInState })
      options.onWrite?.()
      current = current.filter((one) => one.id !== id)
      state = 'st-2'
      return snapshot()
    },
  }

  return {
    client,
    calls,
    setServer: (identities, nextState) => {
      current = identities
      state = nextState
    },
  }
}

function renderSection(client: IdentityClient, engine?: FakeEngine) {
  return render(
    <ToastProvider>
      <IdentitiesSection client={client} editorFactory={fakeEditorFactory(engine)} />
    </ToastProvider>,
  )
}

/**
 * The engine is created asynchronously (the real factory lazy-loads Squire), and the toolbar is
 * `busy` until it resolves — so this is the honest "the editor is mounted and listening" signal.
 * Without it a test could type into an engine whose `input` listener is not registered yet.
 */
async function editorReady(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Bold' })).toBeEnabled())
}

describe('<IdentitiesSection>', () => {
  it('lists every identity by name and address', async () => {
    const { client } = fakeClient()
    renderSection(client)

    expect(await screen.findByText('Alice Adams')).toBeInTheDocument()
    expect(screen.getByText('alice@x.test')).toBeInTheDocument()
    expect(screen.getByText('Sales')).toBeInTheDocument()
    expect(screen.getByText('sales@x.test')).toBeInTheDocument()
  })

  it('says it is still LOADING rather than claiming the account has no identities', async () => {
    // The two states look identical in a list, and getting them the wrong way round tells a user
    // with a slow connection that their identities are gone.
    let settle: (snapshot: IdentitySnapshot) => void = () => {}
    const client: IdentityClient = {
      ...fakeClient().client,
      list: () =>
        new Promise<IdentitySnapshot>((resolve) => {
          settle = resolve
        }),
    }
    renderSection(client)

    expect(screen.getByText('Loading identities…')).toBeInTheDocument()
    expect(screen.queryByText('This account has no send identities.')).not.toBeInTheDocument()

    await act(async () => settle({ identities: [], state: 'st-1' }))

    expect(await screen.findByText('This account has no send identities.')).toBeInTheDocument()
    expect(screen.queryByText('Loading identities…')).not.toBeInTheDocument()
  })

  it('offers no delete for an identity the server protects, and says why', async () => {
    // `mayDelete: false` is on the record so a client does not have to offer a button whose only
    // outcome is a `forbidden` SetError.
    const { client } = fakeClient()
    renderSection(client)

    await screen.findByText('Alice Adams')
    expect(screen.queryByRole('button', { name: 'Delete alice@x.test' })).not.toBeInTheDocument()
    expect(
      screen.getByText('Default address — the server does not allow deleting it.'),
    ).toBeInTheDocument()
    // …and the deletable one still has its button, so this cannot pass by rendering no buttons.
    expect(screen.getByRole('button', { name: 'Delete sales@x.test' })).toBeInTheDocument()
  })

  it('edits an identity: its values fill the form, the address is read-only, and the patch omits it', async () => {
    const user = userEvent.setup()
    const { client, calls } = fakeClient()
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Edit Alice Adams' }))

    const email = screen.getByLabelText('Email address')
    expect(email).toHaveValue('alice@x.test')
    // RFC 8621 §6: the address of an existing identity is immutable. Read-only, not disabled — the
    // value still has to be readable and copyable.
    expect(email).toHaveAttribute('readonly')
    expect(
      screen.getByText(
        'The address of an existing identity cannot be changed. Create a new identity instead.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Reply-to')).toHaveValue('Alice <reply@x.test>')
    expect(screen.getByLabelText('Plain-text signature')).toHaveValue('Regards, Alice')

    await editorReady()
    await user.clear(screen.getByLabelText('Display name'))
    await user.type(screen.getByLabelText('Display name'), 'Alice A.')
    await user.click(screen.getByRole('button', { name: 'Save identity' }))

    await waitFor(() => expect(calls.updates).toHaveLength(1))
    expect(calls.updates[0]?.id).toBe('id-1')
    // The `ifInState` from the `/get`, not an invented one — that is what catches a concurrent edit.
    expect(calls.updates[0]?.ifInState).toBe('st-1')
    // ONLY the changed field. A patch that carried every writable property would write the LOADED
    // signature back — and the loaded signature is the sanitized one, so renaming an identity would
    // silently delete whatever the sanitizer had dropped (an inline `<svg>` logo, say) from a
    // signature the user never touched.
    expect(calls.updates[0]?.patch).toEqual({ name: 'Alice A.' })
    // An `email` in an update is rejected as `invalidProperties`, so it must not be in the patch.
    expect(calls.updates[0]?.patch).not.toHaveProperty('email')
  })

  it('creates from an empty, EDITABLE address field', async () => {
    const user = userEvent.setup()
    const { client, calls } = fakeClient()
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Add identity' }))

    const email = screen.getByLabelText('Email address')
    expect(email).toHaveValue('')
    expect(email).not.toHaveAttribute('readonly')

    await editorReady()
    await user.type(email, 'new@x.test')
    await user.type(screen.getByLabelText('Display name'), 'New One')
    await user.click(screen.getByRole('button', { name: 'Create identity' }))

    await waitFor(() => expect(calls.creates).toHaveLength(1))
    expect(calls.creates[0]?.ifInState).toBe('st-1')
    expect(calls.creates[0]?.identity).toMatchObject({ email: 'new@x.test', name: 'New One' })
    expect(calls.updates).toHaveLength(0)
    expect(await screen.findByText('Identity created')).toBeInTheDocument()
  })

  it('asks before deleting, and only the confirmation reaches the server', async () => {
    const user = userEvent.setup()
    const { client, calls } = fakeClient()
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Delete sales@x.test' }))

    const dialog = await screen.findByRole('dialog', { name: 'Delete identity?' })
    expect(
      within(dialog).getByText('sales@x.test will no longer be available as a sender address.'),
    ).toBeInTheDocument()
    expect(calls.destroys).toHaveLength(0) // opening the dialog is not the decision

    // Backing out destroys nothing…
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(calls.destroys).toHaveLength(0)

    // …and only the confirm button does.
    await user.click(screen.getByRole('button', { name: 'Delete sales@x.test' }))
    const reopened = await screen.findByRole('dialog', { name: 'Delete identity?' })
    await user.click(within(reopened).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(calls.destroys).toEqual([{ id: 'id-2', ifInState: 'st-1' }]))
    await waitFor(() => expect(screen.queryByText('sales@x.test')).not.toBeInTheDocument())
  })

  it('reports a stale ifInState as a conflict and repaints from the server', async () => {
    // A stale `ifInState` aborts the METHOD (RFC 8620 §5.3), so it arrives as a thrown
    // `stateMismatch` rather than in `notUpdated`. Keeping our copy on screen would hide whatever
    // the other client wrote — and the state string we hold is now worthless anyway.
    const user = userEvent.setup()
    const fake = fakeClient({
      onWrite: () => {
        throw new JmapMethodError({ type: 'stateMismatch' }, 'i0', 'Identity/set')
      },
    })
    renderSection(fake.client)

    await user.click(await screen.findByRole('button', { name: 'Edit Alice Adams' }))
    await editorReady()
    // An actual edit: a save that changes nothing no longer reaches the server at all, so without
    // this the conflict could not arise in the first place.
    await user.clear(screen.getByLabelText('Display name'))
    await user.type(screen.getByLabelText('Display name'), 'Renamed here')
    fake.setServer([identity({ ...PRIMARY, name: 'Renamed elsewhere' }), ALIAS], 'st-9')
    await user.click(screen.getByRole('button', { name: 'Save identity' }))

    await waitFor(() => expect(fake.calls.updates).toHaveLength(1))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The identities were changed elsewhere. Your change was not saved — the current state is shown above.',
    )
    // Repainted, not just complained about: the list now shows the OTHER client's version.
    expect(await screen.findByText('Renamed elsewhere')).toBeInTheDocument()
    await waitFor(() => expect(fake.calls.lists).toBe(2))
  })

  it('says what to do when the address is not one the account owns', async () => {
    // What Stalwart ACTUALLY answers for this (ADR-022, measured): `invalidProperties` naming
    // `email`, not the `forbiddenFrom` the RFC defines. The generic "rejected one of these values"
    // would leave the user with nothing to act on; the fix is an alias, added server-side.
    const user = userEvent.setup()
    const { client } = fakeClient({
      onWrite: () => {
        throw new IdentitySetError(
          'invalidProperties',
          'E-mail address not configured for this account.',
          ['email'],
        )
      },
    })
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Add identity' }))
    await editorReady()
    await user.type(screen.getByLabelText('Email address'), 'someone@elsewhere.test')
    await user.click(screen.getByRole('button', { name: 'Create identity' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('not set up for your account')
  })

  it('sends nothing when Save is pressed without an edit', async () => {
    // A `/set` that writes nothing is not free: it spends the `ifInState` it was given, so it can
    // come back as a conflict caused by SOMEBODY ELSE's edit — shown to a user who typed nothing.
    const user = userEvent.setup()
    const { client, calls } = fakeClient()
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Edit Alice Adams' }))
    await editorReady()
    await user.click(screen.getByRole('button', { name: 'Save identity' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save identity' })).not.toBeInTheDocument(),
    )
    expect(calls.updates).toHaveLength(0)
  })

  it('does not report an aborted load as a failure', async () => {
    // The effect aborts its own request on teardown — StrictMode double-invokes it, and the client
    // identity changes on reconnect or an account switch. Treating that abort as an error painted
    // "could not be loaded" over a list that had loaded perfectly.
    //
    // The abort is made to land AFTER the successful reload on purpose: if it landed first, the
    // success path's own `setFailure(null)` would hide the bug and this test could not fail.
    let attempt = 0
    const aborting: IdentityClient = {
      ...fakeClient().client,
      list: (signal?: AbortSignal) => {
        attempt += 1
        if (attempt > 1) return Promise.resolve({ identities: [PRIMARY], state: 'st-1' })
        return new Promise<IdentitySnapshot>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 20)
          })
        })
      },
    }
    // A NEW client object, so the load effect genuinely re-runs and aborts the first request —
    // rerendering with the same one changes no dependency and would abort nothing.
    const second: IdentityClient = { ...aborting }
    const view = renderSection(aborting)
    view.rerender(
      <ToastProvider>
        <IdentitiesSection client={second} editorFactory={fakeEditorFactory()} />
      </ToastProvider>,
    )

    expect(await screen.findByText('alice@x.test')).toBeInTheDocument()
    await waitFor(() => expect(attempt).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(screen.queryByText('The identities could not be loaded.')).not.toBeInTheDocument()
  })

  it('names the refused sender address when the server rejects a create', async () => {
    const user = userEvent.setup()
    const { client } = fakeClient({
      onWrite: () => {
        throw new IdentitySetError('forbiddenFrom', 'not your address')
      },
    })
    renderSection(client)

    await user.click(await screen.findByRole('button', { name: 'Add identity' }))
    await editorReady()
    await user.type(screen.getByLabelText('Email address'), 'boss@x.test')
    await user.click(screen.getByRole('button', { name: 'Create identity' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server does not allow you to send from this address.',
    )
  })

  it('sanitizes the HTML signature in BOTH directions', async () => {
    // Coming from the server it is untrusted markup on its way into a contenteditable in the app
    // document — the `position:fixed` overlay `quoted-html.ts` was written for. Going back it is
    // what every future draft pastes in, so it must be what the composer would have kept.
    const user = userEvent.setup()
    const engine = createFakeEngine()
    const hostile = identity({
      id: 'id-1',
      email: 'alice@x.test',
      name: 'Alice',
      htmlSignature: '<div style="position:fixed;top:0;color:red">Sig</div>',
    })
    const { client, calls } = fakeClient({ identities: [hostile] })
    renderSection(client, engine)

    await user.click(await screen.findByRole('button', { name: 'Edit Alice' }))
    await editorReady()

    // Inbound: the geometry is gone before the markup ever reaches the editor.
    expect(engine.html).not.toContain('position:fixed')
    expect(engine.html).toContain('Sig')

    // Outbound: the same pass runs on what is stored, so a pasted overlay cannot be saved either.
    // The TEXT changes too — the patch carries only fields that differ after sanitizing, and
    // `position:fixed` alone does not differ: it is stripped on both sides.
    engine.html = '<div style="position:fixed;color:red">Sig two</div>'
    engine.emit('input')
    await user.click(screen.getByRole('button', { name: 'Save identity' }))

    await waitFor(() => expect(calls.updates).toHaveLength(1))
    const saved = calls.updates[0]?.patch.htmlSignature ?? ''
    expect(saved).not.toContain('position:fixed')
    expect(saved).toContain('Sig two')
  })

  it('saves a signature typed a moment ago (the editor debounce)', async () => {
    // `RichTextEditor` debounces `onChange` by 200 ms to keep typing off the parent's render path.
    // A user who writes a signature and reaches straight for Save is inside that window — the
    // vacation form shipped exactly this bug and silently saved an empty body. No waiting here on
    // purpose: the debounce must NOT have elapsed, or the test cannot fail.
    const user = userEvent.setup()
    const engine = createFakeEngine()
    const { client, calls } = fakeClient()
    renderSection(client, engine)

    await user.click(await screen.findByRole('button', { name: 'Edit Sales' }))
    await editorReady()

    engine.html = '<div>Sales team</div>'
    engine.emit('input')
    await user.click(screen.getByRole('button', { name: 'Save identity' }))

    await waitFor(() => expect(calls.updates).toHaveLength(1))
    expect(calls.updates[0]?.patch.htmlSignature).toContain('Sales team')
  })

  it('has no a11y violations, in the list and in the confirmation dialog', async () => {
    const user = userEvent.setup()
    const { client } = fakeClient()
    const { container } = renderSection(client)

    await screen.findByText('Alice Adams')
    await expectNoA11yViolations(container)

    await user.click(screen.getByRole('button', { name: 'Delete sales@x.test' }))
    await screen.findByRole('dialog', { name: 'Delete identity?' })
    // The Dialog renders through a portal, so scan document.body, not the RTL container.
    await expectNoA11yViolations()
  })
})

/**
 * The replica half — the reason `replaceIdentities` exists at all.
 *
 * The section talks to the SERVER, but the composer's From selector reads the REPLICA, and the sync
 * engine pulls identities once per leadership session. Without the mirror an identity edited here
 * would not reach a draft until the next sign-in, and a DELETED one would keep being offered as a
 * sender address forever — the draft written from it then fails to send with `noIdentity`.
 *
 * So these render through `ReplicaProvider` against a real Dexie database and assert what
 * `useIdentities()` — the selector's own hook — actually sees.
 */
describe('the replica the composer reads from', () => {
  let db: ReplicaDb

  beforeEach(() => {
    db = freshDb()
  })
  afterEach(async () => {
    await db.delete()
  })

  /** The From selector's own hook, rendered as text so the assertions go through it. */
  function IdentityProbe() {
    const rows = useIdentities()
    return <div data-testid="probe">{(rows ?? []).map((row) => row.email).join(' ')}</div>
  }

  function renderWithReplica(client: IdentityClient) {
    return render(
      <ReplicaProvider accountId="a" db={db}>
        <ToastProvider>
          <IdentitiesSection client={client} editorFactory={fakeEditorFactory()} />
          <IdentityProbe />
        </ToastProvider>
      </ReplicaProvider>,
    )
  }

  it('mirrors a saved identity into the replica', async () => {
    const user = userEvent.setup()
    const { client } = fakeClient()
    renderWithReplica(client)

    await user.click(await screen.findByRole('button', { name: 'Edit Sales' }))
    await editorReady()
    await user.clear(screen.getByLabelText('Display name'))
    await user.type(screen.getByLabelText('Display name'), 'Sales team')
    await user.click(screen.getByRole('button', { name: 'Save identity' }))

    await waitFor(async () =>
      expect((await db.identities.get(['a', 'id-2']))?.name).toBe('Sales team'),
    )
  })

  it('drops a destroyed identity from the replica', async () => {
    // A `bulkPut` cannot do this, and the row lingering is not cosmetic: it stays in the From
    // selector of every draft, for an address the server no longer knows.
    const user = userEvent.setup()
    const { client } = fakeClient()
    // Seeded first, so the row exists even before the section's own load mirrors it.
    await putIdentities(db, 'a', [{ ...PRIMARY }, { ...ALIAS }])
    renderWithReplica(client)

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('sales@x.test'))

    await user.click(screen.getByRole('button', { name: 'Delete sales@x.test' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete identity?' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(db.identities.get(['a', 'id-2'])).resolves.toBeUndefined())
    // …and the hook the composer uses agrees — the primary is still there, the alias is not.
    await waitFor(() => {
      const probe = screen.getByTestId('probe')
      expect(probe).toHaveTextContent('alice@x.test')
      expect(probe).not.toHaveTextContent('sales@x.test')
    })
  })
})
