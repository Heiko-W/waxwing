import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueue, type OutboxRow, type ReplicaDb, ReplicaProvider } from '../sync'
import { INITIAL_ENGINE_STATUS } from '../sync/engine'
import { setEngineStatus } from '../sync/engine/status'
import { freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { QueuedSends } from './QueuedSends'

const ACC = 'a'
let db: ReplicaDb

const undoSend = vi.fn(async () => {})
vi.mock('../compose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../compose')>()),
  useDraftSync: () => ({ undoSend }),
}))

function queuedSend(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    accountId: ACC,
    id: 'send:d1',
    type: 'sendEmail',
    payload: { kind: 'sendEmail', localId: 'd1', email: { subject: 'Lunch?' }, source: null },
    ifInState: null,
    status: 'pending',
    attempts: 0,
    createdAt: 1,
    lastError: null,
    notBefore: null,
    nextAttemptAt: null,
    ...over,
  }
}

function online(is: boolean): void {
  setEngineStatus({ ...INITIAL_ENGINE_STATUS, online: is })
}

beforeEach(() => {
  db = freshDb()
  vi.clearAllMocks()
  online(true)
})

afterEach(async () => {
  setEngineStatus(INITIAL_ENGINE_STATUS)
  await db.delete()
})

function renderQueue() {
  return render(
    <ReplicaProvider accountId={ACC} db={db}>
      <QueuedSends />
    </ReplicaProvider>,
  )
}

describe('QueuedSends', () => {
  it('renders nothing when no send is queued (it costs nothing when idle)', async () => {
    const { container } = renderQueue()
    await Promise.resolve()
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('offline: says the message will go out on reconnect, in a polite live region', async () => {
    online(false)
    await enqueue(db, queuedSend())
    renderQueue()

    const region = await screen.findByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAccessibleName('Queued messages')
    expect(await screen.findByText('Lunch?')).toBeInTheDocument()
    expect(screen.getByText('Will send when you’re back online')).toBeInTheDocument()
  })

  it('online: distinguishes the undo grace, a backoff retry and an in-progress send', async () => {
    const now = Date.now()
    await enqueue(db, queuedSend({ id: 'send:a', notBefore: now + 60_000 }))
    await enqueue(db, queuedSend({ id: 'send:b', createdAt: 2, nextAttemptAt: now + 60_000 }))
    await enqueue(db, queuedSend({ id: 'send:c', createdAt: 3 }))
    renderQueue()

    expect(await screen.findByText('Sending message…')).toBeInTheDocument() // within the grace
    expect(screen.getByText('Retrying…')).toBeInTheDocument() // backed off after a failure
    expect(screen.getByText('Sending…')).toBeInTheDocument() // dispatching now
  })

  it('falls back to the no-subject placeholder and cancels through undoSend', async () => {
    const user = userEvent.setup()
    await enqueue(
      db,
      queuedSend({ payload: { kind: 'sendEmail', localId: 'd1', email: {}, source: null } }),
    )
    renderQueue()

    expect(await screen.findByText('(No subject)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel send' }))
    expect(undoSend).toHaveBeenCalledWith('d1')
  })

  it('has no axe violations', async () => {
    await enqueue(db, queuedSend())
    renderQueue()
    await screen.findByText('Lunch?')
    await expectNoA11yViolations(document.body)
  })
})
