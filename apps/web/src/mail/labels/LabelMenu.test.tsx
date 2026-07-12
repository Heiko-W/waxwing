import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Id } from '@waxwing/jmap'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putEmails, type ReplicaDb, ReplicaProvider, setPref } from '../../sync'
import { setActiveEngine } from '../../sync/engine'
import { email, freshDb } from '../../sync/test-utils'
import { expectNoA11yViolations } from '../../test/axe'
import { LabelMenu } from './LabelMenu'
import type { LabelPref } from './label-model'

const REGISTRY: LabelPref[] = [
  { keyword: 'work', name: 'Work', color: 'red' },
  { keyword: 'urgent', name: 'Urgent', color: 'blue' },
  { keyword: 'later', name: 'Later', color: 'green' },
]

const dispatch = vi.fn()
const fetchEnvelopes = vi.fn()
let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  fetchEnvelopes.mockReset()
  setActiveEngine({ dispatch, fetchEnvelopes } as unknown as Parameters<typeof setActiveEngine>[0])
  await setPref(db, 'a', 'labels', REGISTRY)
  // LabelMenu reads membership from the replica over ALL given ids (not a passed-in visible slice).
  await putEmails(db, 'a', [
    email('e1', { keywords: { work: true, urgent: true } }),
    email('e2', { keywords: { work: true } }),
  ])
})
afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

function Harness({ ids, onClose }: { ids: Id[]; onClose?: () => void }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <ReplicaProvider accountId="a" db={db}>
      <button ref={anchorRef} type="button">
        anchor
      </button>
      <LabelMenu ids={ids} anchorRef={anchorRef} onClose={onClose ?? (() => {})} />
    </ReplicaProvider>
  )
}

describe('LabelMenu', () => {
  it('reflects three-state membership across the given messages', async () => {
    render(<Harness ids={['e1', 'e2']} />)
    // 'work' is on both → checked; 'urgent' on one → mixed; 'later' on neither → unchecked.
    expect(await screen.findByRole('menuitemcheckbox', { name: /Work/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('menuitemcheckbox', { name: /Urgent/ })).toHaveAttribute(
      'aria-checked',
      'mixed',
    )
    expect(screen.getByRole('menuitemcheckbox', { name: /Later/ })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('toggles a fully-applied label off and a partial/unset label on', async () => {
    const user = userEvent.setup()
    render(<Harness ids={['e1', 'e2']} />)
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Work/ }))
    expect(dispatch).toHaveBeenCalledWith(
      { kind: 'setKeywords', emailIds: ['e1', 'e2'], keyword: 'work', value: false },
      expect.anything(),
    )
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Later/ }))
    expect(dispatch).toHaveBeenCalledWith(
      { kind: 'setKeywords', emailIds: ['e1', 'e2'], keyword: 'later', value: true },
      expect.anything(),
    )
  })

  it('opens the create dialog from the "New label…" entry', async () => {
    const user = userEvent.setup()
    render(<Harness ids={['e1']} />)
    await user.click(await screen.findByRole('menuitem', { name: /New label/ }))
    expect(await screen.findByRole('dialog', { name: 'New label' })).toBeInTheDocument()
  })

  it('roves focus with ArrowDown and closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness ids={['e1']} onClose={onClose} />)
    const work = await screen.findByRole('menuitemcheckbox', { name: /Work/ })
    expect(work).toHaveFocus() // first item focused on open
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemcheckbox', { name: /Urgent/ })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('has no axe violations', async () => {
    render(<Harness ids={['e1', 'e2']} />)
    await screen.findByRole('menuitemcheckbox', { name: /Work/ })
    await expectNoA11yViolations(document.body)
  })
})
