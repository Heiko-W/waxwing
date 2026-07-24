import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../app/route'
import {
  canonicalContactQueryKey,
  putAddressBooks,
  putContactCards,
  putContactQueryCache,
  type ReplicaDb,
  ReplicaProvider,
} from '../sync'
import { setActiveEngine } from '../sync/engine'
import { addressBook, contactCard, freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ContactsScreen } from './ContactsScreen'

vi.mock('./use-contact-photo', () => ({ useContactPhoto: () => undefined }))

// TanStack Virtual viewport stubs (see ContactList.test.tsx / ContactsScreen.test.tsx).
const rect = { width: 400, height: 600, top: 0, left: 0, right: 400, bottom: 600, x: 0, y: 0 }
class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.cb(
      [
        {
          target,
          contentRect: rect,
          borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          devicePixelContentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    )
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ ...rect, toJSON: () => rect }),
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} })
})
afterAll(() => vi.unstubAllGlobals())

let db: ReplicaDb
let dispatch: ReturnType<typeof vi.fn>

beforeEach(async () => {
  db = freshDb()
  dispatch = vi.fn().mockResolvedValue(undefined)
  setActiveEngine({
    watchContactQuery: vi.fn(() => 'k'),
    unwatchContactQuery: vi.fn(),
    dispatch,
  } as unknown as Parameters<typeof setActiveEngine>[0])

  await putAddressBooks(db, 'a', [addressBook('personal', { name: 'Personal', isDefault: true })])
  await putContactCards(db, 'a', [
    contactCard('c1', {
      name: { full: 'Alice Anderson' },
      addressBookIds: { personal: true },
      emails: { e1: { '@type': 'EmailAddress', address: 'alice@x.test' } },
    }),
    contactCard('c2', {
      name: { full: 'Bob Brown' },
      addressBookIds: { personal: true },
      emails: { e1: { '@type': 'EmailAddress', address: 'bob@x.test' } },
    }),
    contactCard('g1', {
      uid: 'uid-g1',
      kind: 'group',
      name: { '@type': 'Name', full: 'Team' },
      members: { 'uid-c1': true },
      addressBookIds: { personal: true },
    }),
  ])
  await putContactQueryCache(db, {
    accountId: 'a',
    key: canonicalContactQueryKey({ filter: { inAddressBook: 'personal' } }),
    ids: ['c1', 'c2'],
    queryState: 'q',
    total: 2,
    upToId: 'c2',
    filter: { inAddressBook: 'personal' },
    sort: null,
    lastUsedAt: 1,
  })
})

afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

function renderScreen(path: string) {
  window.history.pushState(null, '', path)
  return render(
    <RouterProvider>
      <ReplicaProvider accountId="a" db={db}>
        <ContactsScreen />
      </ReplicaProvider>
    </RouterProvider>,
  )
}

describe('ContactsScreen groups', () => {
  it('lists groups in the rail but not in the individual contact list', async () => {
    renderScreen('/contacts/personal')
    // The group shows in the rail…
    expect(await screen.findByRole('button', { name: 'Team' })).toBeInTheDocument()
    // …and the individual list shows only the two people, never the group.
    await screen.findByRole('option', { name: 'Alice Anderson' })
    expect(screen.queryByRole('option', { name: 'Team' })).not.toBeInTheDocument()
  })

  it('shows a group’s members when it is selected', async () => {
    const user = userEvent.setup()
    renderScreen('/contacts/personal')
    await user.click(await screen.findByRole('button', { name: 'Team' }))

    expect(await screen.findByRole('link', { name: 'Alice Anderson' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Team' })).toBeInTheDocument()
    // Bob is not a member, so he is not in the member view.
    expect(screen.queryByRole('link', { name: 'Bob Brown' })).not.toBeInTheDocument()
  })

  it('creates a group through the New-group form (createContactCard enqueue)', async () => {
    const user = userEvent.setup()
    renderScreen('/contacts/personal')

    await user.click(await screen.findByRole('button', { name: 'New group' }))
    expect(screen.getByRole('heading', { name: 'New group' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('Group name'), 'Friends')
    await user.click(screen.getByRole('button', { name: 'Add Bob Brown' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const call = dispatch.mock.calls.find((c) => c[0]?.kind === 'createContactCard')
      expect(call).toBeDefined()
      expect(call?.[0].card.kind).toBe('group')
      expect(call?.[0].card.name).toEqual({ '@type': 'Name', full: 'Friends' })
      expect(call?.[0].card.members).toEqual({ 'uid-c2': true })
    })
  })

  it('adds a member through the Edit-group form (updateContactCard enqueue)', async () => {
    const user = userEvent.setup()
    renderScreen('/contacts/personal')
    await user.click(await screen.findByRole('button', { name: 'Team' }))
    await user.click(await screen.findByRole('button', { name: 'Edit group' }))
    expect(screen.getByRole('heading', { name: 'Edit group' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add Bob Brown' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const call = dispatch.mock.calls.find((c) => c[0]?.kind === 'updateContactCard')
      expect(call?.[0]).toMatchObject({
        kind: 'updateContactCard',
        id: 'g1',
        patch: { members: { 'uid-c1': true, 'uid-c2': true } },
      })
    })
  })

  it('deletes a group after confirmation (deleteContactCard enqueue)', async () => {
    const user = userEvent.setup()
    renderScreen('/contacts/personal')
    await user.click(await screen.findByRole('button', { name: 'Team' }))
    await user.click(await screen.findByRole('button', { name: 'Delete group' }))
    // Confirm in the dialog.
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      const call = dispatch.mock.calls.find((c) => c[0]?.kind === 'deleteContactCard')
      expect(call?.[0]).toMatchObject({ kind: 'deleteContactCard', id: 'g1' })
    })
  })

  it('disables New group in a read-only address book (read-only guard)', async () => {
    await putAddressBooks(db, 'a', [
      addressBook('ro', {
        name: 'Shared',
        myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
      }),
    ])
    renderScreen('/contacts/ro')
    expect(await screen.findByRole('button', { name: 'New group' })).toBeDisabled()
  })

  it('has no axe violations with a group selected', async () => {
    const user = userEvent.setup()
    const { container } = renderScreen('/contacts/personal')
    await user.click(await screen.findByRole('button', { name: 'Team' }))
    await screen.findByRole('link', { name: 'Alice Anderson' })
    await expectNoA11yViolations(container)
  })
})
