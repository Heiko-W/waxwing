import { render, screen } from '@testing-library/react'
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
import { setActiveEngine } from '../sync/engine'
import { freshDb, mailbox } from '../sync/test-utils'
import { ToastProvider } from '../ui'
import { useConflictNotifier } from './use-conflict-notifier'

const ACC = 'a'
let db: ReplicaDb

const retryFailed = vi.fn(async () => true)
const discardFailed = vi.fn(async () => true)

function deadLetter(
  id: string,
  conflict: OutboxConflict,
  over: Partial<OutboxRow> = {},
): OutboxRow {
  return {
    accountId: ACC,
    id,
    type: 'move',
    payload: { kind: 'move', emailIds: ['e1'], from: 'inbox', to: 'archive' },
    ifInState: null,
    status: 'error',
    attempts: 1,
    createdAt: 1,
    lastError: null,
    notBefore: null,
    undo: null,
    conflict,
    ...over,
  }
}

const conflict = (code: OutboxConflict['code']): OutboxConflict => ({
  code,
  errorType: null,
  detail: null,
  ids: ['e1'],
  at: 1,
})

function Harness() {
  useConflictNotifier()
  return null
}

function renderNotifier() {
  return render(
    <ToastProvider>
      <ReplicaProvider accountId={ACC} db={db}>
        <Harness />
      </ReplicaProvider>
    </ToastProvider>,
  )
}

beforeEach(async () => {
  db = freshDb()
  vi.clearAllMocks()
  setActiveEngine({ retryFailed, discardFailed } as unknown as Parameters<
    typeof setActiveEngine
  >[0])
  await putMailboxes(db, ACC, [mailbox('inbox', { name: 'Inbox', role: 'inbox' })])
})

afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

describe('useConflictNotifier', () => {
  it('raises ONE gentle warning per dead letter, offering "Keep in <folder>" for an undone move', async () => {
    const user = userEvent.setup()
    await enqueue(db, deadLetter('i1', conflict('folderGone')))
    renderNotifier()

    expect(await screen.findByText('Couldn’t move — that folder was deleted.')).toBeInTheDocument()
    // The message is already back in Inbox; accepting that outcome IS discarding the dead letter.
    await user.click(await screen.findByRole('button', { name: 'Keep in Inbox' }))
    expect(discardFailed).toHaveBeenCalledWith('i1')
    expect(retryFailed).not.toHaveBeenCalled()
  })

  it('offers Try again for a conflict a retry could resolve', async () => {
    const user = userEvent.setup()
    await enqueue(
      db,
      deadLetter('i1', conflict('forbidden'), {
        type: 'setKeywords',
        payload: { kind: 'setKeywords', emailIds: ['e1'], keyword: '$seen', value: true },
      }),
    )
    renderNotifier()

    expect(await screen.findByText('You don’t have permission for that.')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(retryFailed).toHaveBeenCalledWith('i1')
  })

  it('never double-toasts a send — the composer send-error notifier owns those', async () => {
    await enqueue(
      db,
      deadLetter('send:d1', conflict('sendRejected'), {
        type: 'sendEmail',
        payload: { kind: 'sendEmail', localId: 'd1', source: null },
      }),
    )
    // A second, non-send dead letter proves the hook ran at all.
    await enqueue(db, deadLetter('i2', conflict('messageGone')))
    renderNotifier()

    expect(
      await screen.findByText('That message no longer exists on the server.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/could not be sent/)).not.toBeInTheDocument()
  })

  it('dedups: a repeated liveQuery emission of the same row does not re-toast', async () => {
    await enqueue(db, deadLetter('i1', conflict('messageGone')))
    renderNotifier()
    await screen.findByText('That message no longer exists on the server.')

    // An unrelated outbox write re-emits the same dead letter through the live query.
    await enqueue(db, { ...deadLetter('i9', conflict('messageGone')), status: 'pending' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(screen.getAllByText('That message no longer exists on the server.')).toHaveLength(1)
  })
})
