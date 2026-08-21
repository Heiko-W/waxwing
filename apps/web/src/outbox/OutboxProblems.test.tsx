import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionContext } from '../app/session/context'
import {
  enqueue,
  type OutboxConflict,
  type OutboxRow,
  putMailboxes,
  type ReplicaDb,
  ReplicaProvider,
} from '../sync'
import { clearEngines, INITIAL_ENGINE_STATUS, setActiveEngine, setEngineFor } from '../sync/engine'
import { setEngineStatus } from '../sync/engine/status'
import { freshDb, mailbox } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ToastProvider } from '../ui'
import { OutboxProblemsButton } from './OutboxProblemsButton'

const ACC = 'a'
let db: ReplicaDb

const retryFailed = vi.fn(async () => true)
const discardFailed = vi.fn(async () => true)
const discardAllFailed = vi.fn(async () => {})

function deadLetter(id: string, over: Partial<OutboxRow> = {}): OutboxRow {
  const conflict: OutboxConflict = {
    code: 'folderGone',
    errorType: 'invalidProperties',
    detail: 'mailboxIds/archive',
    ids: ['e1'],
    at: Date.UTC(2026, 6, 1),
  }
  return {
    accountId: ACC,
    id,
    type: 'move',
    payload: { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
    ifInState: null,
    status: 'error',
    attempts: 1,
    createdAt: 1,
    lastError: 'invalidProperties',
    notBefore: null,
    undo: null,
    conflict,
    ...over,
  }
}

beforeEach(async () => {
  db = freshDb()
  vi.clearAllMocks()
  setActiveEngine({ retryFailed, discardFailed, discardAllFailed } as unknown as Parameters<
    typeof setActiveEngine
  >[0])
  await putMailboxes(db, ACC, [mailbox('inbox', { name: 'Inbox', role: 'inbox' })])
})

afterEach(async () => {
  setActiveEngine(null)
  setEngineStatus(INITIAL_ENGINE_STATUS)
  await db.delete()
})

function renderButton() {
  return render(
    <ToastProvider>
      <ReplicaProvider accountId={ACC} db={db}>
        <OutboxProblemsButton />
      </ReplicaProvider>
    </ToastProvider>,
  )
}

describe('OutboxProblemsButton', () => {
  it('is hidden entirely while nothing has failed', () => {
    renderButton()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('announces the count in its accessible name and shows it as a badge', async () => {
    // Counts the ROWS in the replica (B32), not `EngineStatus.failedActions` — that scalar is the
    // primary engine's, and shared engines are given a discarding sink, so it could not see a
    // refused action on a delegated account. Seeding rows is therefore the honest setup: it is what
    // the surface actually reads.
    await enqueue(db, deadLetter('i1'))
    await enqueue(db, deadLetter('i2'))
    await enqueue(db, deadLetter('i3'))
    renderButton()

    // Pluralized, not a bare number: "3 actions didn’t go through".
    expect(
      await screen.findByRole('button', { name: '3 actions didn’t go through' }),
    ).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('opens the problems dialog from the keyboard', async () => {
    const user = userEvent.setup()
    await enqueue(db, deadLetter('i1'))
    renderButton()
    // The button counts real rows now, so it appears when the query resolves — not on first paint.
    await screen.findByRole('button', { name: /didn’t go through/ })

    await user.tab()
    expect(screen.getByRole('button')).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('dialog')).toHaveAccessibleName('Some actions didn’t go through')
  })

  it('has no axe violations (button + dialog)', async () => {
    const user = userEvent.setup()
    await enqueue(db, deadLetter('i1'))
    renderButton()
    await screen.findByRole('button', { name: /didn’t go through/ })
    await expectNoA11yViolations(document.body)

    await user.click(screen.getByRole('button'))
    await screen.findByRole('dialog')
    await expectNoA11yViolations(document.body)
  })
})

describe('OutboxProblemsDialog', () => {
  async function openDialog() {
    const user = userEvent.setup()
    renderButton()
    await user.click(await screen.findByRole('button', { name: /didn’t go through/ }))
    await screen.findByRole('dialog')
    return user
  }

  it('lists each problem with its cause, the server detail and when it happened', async () => {
    await enqueue(db, deadLetter('i1'))
    await openDialog()

    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent('Couldn’t move — that folder was deleted.')
    expect(items[0]).toHaveTextContent('mailboxIds/archive') // the server's own words, as detail only
  })

  it('offers Try again only where a retry could work, and Discard always', async () => {
    await enqueue(db, deadLetter('i1')) // folderGone on a move → not retryable
    await enqueue(
      db,
      deadLetter('i2', {
        type: 'setKeywords',
        payload: { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
        conflict: {
          code: 'forbidden',
          errorType: 'forbidden',
          detail: null,
          ids: ['e1'],
          at: 1,
        },
      }),
    )
    const user = await openDialog()

    await waitFor(async () => expect(await screen.findAllByRole('listitem')).toHaveLength(2))
    expect(screen.getAllByRole('button', { name: 'Discard' })).toHaveLength(2)
    const retryButtons = screen.getAllByRole('button', { name: 'Try again' })
    expect(retryButtons).toHaveLength(1) // only the `forbidden` row

    await user.click(retryButtons[0] as HTMLElement)
    expect(retryFailed).toHaveBeenCalledWith('i2')
  })

  it('discards one and discards all through the engine', async () => {
    await enqueue(db, deadLetter('i1'))
    const user = await openDialog()

    await user.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(discardFailed).toHaveBeenCalledWith('i1')

    await user.click(screen.getByRole('button', { name: 'Discard all' }))
    expect(discardAllFailed).toHaveBeenCalledTimes(1)
  })
})

describe('dead letters are account-complete (B32)', () => {
  const SHARED = 'shared-acc'

  /** A session granting the primary plus one delegated account — what M4.4 makes possible. */
  function withShared(children: React.ReactNode) {
    const session = {
      connected: {
        accountId: ACC,
        accounts: [
          { id: ACC, name: 'me@waxwing.test', isPersonal: true, isReadOnly: false },
          { id: SHARED, name: 'Team Inbox', isPersonal: false, isReadOnly: false },
        ],
      },
    } as unknown as Parameters<typeof SessionContext.Provider>[0]['value']
    return (
      <ToastProvider>
        <SessionContext.Provider value={session}>
          <ReplicaProvider accountId={ACC} db={db}>
            {children}
          </ReplicaProvider>
        </SessionContext.Provider>
      </ToastProvider>
    )
  }

  it('counts and lists a dead letter from a SHARED account', async () => {
    // The B32 regression. Before this, the button read `EngineStatus.failedActions` — the PRIMARY
    // engine's scalar, while shared engines are handed a discarding sink — so an action the user
    // aimed at a delegated mailbox could be refused by the server and vanish without trace. The row
    // was in the replica the whole time, keyed by its account; nothing enumerated it.
    await putMailboxes(db, SHARED, [mailbox('inbox', { name: 'Team Inbox', role: 'inbox' })])
    await enqueue(db, deadLetter('shared-1', { accountId: SHARED }))
    render(withShared(<OutboxProblemsButton />))

    const button = await screen.findByRole('button', { name: '1 action didn’t go through' })
    const user = userEvent.setup()
    await user.click(button)

    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(1)
  })

  it('counts rows from BOTH accounts together', async () => {
    await putMailboxes(db, SHARED, [mailbox('inbox', { name: 'Team Inbox', role: 'inbox' })])
    await enqueue(db, deadLetter('own-1'))
    await enqueue(db, deadLetter('shared-1', { accountId: SHARED }))
    render(withShared(<OutboxProblemsButton />))

    expect(
      await screen.findByRole('button', { name: '2 actions didn’t go through' }),
    ).toBeInTheDocument()
  })

  it("retries a shared row through THAT account's engine, not the primary's", async () => {
    // Guards the generalisation of B33: closing over one account id made retry a silent no-op, and
    // with cross-account rows in one list it would be that bug again, one level up.
    const sharedRetry = vi.fn(async () => true)
    setEngineFor(ACC, { retryFailed, discardFailed, discardAllFailed } as never)
    setEngineFor(SHARED, { retryFailed: sharedRetry, discardFailed, discardAllFailed } as never)
    await putMailboxes(db, SHARED, [mailbox('inbox', { name: 'Team Inbox', role: 'inbox' })])
    await enqueue(
      db,
      deadLetter('shared-1', {
        accountId: SHARED,
        conflict: { code: 'forbidden', errorType: 'forbidden', detail: null, ids: ['e1'], at: 1 },
      }),
    )
    render(withShared(<OutboxProblemsButton />))

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /didn’t go through/ }))
    await user.click(await screen.findByRole('button', { name: 'Try again' }))

    expect(sharedRetry).toHaveBeenCalledWith('shared-1')
    expect(retryFailed).not.toHaveBeenCalled()
    clearEngines()
  })
})
