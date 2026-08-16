import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putMailboxes, type ReplicaDb, ReplicaProvider, useMailboxByRole } from '../sync'
import { setActiveEngine } from '../sync/engine'
import { FULL_RIGHTS, freshDb, mailbox } from '../sync/test-utils'
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
  // Archive and Trash are two INDEPENDENT liveQueries and may land on different ticks, so the
  // marker waits for both — otherwise the self-move test could click while `trash` is still
  // `undefined` and pass for the wrong reason.
  const archiveId = useMailboxByRole('archive')?.id
  const trashId = useMailboxByRole('trash')?.id
  // The seam's boolean is the contract the callers branch on, so assert it, not just the dispatch.
  const [result, setResult] = useState<boolean | null>(null)
  return (
    <>
      {archiveId !== undefined && trashId !== undefined && <span>roles-ready</span>}
      {result !== null && <span>{`result:${result}`}</span>}
      <button type="button" onClick={() => triage.archive(['e1'], from)}>
        probe-archive
      </button>
      <button type="button" onClick={() => triage.junk(['e1'], from)}>
        probe-junk
      </button>
      <button type="button" onClick={() => setResult(triage.trash(['e1'], from))}>
        probe-trash
      </button>
      <button type="button" onClick={() => triage.setSeen(['e1'], false)}>
        probe-unread
      </button>
      <button type="button" onClick={() => triage.moveTo(['e1'], from, 'p1', 'Projects')}>
        probe-move-to
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
    mailbox('trash', { role: 'trash' }),
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

  it('offers no Undo when the way BACK is not permitted (B34)', async () => {
    // Rights that allow a move do not imply the inverse: here the Inbox accepts nothing new, so the
    // forward archive is legal and the undo would be refused. An Undo that cannot execute fails at
    // the worst possible moment — when the user is already trying to take something back.
    await putMailboxes(db, 'a', [
      mailbox('inbox', { role: 'inbox', myRights: { ...FULL_RIGHTS, mayAddItems: false } }),
      mailbox('archive', { role: 'archive' }),
      mailbox('trash', { role: 'trash' }),
    ])
    const user = userEvent.setup()
    await renderProbe()
    await user.click(screen.getByRole('button', { name: 'probe-archive' }))

    // The move itself still happens and is still announced …
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Moved to Archive')).toBeInTheDocument()
    // … but no Undo is offered, rather than one that would be rejected.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
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

  // A self-move (`to === from`) is destructive, not idle: the replay patch writes
  // `mailboxIds/<x>: true` and then `mailboxIds/<x>: null` onto the SAME key, so the server is asked
  // to remove the mail from the only mailbox it is in; optimistically the row is pruned out of the
  // window it never left. The bulk bar reaches this today with its Trash button inside Trash.
  it('refuses a self-move: Trash while already in Trash dispatches nothing', async () => {
    const user = userEvent.setup()
    await renderProbe('trash')
    await user.click(screen.getByRole('button', { name: 'probe-trash' }))

    expect(await screen.findByText('result:false')).toBeInTheDocument()
    expect(dispatch).not.toHaveBeenCalled()
    // No toast either — an Undo for a move that never happened would be a lie about what the app did.
    expect(screen.queryByText('Moved to Trash')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('the self-move guard leaves a genuine move untouched', async () => {
    const user = userEvent.setup()
    await renderProbe()
    await user.click(screen.getByRole('button', { name: 'probe-trash' }))

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'move',
      emailIds: ['e1'],
      from: 'inbox',
      to: 'trash',
    })
    expect(screen.getByText('result:true')).toBeInTheDocument()
    expect(await screen.findByText('Moved to Trash')).toBeInTheDocument()
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

  // `moveTo` (M3.9): the arbitrary-target move. Until now the folder picker dispatched `actions.move`
  // straight past this seam, so the one move the user chose EXPLICITLY was the only one without an
  // Undo — while archive, which needs no confirmation, had one.
  it('moveTo dispatches the move and names the target in the toast', async () => {
    const user = userEvent.setup()
    await renderProbe()
    await user.click(screen.getByRole('button', { name: 'probe-move-to' }))

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'move',
      emailIds: ['e1'],
      from: 'inbox',
      to: 'p1',
    })
    // Interpolated, not a bare key: the label comes from the picker, since a role folder's display
    // name is localized rather than the server's `name`.
    expect(await screen.findByText('Moved to Projects')).toBeInTheDocument()
  })

  it('moveTo Undo puts the message back where it came from', async () => {
    const user = userEvent.setup()
    await renderProbe()
    await user.click(screen.getByRole('button', { name: 'probe-move-to' }))
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))

    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
      kind: 'move',
      emailIds: ['e1'],
      from: 'p1',
      to: 'inbox',
    })
  })

  it('moveTo still dispatches without a known source, but offers no Undo', async () => {
    const user = userEvent.setup()
    await renderProbe(null)
    await user.click(screen.getByRole('button', { name: 'probe-move-to' }))

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Moved to Projects')).toBeInTheDocument()
    // There is nowhere to put it back — a broken Undo would be worse than none.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})
