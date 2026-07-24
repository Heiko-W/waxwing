import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ContactCardRow, ReplicaProvider } from '../sync'
import { contactCard } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ContactForm, type ContactFormSubmit } from './ContactForm'
import type { PhotoScaler, PhotoUploader } from './contact-photo-upload'

// The photo preview goes through the authenticated blob path — out of scope here. With it stubbed the
// preview falls back to the local objectURL created on pick.
vi.mock('./use-contact-photo', () => ({ useContactPhoto: () => undefined }))

// jsdom has no object-URL support; the form creates one for the photo preview.
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  vi.restoreAllMocks()
})

let idCounter = 0
const stableId = (): string => `id-${idCounter++}`

function renderForm(props: Partial<React.ComponentProps<typeof ContactForm>> = {}) {
  idCounter = 0
  const onSubmit = vi.fn<(submit: ContactFormSubmit) => void>()
  const onCancel = vi.fn()
  render(
    <ReplicaProvider accountId="a">
      <ContactForm
        mode="create"
        bookId="book1"
        onSubmit={onSubmit}
        onCancel={onCancel}
        newId={stableId}
        {...props}
      />
    </ReplicaProvider>,
  )
  return { onSubmit, onCancel }
}

function editableCard(): ContactCardRow {
  return contactCard('c1', {
    name: {
      '@type': 'Name',
      components: [
        { '@type': 'NameComponent', kind: 'given', value: 'Alice' },
        { '@type': 'NameComponent', kind: 'surname', value: 'Anderson' },
      ],
    },
    emails: { e1: { '@type': 'EmailAddress', address: 'alice@x.test', contexts: { work: true } } },
  }) as ContactCardRow
}

describe('ContactForm progressive disclosure (FR-CON-02)', () => {
  it('hides Address / Birthday / Notes / Photo until revealed from the add-field bar', async () => {
    const user = userEvent.setup()
    renderForm()

    // Name / email / phone are there from the start.
    expect(screen.getByLabelText('First name')).toBeInTheDocument()
    expect(screen.getAllByLabelText('Email').length).toBeGreaterThan(0)

    // Optional sections are not.
    expect(screen.queryByLabelText('Street')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Address' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add address' }))

    expect(screen.getByRole('heading', { name: 'Address' })).toBeInTheDocument()
    expect(screen.getByLabelText('Street')).toBeInTheDocument()
    // The reveal affordance is gone from the add-field bar once its section is open.
    const addFieldBar = screen.getByRole('group', { name: 'Add field' })
    expect(
      within(addFieldBar).queryByRole('button', { name: 'Add address' }),
    ).not.toBeInTheDocument()
  })

  it('reveals every optional section from its add-field button', async () => {
    const user = userEvent.setup()
    renderForm()
    const revealers: [string, string][] = [
      ['Add company', 'Company'],
      ['Add birthday', 'Birthday'],
      ['Add note', 'Notes'],
      ['Add address', 'Address'],
      ['Add photo', 'Photo'],
    ]
    for (const [button, heading] of revealers) {
      await user.click(screen.getByRole('button', { name: button }))
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
    }
  })
})

describe('ContactForm async seam (controlled field vs. stale source)', () => {
  it('keeps a typed value when a stale card echo re-renders the form', async () => {
    const user = userEvent.setup()
    idCounter = 0
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(
      <ReplicaProvider accountId="a">
        <ContactForm
          mode="edit"
          card={editableCard()}
          bookId="book1"
          onSubmit={onSubmit}
          onCancel={onCancel}
          newId={stableId}
        />
      </ReplicaProvider>,
    )

    const given = screen.getByLabelText('First name')
    await user.clear(given)
    await user.type(given, 'Alicia')
    expect(given).toHaveValue('Alicia')

    // A live-query echo delivers a DIFFERENT (stale) card object — the draft must not be reset.
    const stale = contactCard('c1', {
      name: {
        '@type': 'Name',
        components: [{ '@type': 'NameComponent', kind: 'given', value: 'STALE' }],
      },
    }) as ContactCardRow
    rerender(
      <ReplicaProvider accountId="a">
        <ContactForm
          mode="edit"
          card={stale}
          bookId="book1"
          onSubmit={onSubmit}
          onCancel={onCancel}
          newId={stableId}
        />
      </ReplicaProvider>,
    )

    expect(screen.getByLabelText('First name')).toHaveValue('Alicia')
  })
})

describe('ContactForm read-only guard', () => {
  it('disables Save and shows a notice when the book is not writable', () => {
    renderForm({ mode: 'edit', card: editableCard(), canWrite: false })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText('This address book is read-only.')).toBeInTheDocument()
  })
})

describe('ContactForm submit', () => {
  it('creates a full card from the filled fields, in the target book', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.type(screen.getByLabelText('First name'), 'Bob')
    await user.type(screen.getByLabelText('Last name'), 'Brown')
    await user.type(screen.getAllByLabelText('Email')[0] as HTMLElement, 'bob@brown.test')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submit = onSubmit.mock.calls[0]?.[0] as Extract<ContactFormSubmit, { kind: 'create' }>
    expect(submit.kind).toBe('create')
    expect(submit.card.addressBookIds).toEqual({ book1: true })
    expect(submit.card.name?.components).toContainEqual({
      '@type': 'NameComponent',
      kind: 'given',
      value: 'Bob',
    })
    expect(Object.values(submit.card.emails ?? {})[0]).toMatchObject({ address: 'bob@brown.test' })
  })

  it('produces a single-property patch for a one-field edit', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ mode: 'edit', card: editableCard() })

    const given = screen.getByLabelText('First name')
    await user.clear(given)
    await user.type(given, 'Alicia')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const submit = onSubmit.mock.calls[0]?.[0] as Extract<ContactFormSubmit, { kind: 'update' }>
    expect(submit.kind).toBe('update')
    expect(submit.cardId).toBe('c1')
    expect(Object.keys(submit.patch)).toEqual(['name'])
  })

  it('closes without submitting when an edit changed nothing', async () => {
    const user = userEvent.setup()
    const { onSubmit, onCancel } = renderForm({ mode: 'edit', card: editableCard() })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('ContactForm photo upload', () => {
  const passthroughScaler: PhotoScaler = async (file) => ({ blob: file, mediaType: file.type })

  it('uploads a picked file and writes its blobId into the media map', async () => {
    const user = userEvent.setup()
    const uploader: PhotoUploader = vi.fn(async (_blob, mediaType) => ({
      blobId: 'uploaded-blob',
      mediaType,
    }))
    const { onSubmit } = renderForm({ uploadPhoto: uploader, scalePhoto: passthroughScaler })

    await user.click(screen.getByRole('button', { name: 'Add photo' }))
    const file = new File(['bytes'], 'me.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Choose photo'), file)

    // Preview appears (from the local objectURL) and the uploader ran.
    expect(await screen.findByRole('img')).toBeInTheDocument()
    expect(uploader).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Save' }))
    const submit = onSubmit.mock.calls[0]?.[0] as Extract<ContactFormSubmit, { kind: 'create' }>
    const media = Object.values(submit.card.media ?? {})[0]
    expect(media).toMatchObject({ kind: 'photo', blobId: 'uploaded-blob', mediaType: 'image/png' })
  })

  it('removes the photo again', async () => {
    const user = userEvent.setup()
    const uploader: PhotoUploader = vi.fn(async (_blob, mediaType) => ({
      blobId: 'uploaded-blob',
      mediaType,
    }))
    const { onSubmit } = renderForm({ uploadPhoto: uploader, scalePhoto: passthroughScaler })

    await user.click(screen.getByRole('button', { name: 'Add photo' }))
    await user.upload(
      screen.getByLabelText('Choose photo'),
      new File(['bytes'], 'me.png', { type: 'image/png' }),
    )
    await screen.findByRole('img')
    await user.click(screen.getByRole('button', { name: 'Remove photo' }))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    const submit = onSubmit.mock.calls[0]?.[0] as Extract<ContactFormSubmit, { kind: 'create' }>
    expect(submit.card.media).toBeUndefined()
  })
})

describe('ContactForm a11y', () => {
  it('has no axe violations', async () => {
    const { container } = render(
      <ReplicaProvider accountId="a">
        <ContactForm
          mode="edit"
          card={editableCard()}
          bookId="book1"
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />
      </ReplicaProvider>,
    )
    await expectNoA11yViolations(container)
  })
})
