import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueue,
  type OutboxConflict,
  type OutboxRow,
  putMailboxes,
  type ReplicaDb,
  ReplicaProvider,
} from '../sync'
import { INITIAL_ENGINE_STATUS, setActiveEngine } from '../sync/engine'
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
  setEngineStatus({ ...INITIAL_ENGINE_STATUS, failedActions: 1 })
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
    setEngineStatus({ ...INITIAL_ENGINE_STATUS, failedActions: 0 })
    renderButton()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('announces the count in its accessible name and shows it as a badge', () => {
    setEngineStatus({ ...INITIAL_ENGINE_STATUS, failedActions: 3 })
    renderButton()
    // Pluralized, not a bare number: "3 actions didn't go through".
    expect(screen.getByRole('button', { name: "3 actions didn't go through" })).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()

    act(() => setEngineStatus({ ...INITIAL_ENGINE_STATUS, failedActions: 1 }))
    expect(screen.getByRole('button', { name: "1 action didn't go through" })).toBeInTheDocument()
  })

  it('opens the problems dialog from the keyboard', async () => {
    const user = userEvent.setup()
    await enqueue(db, deadLetter('i1'))
    renderButton()

    await user.tab()
    expect(screen.getByRole('button')).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('dialog')).toHaveAccessibleName("Some actions didn't go through")
  })

  it('has no axe violations (button + dialog)', async () => {
    const user = userEvent.setup()
    await enqueue(db, deadLetter('i1'))
    renderButton()
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
    await user.click(screen.getByRole('button', { name: /didn't go through/ }))
    await screen.findByRole('dialog')
    return user
  }

  it('lists each problem with its cause, the server detail and when it happened', async () => {
    await enqueue(db, deadLetter('i1'))
    await openDialog()

    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent("Couldn't move — that folder was deleted.")
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
