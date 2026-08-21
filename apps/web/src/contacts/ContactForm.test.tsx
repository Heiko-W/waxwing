import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ContactCardRow, ReplicaProvider } from '../sync'
import { contactCard } from '../sync/test-utils'
import { expectNoA11yViolations } from '../test/axe'
import { ContactForm, type ContactFormSubmit } from './ContactForm'
import { PHOTO_MAX_BYTES, type PhotoScaler } from './contact-photo'
import styles from './contacts.module.css'

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

describe('ContactForm comm-row layout', () => {
  /**
   * The row is `[type] [value] [x]` and the type is the only fixed-width part of it, so whichever box
   * carries that width decides whether the value field gets a row or a sliver. `Select` forwards
   * `className` to the INNER `<select>` and lays out through a wrapper of its own — so the width used
   * to be set on a box that is not the flex child, the wrapper claimed the whole row at its
   * `inline-size: 100%`, and the email/phone field measured 26px in every viewport.
   *
   * Asserted on the DOM rather than on the stylesheet because that is where the mistake was: the rule
   * itself was always right, it was attached to the wrong element.
   */
  it('puts the fixed width on the flex child of the row, not on the inner select', () => {
    renderForm()
    const select = screen.getAllByRole('combobox')[0] as HTMLElement
    expect(select.tagName).toBe('SELECT')
    // `Select` renders <div wrapper><select/><chevron/></div>; the sized box is outside that wrapper.
    expect(select).not.toHaveClass(styles.commType as string)
    expect(select.parentElement).not.toHaveClass(styles.commType as string)
    expect(select.parentElement?.parentElement).toHaveClass(styles.commType as string)
    // …and that box is a direct child of the row, so `flex: none` has something to act on.
    expect(select.parentElement?.parentElement?.parentElement).toHaveClass(styles.commRow as string)
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

describe('ContactForm row identity (N8)', () => {
  /** Fill the email section with `values`, adding rows as needed. Returns the row text boxes. */
  async function fillEmails(
    user: ReturnType<typeof userEvent.setup>,
    values: readonly string[],
  ): Promise<void> {
    for (let index = 1; index < values.length; index += 1) {
      await user.click(screen.getByRole('button', { name: 'Add email' }))
    }
    for (const [index, value] of values.entries()) {
      const field = screen.getByRole('textbox', { name: `Email ${String(index + 1)}` })
      await user.clear(field)
      await user.type(field, value)
    }
  }

  it('removes exactly the row whose X was pressed, twice in a row', async () => {
    // `removeAt` took the index the row had at RENDER time. The second click of a double-click
    // therefore carried the index the first click had just vacated, and the row that slid up into
    // it was removed too: three addresses became one.
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    await fillEmails(user, ['a@example.test', 'b@example.test', 'c@example.test'])

    await user.dblClick(screen.getByRole('button', { name: 'Remove Email 1' }))

    await user.click(screen.getByRole('button', { name: 'Save' }))
    const submit = onSubmit.mock.calls[0]?.[0] as Extract<ContactFormSubmit, { kind: 'create' }>
    expect(Object.values(submit.card.emails ?? {}).map((entry) => entry.address)).toEqual([
      'b@example.test',
      'c@example.test',
    ])
  })

  it('names each row of a multi-row section distinctly (N14)', async () => {
    const user = userEvent.setup()
    renderForm()
    await fillEmails(user, ['a@example.test', 'b@example.test'])
    // Three controls per row, none of them sharing a name with its neighbour.
    for (const name of [
      'Email 1',
      'Email 2',
      'Type of Email 1',
      'Type of Email 2',
      'Remove Email 1',
      'Remove Email 2',
    ]) {
      expect(screen.getByLabelText(name)).toBeInTheDocument()
    }
  })

  it('leaves a single row unnumbered — the name is already exact', () => {
    renderForm()
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeInTheDocument()
    // …but the two type pickers on screen (email and phone) still say which is which.
    expect(screen.getByLabelText('Type of Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Type of Phone')).toBeInTheDocument()
  })
})

describe('ContactForm email validation (N9)', () => {
  it('refuses an unusable address with a reason, the caret and no submit', async () => {
    // The browser used to refuse this submit on its own: no JMAP call, no message from the app, no
    // `aria-invalid`, no moved focus — pressing Save just did nothing.
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    const field = screen.getByRole('textbox', { name: 'Email' })
    await user.type(field, 'not-an-address')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveFocus()
    const message = screen.getByText('Enter an email address like name@example.com.')
    expect(field).toHaveAttribute('aria-describedby', message.id)
  })

  it('clears the complaint as soon as the row is edited, and then saves', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    const field = screen.getByRole('textbox', { name: 'Email' })
    await user.type(field, 'not-an-address')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(field).toHaveAttribute('aria-invalid', 'true')

    await user.clear(field)
    expect(field).not.toHaveAttribute('aria-invalid')
    expect(
      screen.queryByText('Enter an email address like name@example.com.'),
    ).not.toBeInTheDocument()

    await user.type(field, 'fine@example.test')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('accepts a non-ASCII address — an address book has to be able to hold one', async () => {
    // `björn.müller@exämple.de` is a valid internationalised address (RFC 6531) and the native
    // `type="email"` constraint rejects it. The app's own check does not.
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'björn.müller@exämple.de')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const submit = onSubmit.mock.calls[0]?.[0] as Extract<ContactFormSubmit, { kind: 'create' }>
    expect(Object.values(submit.card.emails ?? {})[0]?.address).toBe('björn.müller@exämple.de')
  })

  it('lets an empty row through — a blank row is not a mistake', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    await user.type(screen.getByLabelText('First name'), 'Bob')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

describe('ContactForm photo (JMAP gap analysis, B-1)', () => {
  const passthroughScaler: PhotoScaler = async (file) => ({ blob: file, mediaType: file.type })

  /**
   * The write format. Stalwart answers a `media[].blobId` with
   * `invalidProperties: "blobIds in media is not supported."` and accepts the same photo as a
   * `data:` URI (measured, `docs/jmap-gap-2026-08-21/berichte/D-sharing-pim.md` §3.3) — so this
   * asserts on the SHAPE of the card the form hands back, which is the thing the old code got
   * wrong while its test was green.
   */
  it('writes the picked file into the media map as a data: URI, never a blobId', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ scalePhoto: passthroughScaler })

    await user.click(screen.getByRole('button', { name: 'Add photo' }))
    const file = new File(['bytes'], 'me.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Choose photo'), file)

    // Preview appears (from the local objectURL created while the encode runs).
    expect(await screen.findByRole('img')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    const submit = onSubmit.mock.calls[0]?.[0] as Extract<ContactFormSubmit, { kind: 'create' }>
    const media = Object.values(submit.card.media ?? {})[0]
    expect(media).toMatchObject({ kind: 'photo', mediaType: 'image/png' })
    expect(media?.uri ?? '').toMatch(/^data:image\/png;base64,/)
    expect(media?.blobId).toBeUndefined()
  })

  /**
   * The photo rides inside the card now, so there has to be a ceiling — otherwise a 4 MB camera
   * shot from a browser that cannot downscale becomes a 5.5 MB base64 string in every sync.
   */
  it('refuses a photo too large to put in a card, and says so in its own words', async () => {
    const user = userEvent.setup()
    // A scaler that cannot help (the real one's behaviour when it cannot decode the file).
    const giant = new File(['x'.repeat(PHOTO_MAX_BYTES + 1)], 'huge.png', { type: 'image/png' })
    const { onSubmit } = renderForm({ scalePhoto: passthroughScaler })

    await user.click(screen.getByRole('button', { name: 'Add photo' }))
    await user.upload(screen.getByLabelText('Choose photo'), giant)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That photo is too large. Choose a smaller one.',
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const submit = onSubmit.mock.calls[0]?.[0] as Extract<ContactFormSubmit, { kind: 'create' }>
    expect(submit.card.media).toBeUndefined()
  })

  it('removes the photo again', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ scalePhoto: passthroughScaler })

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

  /**
   * The half of B-1 that no component test could see: the picker was `disabled` unless a caller
   * passed an uploader, and no caller did. The form no longer takes one — so this pins that the
   * control the user is shown is a control the user can operate, with nothing to wire.
   */
  it('offers an ENABLED picker with no props beyond the form itself', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Add photo' }))
    expect(screen.getByLabelText('Choose photo')).toBeEnabled()
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
