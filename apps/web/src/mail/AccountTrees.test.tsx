import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MailAccount } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../app/config'
import { ConfigProvider } from '../app/config-context'
import { RouterProvider } from '../app/route'
import en from '../i18n/locales/en/common.json'
import { putMailboxes, type ReplicaDb, ReplicaProvider } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb, mailbox } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { AccountTrees } from './AccountTrees'
import { useActiveAccountStore } from './active-account'
import { EMPTY_LIST_STATE, useListStore } from './list-store'
import { type ReadingHandlers, useReadingStore } from './reading-store'

// Two accounts whose mailbox ids COLLIDE (`a` = Inbox in both) — the per-account short ids that make
// the account switch correctness-critical.
const PRIMARY: MailAccount = {
  id: 'acctP',
  name: 'me@waxwing.test',
  isPersonal: true,
  isReadOnly: false,
}
const SHARED: MailAccount = {
  id: 'acctS',
  name: 'Team Inbox',
  isPersonal: false,
  isReadOnly: false,
}
const SHARED_RO: MailAccount = {
  id: 'acctR',
  name: 'Archive Box',
  isPersonal: false,
  isReadOnly: true,
}

let db: ReplicaDb
const dispatch = vi.fn()

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  setActiveEngine({ dispatch } as unknown as Parameters<typeof setActiveEngine>[0])
  useActiveAccountStore.getState().reset()
  useListStore.setState(EMPTY_LIST_STATE)
  useReadingStore.setState({ handlers: null })
  await putMailboxes(db, 'acctP', [
    mailbox('a', { role: 'inbox', name: 'Inbox' }),
    mailbox('work', { name: 'Work' }),
  ])
  await putMailboxes(db, 'acctS', [
    mailbox('a', { role: 'inbox', name: 'Inbox' }),
    mailbox('team', { name: 'Team Folder' }),
  ])
  await putMailboxes(db, 'acctR', [mailbox('a', { role: 'inbox', name: 'Inbox' })])
})

afterEach(async () => {
  setActiveEngine(null)
  useActiveAccountStore.getState().reset()
  useListStore.setState(EMPTY_LIST_STATE)
  useReadingStore.setState({ handlers: null })
  await db.delete()
})

function renderTrees(accounts: readonly MailAccount[]) {
  return render(
    <RouterProvider>
      <ConfigProvider config={DEFAULT_CONFIG}>
        <ToastProvider>
          {/* The ambient provider is the primary's — exactly how SyncEngineHost mounts it. */}
          <ReplicaProvider accountId="acctP" db={db}>
            <AccountTrees accounts={accounts} primaryAccountId="acctP" />
          </ReplicaProvider>
        </ToastProvider>
      </ConfigProvider>
    </RouterProvider>,
  )
}

/** A non-empty per-account state, as if the user had a selection open on the current account. */
function seedStaleSelection(): void {
  useListStore.setState({
    windowKey: 'stale-window',
    ids: ['e1'],
    focusIndex: 0,
    sourceMailboxId: 'a',
    selection: { selected: new Set(['e1']), anchor: 'e1', base: new Set() },
  })
  useReadingStore.setState({
    handlers: { emailId: 'e1', mailboxId: 'a' } as unknown as ReadingHandlers,
  })
}

describe('AccountTrees', () => {
  it('is a pass-through with no shared account: one tree, no account header or grouping', async () => {
    renderTrees([PRIMARY])

    expect(await screen.findByText('Inbox')).toBeInTheDocument()
    expect(await screen.findByText('Work')).toBeInTheDocument()
    // No account-name header, no "Shared" marker, no grouped region — byte-for-byte today's sidebar.
    // Ask for the ACCOUNT region by name: the harness's own ToastProvider renders a `region` too
    // ("Notifications"), so a bare `queryByRole('region')` would match that and never fail here.
    expect(screen.queryByText(PRIMARY.name)).not.toBeInTheDocument()
    expect(screen.queryByText(en.shell.accounts.shared)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: PRIMARY.name })).not.toBeInTheDocument()
  })

  it('groups the own account first, then each shared account as a named region', async () => {
    renderTrees([PRIMARY, SHARED, SHARED_RO])

    const primaryRegion = await screen.findByRole('region', { name: PRIMARY.name })
    const sharedRegion = screen.getByRole('region', { name: SHARED.name })
    const readOnlyRegion = screen.getByRole('region', { name: SHARED_RO.name })

    // Each section renders ITS OWN account's mailboxes (account-scoped ReplicaProvider), even though
    // the Inbox mailbox id (`a`) is identical across all three.
    expect(await within(primaryRegion).findByText('Work')).toBeInTheDocument()
    expect(await within(sharedRegion).findByText('Team Folder')).toBeInTheDocument()
    expect(within(primaryRegion).queryByText('Team Folder')).not.toBeInTheDocument()

    // "Shared" marks the delegated sections only.
    expect(within(sharedRegion).getByText(en.shell.accounts.shared)).toBeInTheDocument()
    expect(within(primaryRegion).queryByText(en.shell.accounts.shared)).not.toBeInTheDocument()

    // Read-only badge on the read-only account only.
    expect(within(readOnlyRegion).getByText(en.shell.accounts.readOnly)).toBeInTheDocument()
    expect(within(sharedRegion).queryByText(en.shell.accounts.readOnly)).not.toBeInTheDocument()
  })

  it('resets the list/reading stores when switching to another account (collision guard)', async () => {
    const user = userEvent.setup()
    renderTrees([PRIMARY, SHARED])

    const sharedRegion = await screen.findByRole('region', { name: SHARED.name })
    const sharedFolder = await within(sharedRegion).findByRole('treeitem', { name: /Team Folder/ })

    // The user had a live selection + open message on the PRIMARY account.
    seedStaleSelection()
    expect(useListStore.getState().selection.selected.size).toBe(1)
    expect(useReadingStore.getState().handlers).not.toBeNull()

    await user.click(sharedFolder)

    // The active account switched…
    expect(useActiveAccountStore.getState().accountId).toBe('acctS')
    // …and the per-account stores were wiped, so a stale `e`/swipe cannot fire against acctP's ids
    // through the byte-identical `windowKey`.
    expect(useListStore.getState()).toMatchObject({
      windowKey: '',
      ids: [],
      sourceMailboxId: null,
    })
    expect(useListStore.getState().selection.selected.size).toBe(0)
    expect(useReadingStore.getState().handlers).toBeNull()
  })

  it('switches back (primary→shared→primary) with a fresh, correctly-scoped selection', async () => {
    const user = userEvent.setup()
    renderTrees([PRIMARY, SHARED])

    const sharedRegion = await screen.findByRole('region', { name: SHARED.name })
    await user.click(await within(sharedRegion).findByRole('treeitem', { name: /Team Folder/ }))
    expect(useActiveAccountStore.getState().accountId).toBe('acctS')

    // Now pretend a selection built up on the SHARED account, then switch BACK to the primary.
    seedStaleSelection()
    const primaryRegion = screen.getByRole('region', { name: PRIMARY.name })
    await user.click(await within(primaryRegion).findByRole('treeitem', { name: /Work/ }))

    expect(useActiveAccountStore.getState().accountId).toBe('acctP')
    expect(useListStore.getState().selection.selected.size).toBe(0)
    expect(useReadingStore.getState().handlers).toBeNull()
  })

  it('does not reset when selecting within the already-active account', async () => {
    const user = userEvent.setup()
    renderTrees([PRIMARY, SHARED])

    const primaryRegion = await screen.findByRole('region', { name: PRIMARY.name })
    const work = await within(primaryRegion).findByRole('treeitem', { name: /Work/ })

    // A live selection on the (already active) primary must survive a same-account navigation —
    // the natural windowKey change handles that, so force-clearing it here would be a regression.
    seedStaleSelection()
    await user.click(work)

    expect(useActiveAccountStore.getState().accountId).toBeNull() // never left the primary
    expect(useListStore.getState().selection.selected.size).toBe(1)
    expect(useReadingStore.getState().handlers).not.toBeNull()
  })

  it('has no a11y violations when grouped', async () => {
    const { container } = renderTrees([PRIMARY, SHARED, SHARED_RO])
    // Wait for the trees to resolve so the scan covers real content, not the loading state.
    await screen.findByRole('region', { name: PRIMARY.name })
    await within(screen.getByRole('region', { name: SHARED.name })).findByText('Team Folder')
    await expectNoA11yViolations(container)
  })
})

describe('the route names the account (B37)', () => {
  it('links a shared tree with ?account=, and the primary without it', async () => {
    // The cold-start hole this closes: the active-account store is in-memory, so a reload, a restored
    // PWA or a notification tap resolves back to the PRIMARY while the path still names a delegated
    // account's mailbox — and per-account ids are short, so `a` is very likely a real but different
    // mailbox there. The pane would show the wrong mail and look entirely right doing it.
    const user = userEvent.setup()
    renderTrees([PRIMARY, SHARED])

    const shared = await screen.findByRole('region', { name: SHARED.name })
    await user.click(await within(shared).findByText('Team Folder'))
    expect(window.location.search).toContain(`account=${SHARED.id}`)

    // Switching BACK names the primary explicitly rather than dropping the parameter: the router
    // carries an existing `?account=` forward and cannot tell "no opinion" from "the user's own", so
    // an implicit link would leave the URL pointing at the shared account it just left.
    const primary = screen.getByRole('region', { name: PRIMARY.name })
    await user.click(await within(primary).findByText('Work'))
    expect(window.location.search).toContain(`account=${PRIMARY.id}`)
  })
})
