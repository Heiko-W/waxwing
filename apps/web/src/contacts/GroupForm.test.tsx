import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ContactCardRow } from '../sync'
import { contactCard } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { GroupForm, type GroupFormSubmit } from './GroupForm'

let idCounter = 0
const stableId = (): string => `id-${idCounter++}`

function candidate(id: string, name: string): ContactCardRow {
  return contactCard(id, {
    uid: `uid-${id}`,
    name: { '@type': 'Name', full: name },
    emails: { e1: { '@type': 'EmailAddress', address: `${id}@x.test` } },
  }) as ContactCardRow
}

const CANDIDATES = [candidate('c1', 'Alice Anderson'), candidate('c2', 'Bob Brown')]

function groupCard(members: Record<string, true> = { 'uid-c1': true }): ContactCardRow {
  return contactCard('g1', {
    uid: 'uid-g1',
    kind: 'group',
    name: { '@type': 'Name', full: 'Team' },
    members,
  }) as ContactCardRow
}

function renderForm(props: Partial<React.ComponentProps<typeof GroupForm>> = {}) {
  idCounter = 0
  const onSubmit = vi.fn<(submit: GroupFormSubmit) => void>()
  const onCancel = vi.fn()
  render(
    <GroupForm
      mode="create"
      bookId="book1"
      candidates={CANDIDATES}
      onSubmit={onSubmit}
      onCancel={onCancel}
      newId={stableId}
      {...props}
    />,
  )
  return { onSubmit, onCancel }
}

describe('GroupForm create', () => {
  it('cannot save until the group has a name', async () => {
    renderForm()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('creates a kind:"group" card with the picked members (their uids)', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.type(screen.getByLabelText('Group name'), 'Team')
    await user.click(screen.getByRole('button', { name: 'Add Alice Anderson' }))
    await user.click(screen.getByRole('button', { name: 'Add Bob Brown' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submit = onSubmit.mock.calls[0]?.[0] as Extract<GroupFormSubmit, { kind: 'create' }>
    expect(submit.kind).toBe('create')
    expect(submit.card.kind).toBe('group')
    expect(submit.card.name).toEqual({ '@type': 'Name', full: 'Team' })
    expect(submit.card.members).toEqual({ 'uid-c1': true, 'uid-c2': true })
    expect(submit.card.addressBookIds).toEqual({ book1: true })
  })

  it('moves a picked contact out of the candidate list into the member list', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Add Alice Anderson' }))
    // No longer offered to add…
    expect(screen.queryByRole('button', { name: 'Add Alice Anderson' })).not.toBeInTheDocument()
    // …but removable as a member.
    expect(
      screen.getByRole('button', { name: 'Remove Alice Anderson from group' }),
    ).toBeInTheDocument()
  })
})

describe('GroupForm edit', () => {
  it('renames the group with a single-key name patch', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ mode: 'edit', card: groupCard() })

    const name = screen.getByLabelText('Group name')
    await user.clear(name)
    await user.type(name, 'Squad')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const submit = onSubmit.mock.calls[0]?.[0] as Extract<GroupFormSubmit, { kind: 'update' }>
    expect(submit.kind).toBe('update')
    expect(submit.cardId).toBe('g1')
    expect(Object.keys(submit.patch)).toEqual(['name'])
    expect(submit.patch.name).toEqual({ '@type': 'Name', full: 'Squad' })
  })

  it('adds a member with a single-key members patch', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ mode: 'edit', card: groupCard({ 'uid-c1': true }) })

    await user.click(screen.getByRole('button', { name: 'Add Bob Brown' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const submit = onSubmit.mock.calls[0]?.[0] as Extract<GroupFormSubmit, { kind: 'update' }>
    expect(Object.keys(submit.patch)).toEqual(['members'])
    expect(submit.patch.members).toEqual({ 'uid-c1': true, 'uid-c2': true })
  })

  it('removes a member with a members patch', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({
      mode: 'edit',
      card: groupCard({ 'uid-c1': true, 'uid-c2': true }),
    })

    await user.click(screen.getByRole('button', { name: 'Remove Bob Brown from group' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const submit = onSubmit.mock.calls[0]?.[0] as Extract<GroupFormSubmit, { kind: 'update' }>
    expect(submit.patch).toEqual({ members: { 'uid-c1': true } })
  })
})

describe('GroupForm read-only guard', () => {
  it('disables Save and shows a notice when the book is not writable', () => {
    renderForm({ mode: 'edit', card: groupCard(), canWrite: false })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText('This address book is read-only.')).toBeInTheDocument()
  })
})

describe('GroupForm a11y', () => {
  it('has no axe violations', async () => {
    const { container } = render(
      <GroupForm
        mode="edit"
        card={groupCard()}
        bookId="book1"
        candidates={CANDIDATES}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    await expectNoA11yViolations(container)
  })
})
