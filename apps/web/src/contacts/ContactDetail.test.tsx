import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putContactCards, type ReplicaDb, ReplicaProvider } from '../sync'
import { contactCard, freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ContactDetail, type ContactDetailProps } from './ContactDetail'

// The photo hook fetches a blob through the authenticated session — out of scope here. Stub it so the
// detail renders without a SessionProvider: a card with a photo blob gets a URL, one without gets none.
vi.mock('./use-contact-photo', () => ({
  useContactPhoto: (_accountId: string, media?: { blobId?: string; uri?: string }) =>
    media?.blobId !== undefined ? 'blob:test-photo' : media?.uri,
}))

let db: ReplicaDb

beforeEach(async () => {
  db = freshDb()
  await putContactCards(db, 'a', [
    contactCard('c1', {
      name: { '@type': 'Name', full: 'Alice Anderson' },
      emails: {
        e1: { '@type': 'EmailAddress', address: 'alice@x.test', contexts: { work: true } },
      },
      phones: { p1: { '@type': 'Phone', number: '+49 30 1234', features: { mobile: true } } },
      addresses: {
        a1: { '@type': 'Address', full: 'Main Street 1\n33330 Town' },
      },
      organizations: { o1: { '@type': 'Organization', name: 'Acme' } },
      titles: { t1: { '@type': 'Title', name: 'Engineer' } },
      anniversaries: {
        an1: {
          '@type': 'Anniversary',
          kind: 'birth',
          date: { '@type': 'PartialDate', year: 1990, month: 4, day: 4 },
        },
      },
      notes: { n1: { '@type': 'Note', note: 'Some note' } },
    }),
    contactCard('c2', {
      name: { '@type': 'Name', full: 'Photo Person' },
      media: {
        m1: { '@type': 'Media', kind: 'photo', blobId: 'b1', mediaType: 'image/png' },
      },
    }),
  ])
})

afterEach(async () => {
  await db.delete()
})

function renderDetail(cardId?: string, props: Partial<ContactDetailProps> = {}) {
  return render(
    <ReplicaProvider accountId="a" db={db}>
      <ContactDetail cardId={cardId} {...props} />
    </ReplicaProvider>,
  )
}

describe('ContactDetail', () => {
  it('says a contact that does not exist is unavailable, instead of spinning', async () => {
    /*
     * `useContactCard` returns `undefined` for BOTH "the query has not resolved" and "there is no
     * such row", and this component treated the pair as one — so a deep link to a contact deleted
     * since (or a mistyped id) showed a spinner that never stopped. The mail side has told these
     * two apart since M1.8 via `useEnsureEnvelopes`'s `settled`.
     */
    renderDetail('does-not-exist')
    expect(await screen.findByText('This contact is not available.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('renders the common JSContact fields', async () => {
    renderDetail('c1')
    expect(await screen.findByRole('heading', { name: 'Alice Anderson' })).toBeInTheDocument()

    const emailLink = screen.getByRole('link', { name: 'alice@x.test' })
    expect(emailLink).toHaveAttribute('href', 'mailto:alice@x.test')
    const phoneLink = screen.getByRole('link', { name: '+49 30 1234' })
    // The number is READ with its spaces and DIALLED without them: RFC 3966 §3 allows `-`, `.`, `(`
    // and `)` as visual separators inside a telephone-subscriber, and no space.
    expect(phoneLink).toHaveAttribute('href', 'tel:+49301234')

    expect(screen.getByText('Main Street 1')).toBeInTheDocument()
    expect(screen.getByText(/Engineer/)).toBeInTheDocument()
    expect(screen.getByText(/Acme/)).toBeInTheDocument()
    expect(screen.getByText(/1990/)).toBeInTheDocument()
    expect(screen.getByText('Some note')).toBeInTheDocument()

    // Type labels come from the localized set, not raw RFC keys.
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('Mobile')).toBeInTheDocument()
  })

  it('falls back to an initials avatar when the card has no photo', async () => {
    renderDetail('c1')
    await screen.findByRole('heading', { name: 'Alice Anderson' })
    // The initials avatar exposes the name as its accessible label.
    expect(screen.getByRole('img', { name: 'Alice Anderson' })).toBeInTheDocument()
  })

  it('renders the photo when the card has media', async () => {
    const { container } = renderDetail('c2')
    await screen.findByRole('heading', { name: 'Photo Person' })
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', 'blob:test-photo')
  })

  it('disables Edit and hides Delete without write rights (read-only guard)', async () => {
    const onEdit = vi.fn()
    // canWrite defaults to false; even a wired onEdit must not enable Edit, and Delete is absent.
    renderDetail('c1', { onEdit, canWrite: false })
    await screen.findByRole('heading', { name: 'Alice Anderson' })
    expect(screen.getByRole('button', { name: /Edit/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('enables Edit and calls onEdit when the book is writable', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    renderDetail('c1', { onEdit, canWrite: true })
    await screen.findByRole('heading', { name: 'Alice Anderson' })
    const edit = screen.getByRole('button', { name: /Edit/ })
    expect(edit).toBeEnabled()
    await user.click(edit)
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('confirms before deleting and only then calls onDelete', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    renderDetail('c1', { onDelete, canWrite: true })
    await screen.findByRole('heading', { name: 'Alice Anderson' })

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete contact' })
    expect(onDelete).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('does not delete when the confirmation is cancelled', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    renderDetail('c1', { onDelete, canWrite: true })
    await screen.findByRole('heading', { name: 'Alice Anderson' })
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an empty state when nothing is selected', () => {
    renderDetail(undefined)
    expect(screen.getByText('Select a contact to see their details.')).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = renderDetail('c1')
    await screen.findByRole('heading', { name: 'Alice Anderson' })
    await expectNoA11yViolations(container)
  })
})
