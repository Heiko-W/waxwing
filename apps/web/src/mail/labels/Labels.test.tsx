import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '../../app/route'
import { putEmails, type ReplicaDb, ReplicaProvider, setPref } from '../../sync'
import { setActiveEngine } from '../../sync/engine'
import { email, freshDb } from '../../sync/test-utils'
import { expectNoA11yViolations } from '../../test/axe'
import { Labels } from './Labels'
import type { LabelPref } from './label-model'

const dispatch = vi.fn()
let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  dispatch.mockReset()
  setActiveEngine({ dispatch } as unknown as Parameters<typeof setActiveEngine>[0])
  await setPref(db, 'a', 'labels', [{ keyword: 'work', name: 'Work', color: 'red' }] as LabelPref[])
  await putEmails(db, 'a', [
    email('e1', { keywords: { work: true } }),
    email('e2', { keywords: { receipts: true } }),
    email('e3', { keywords: { Follow_Up: true } }), // a MIXED-CASE discovered keyword
  ])
})
afterEach(async () => {
  setActiveEngine(null)
  await db.delete()
})

function renderLabels() {
  return render(
    <RouterProvider>
      <ReplicaProvider accountId="a" db={db}>
        <Labels />
      </ReplicaProvider>
    </RouterProvider>,
  )
}

describe('Labels', () => {
  it('shows registered and discovered labels with the discovered hint', async () => {
    renderLabels()
    expect(await screen.findByRole('treeitem', { name: /Work/ })).toBeInTheDocument()
    // 'receipts' is a discovered (unregistered) keyword from cached mail.
    expect(screen.getByRole('treeitem', { name: /receipts/ })).toBeInTheDocument()
    expect(screen.getByText(/Found automatically on your synced messages/)).toBeInTheDocument()
  })

  it('navigates to the label view on select (marks it active)', async () => {
    const user = userEvent.setup()
    renderLabels()
    const work = await screen.findByRole('treeitem', { name: /Work/ })
    await user.click(work)
    await waitFor(() => expect(work).toHaveAttribute('aria-selected', 'true'))
  })

  it('creates a new label from the New label affordance', async () => {
    const user = userEvent.setup()
    renderLabels()
    await user.click(await screen.findByRole('button', { name: 'New label' }))
    await user.type(screen.getByLabelText('Label name'), 'Projects')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('treeitem', { name: /Projects/ })).toBeInTheDocument()
  })

  // B20.3. Submitting an invalid name left focus on the Create button and rendered the reason as a
  // plain <p> wired only through `aria-describedby` — which is read when the INPUT has focus. So the
  // dialog appeared to ignore the click, and the explanation sat where the user had not gone.
  it('announces a rejected label name and puts focus back on the field', async () => {
    const user = userEvent.setup()
    renderLabels()
    await user.click(await screen.findByRole('button', { name: 'New label' }))
    const field = screen.getByLabelText('Label name')

    await user.click(screen.getByRole('button', { name: 'Create' })) // empty name

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Enter a label name.')
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('aria-describedby', alert.id)
    expect(field).toHaveAttribute('aria-invalid', 'true')
  })

  it('deletes a label and, when opted in, strips the keyword from known messages', async () => {
    const user = userEvent.setup()
    renderLabels()
    const work = await screen.findByRole('treeitem', { name: /Work/ })
    await user.click(within(work).getByRole('button', { name: /^Label actions/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    // The optional strip checkbox reports the known-carrier count (e1 carries 'work').
    const strip = await screen.findByRole('checkbox', { name: /Also remove it from 1/ })
    await user.click(strip)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'setKeywords', keyword: 'work', value: false }),
        expect.anything(),
      ),
    )
  })

  it('adopts a discovered keyword by its EXACT wire form (no re-slug/lowercase)', async () => {
    const user = userEvent.setup()
    renderLabels()
    const item = await screen.findByRole('treeitem', { name: /Follow_Up/ })
    await user.click(within(item).getByRole('button', { name: /^Label actions/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Add to labels' }))
    await waitFor(async () => {
      const row = await db.localPrefs.get(['a', 'labels'])
      const registry = (row?.value as LabelPref[]) ?? []
      // Exact keyword preserved — NOT lowercased to `follow_up`, which would desync swatch/count lookups.
      expect(registry.map((label) => label.keyword)).toContain('Follow_Up')
    })
  })

  it('has no axe violations', async () => {
    const { container } = renderLabels()
    await screen.findByRole('treeitem', { name: /Work/ })
    await expectNoA11yViolations(container)
  })
})
