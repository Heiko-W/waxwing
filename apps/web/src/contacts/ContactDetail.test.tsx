import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putContactCards, type ReplicaDb, ReplicaProvider } from '../sync'
import { contactCard, freshDb } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ContactDetail } from './ContactDetail'

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

function renderDetail(cardId?: string) {
  return render(
    <ReplicaProvider accountId="a" db={db}>
      <ContactDetail cardId={cardId} />
    </ReplicaProvider>,
  )
}

describe('ContactDetail', () => {
  it('renders the common JSContact fields', async () => {
    renderDetail('c1')
    expect(await screen.findByRole('heading', { name: 'Alice Anderson' })).toBeInTheDocument()

    const emailLink = screen.getByRole('link', { name: 'alice@x.test' })
    expect(emailLink).toHaveAttribute('href', 'mailto:alice@x.test')
    const phoneLink = screen.getByRole('link', { name: '+49 30 1234' })
    expect(phoneLink).toHaveAttribute('href', 'tel:+49 30 1234')

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

  it('offers a disabled Edit affordance (read-only this stage)', async () => {
    renderDetail('c1')
    await screen.findByRole('heading', { name: 'Alice Anderson' })
    expect(screen.getByRole('button', { name: /Edit/ })).toBeDisabled()
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
