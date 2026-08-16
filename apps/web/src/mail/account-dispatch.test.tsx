/**
 * Account-aware dispatch (M4.4 Etappe 4) — every write seam reaches the engine of the account whose
 * {@link ReplicaProvider} it renders under, and NEVER the primary's.
 *
 * This is the regression test for the defect Etappe 3 made reachable. It is written against the
 * condition that makes the bug invisible rather than loud: both accounts here own a mailbox with the
 * id `a`, exactly as a real server hands them out (JMAP ids are per-account and short). So a write
 * mis-routed to the primary does not throw — it succeeds, on the wrong mail. Asserting "the primary
 * engine received nothing" is therefore the whole point; asserting "no error" would prove nothing.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Id } from '@waxwing/jmap'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ReplicaDb, ReplicaProvider } from '../sync'
import { clearEngines, type SyncEngine, setActiveEngine, setEngineFor } from '../sync/engine'
import { freshDb } from '../sync/test-utils'
import { useCleanupActions } from './cleanup/use-cleanup-actions'
import { useFolderActions } from './use-folder-actions'
import { useMessageActions } from './use-message-actions'

const PRIMARY = 'acctP'
const SHARED = 'acctS'
/** The colliding id: Inbox in BOTH accounts, which is what makes a mis-route silent. */
const INBOX = 'a'

let db: ReplicaDb
const primaryDispatch = vi.fn()
const sharedDispatch = vi.fn()
const primaryEmpty = vi.fn()
const sharedEmpty = vi.fn()

function engineFor(
  dispatch: typeof primaryDispatch,
  emptyMailbox: typeof primaryEmpty,
): SyncEngine {
  return { dispatch, emptyMailbox } as unknown as SyncEngine
}

beforeEach(() => {
  db = freshDb()
  for (const spy of [primaryDispatch, sharedDispatch, primaryEmpty, sharedEmpty]) spy.mockReset()
  const primary = engineFor(primaryDispatch, primaryEmpty)
  setActiveEngine(primary)
  setEngineFor(PRIMARY, primary)
  setEngineFor(SHARED, engineFor(sharedDispatch, sharedEmpty))
})

afterEach(async () => {
  clearEngines()
  await db.delete()
})

/** Renders `children` under one account's provider — the scope a real pane runs in. */
function inAccount(accountId: Id, children: React.ReactNode) {
  return render(
    <ReplicaProvider accountId={accountId} db={db}>
      {children}
    </ReplicaProvider>,
  )
}

function MessageActionButtons() {
  const actions = useMessageActions()
  return (
    <>
      <button type="button" onClick={() => actions.move(['e1'], INBOX, 'archive')}>
        move
      </button>
      <button type="button" onClick={() => actions.setFlagged(['e1'], true)}>
        flag
      </button>
      <button type="button" onClick={() => actions.destroy(['e1'])}>
        destroy
      </button>
      <span data-testid="available">{String(actions.available)}</span>
    </>
  )
}

function FolderActionButtons() {
  const actions = useFolderActions()
  return (
    <>
      <button type="button" onClick={() => actions.rename(INBOX, 'Renamed')}>
        rename
      </button>
      <button type="button" onClick={() => actions.remove(INBOX)}>
        remove
      </button>
    </>
  )
}

function CleanupButton() {
  const actions = useCleanupActions()
  return (
    <button type="button" onClick={() => void actions.emptyMailbox(INBOX)}>
      empty
    </button>
  )
}

describe('account-aware dispatch (M4.4 Etappe 4)', () => {
  it('sends message actions to the SHARED engine when rendered in the shared account', async () => {
    const user = userEvent.setup()
    inAccount(SHARED, <MessageActionButtons />)

    await user.click(screen.getByText('move'))
    await user.click(screen.getByText('flag'))
    await user.click(screen.getByText('destroy'))

    expect(sharedDispatch).toHaveBeenCalledTimes(3)
    // The assertion that matters: the primary's engine saw NOTHING. Before Etappe 4 it saw all three,
    // each carrying the shared account's `a` — the primary's own Inbox id.
    expect(primaryDispatch).not.toHaveBeenCalled()
    expect(sharedDispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'move',
      emailIds: ['e1'],
      from: INBOX,
      to: 'archive',
    })
  })

  it('sends folder actions to the engine of the tree they belong to', async () => {
    const user = userEvent.setup()
    inAccount(SHARED, <FolderActionButtons />)

    await user.click(screen.getByText('rename'))
    await user.click(screen.getByText('remove'))

    expect(sharedDispatch).toHaveBeenCalledTimes(2)
    expect(primaryDispatch).not.toHaveBeenCalled()
    expect(sharedDispatch.mock.calls[1]?.[0]).toMatchObject({ kind: 'deleteMailbox', id: INBOX })
  })

  it('empties the SHARED mailbox, not the primary one of the same id', async () => {
    // The most destructive seam: `emptyMailbox` pages the account's whole folder and destroys it, so a
    // mis-route silently wipes a different account's Inbox.
    const user = userEvent.setup()
    inAccount(SHARED, <CleanupButton />)

    await user.click(screen.getByText('empty'))

    expect(sharedEmpty).toHaveBeenCalledWith(INBOX)
    expect(primaryEmpty).not.toHaveBeenCalled()
  })

  it('keeps the primary account on its own engine', async () => {
    const user = userEvent.setup()
    inAccount(PRIMARY, <MessageActionButtons />)

    await user.click(screen.getByText('move'))

    expect(primaryDispatch).toHaveBeenCalledTimes(1)
    expect(sharedDispatch).not.toHaveBeenCalled()
  })

  it('refuses to dispatch — and reports unavailable — for an account with no engine', async () => {
    const user = userEvent.setup()
    inAccount('acctRevoked', <MessageActionButtons />)

    expect(screen.getByTestId('available')).toHaveTextContent('false')
    await user.click(screen.getByText('move'))

    expect(primaryDispatch).not.toHaveBeenCalled()
    expect(sharedDispatch).not.toHaveBeenCalled()
  })

  it('reports available for an account that HAS an engine', () => {
    inAccount(SHARED, <MessageActionButtons />)

    expect(screen.getByTestId('available')).toHaveTextContent('true')
  })
})
