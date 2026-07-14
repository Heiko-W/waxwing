import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putMailboxes, type ReplicaDb, ReplicaProvider, useMailboxByRole } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { freshDb, mailbox } from '../sync/test-utils'
import { ToastProvider } from '../ui'
import { useTriage } from './use-triage'

const dispatch = vi.fn()
let db: ReplicaDb

/** A probe whose buttons call the seam exactly the way the bulk bar / action bar do. */
function Probe({ from }: { readonly from: string | null }) {
  const triage = useTriage()
  // The role mailboxes arrive from a Dexie liveQuery, i.e. one tick LATER than the first render.
  // `archive()` resolves the target role at call time and no-ops while it is still unknown — which
  // is right (the real buttons are disabled until then), but it means a click fired before the
  // query resolves is silently swallowed and no `waitFor` can bring it back. So publish readiness
  // and let every test await it: this is a precondition, not a timing guess.
  const archiveId = useMailboxByRole('archive')?.id
  return (
    <>
      {archiveId !== undefined && <span>roles-ready</span>}
      <button type="button" onClick={() => triage.archive(['e1'], from)}>
        probe-archive
      </button>
      <button type="button" onClick={() => triage.junk(['e1'], from)}>
        probe-junk
      </button>
      <button type="button" onClick={() => triage.setSeen(['e1'], false)}>
        probe-unread
      </button>
    </>
  )
}

async function renderProbe(from: string | null = 'inbox') {
  const result = render(
    <ToastProvider>
      <ReplicaProvider accountId="a" db={db}>
        <Probe from={from} />
      </ReplicaProvider>
    </ToastProvider>,
  )
  await screen.findByText('roles-ready')
  return result
}

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  setActiveEngine({ dispatch } as unknown as Parameters<typeof setActiveEngine>[0])
  // No Junk mailbox on purpose — the missing-role case is one of the assertions.
  await putMailboxes(db, 'a', [
    mailbox('inbox', { role: 'inbox' }),
    mailbox('archive', { role: 'archive' }),
  ])
})

afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

describe('useTriage', () => {
  it('archive dispatches ONE move into the archive role mailbox', async () => {
    const user = userEvent.setup()
    await renderProbe()
    await user.click(screen.getByRole('button', { name: 'probe-archive' }))

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'move',
      emailIds: ['e1'],
      from: 'inbox',
      to: 'archive',
    })
  })

  it('raises an undo toast whose Undo dispatches the INVERSE move', async () => {
    const user = userEvent.setup()
    await renderProbe()
    await user.click(screen.getByRole('button', { name: 'probe-archive' }))
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))

    expect(await screen.findByText('Moved to Archive')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Undo' }))

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
      kind: 'move',
      emailIds: ['e1'],
      from: 'archive', // out of Archive again…
      to: 'inbox', // …and back where it came from
    })
  })

  it('offers no Undo when the source mailbox is unknown (a cross-folder search selection)', async () => {
    const user = userEvent.setup()
    await renderProbe(null)
    await user.click(screen.getByRole('button', { name: 'probe-archive' }))

    expect(await screen.findByText('Moved to Archive')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('is a no-op when the account has no such role mailbox', async () => {
    const user = userEvent.setup()
    await renderProbe()
    await user.click(screen.getByRole('button', { name: 'probe-junk' }))

    expect(dispatch).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('read/flag go straight through — no toast (they are cheap and visibly reversible)', async () => {
    const user = userEvent.setup()
    await renderProbe()
    await user.click(screen.getByRole('button', { name: 'probe-unread' }))

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'setKeywords',
      keyword: '$seen',
      value: false,
      emailIds: ['e1'],
    })
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})
