import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EmailAddress } from '@waxwing/jmap'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { RecipientField } from './RecipientField'
import type { RecipientSuggestionSource } from './recipient-suggestions'

// The photo hook is exercised in its own suite; here we just need it to return a URL when a
// suggestion carries photo media, so the option can render an <img> without the blob machinery.
vi.mock('../contacts/use-contact-photo', () => ({
  useContactPhoto: (_accountId: unknown, media: unknown) => (media ? 'blob:photo' : undefined),
}))

const emptySource: RecipientSuggestionSource = { query: async () => [] }

function setup(value: EmailAddress[] = [], source: RecipientSuggestionSource = emptySource) {
  const onChange = vi.fn()
  const onMove = vi.fn()
  render(
    <RecipientField
      field="to"
      label="To"
      value={value}
      source={source}
      onChange={onChange}
      onMove={onMove}
      otherFields={['cc', 'bcc']}
    />,
  )
  return { onChange, onMove, input: screen.getByRole('combobox') }
}

describe('RecipientField', () => {
  it('commits typed text to a pill on Enter', async () => {
    const { onChange, input } = setup()
    await userEvent.setup().type(input, 'a@x.com{Enter}')
    expect(onChange).toHaveBeenCalledWith([{ name: null, email: 'a@x.com' }])
  })

  it('commits on a comma separator', async () => {
    const { onChange, input } = setup()
    await userEvent.setup().type(input, 'a@x.com,')
    expect(onChange).toHaveBeenCalledWith([{ name: null, email: 'a@x.com' }])
  })

  it('removes the last pill on Backspace when the input is empty', async () => {
    const { onChange, input } = setup([
      { name: null, email: 'a@x.com' },
      { name: null, email: 'b@x.com' },
    ])
    input.focus()
    await userEvent.setup().keyboard('{Backspace}')
    expect(onChange).toHaveBeenCalledWith([{ name: null, email: 'a@x.com' }])
  })

  it('flags an invalid address', () => {
    setup([{ name: null, email: 'not-an-email' }])
    expect(screen.getByText('Invalid email address')).toBeInTheDocument()
  })

  it('picks a suggestion with ArrowDown + Enter', async () => {
    const source: RecipientSuggestionSource = {
      query: async () => [{ name: 'Al', email: 'al@x.com' }],
    }
    const { onChange, input } = setup([], source)
    const user = userEvent.setup()
    await user.type(input, 'al')
    await screen.findByRole('option', { name: /al@x\.com/ })
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith([{ name: 'Al', email: 'al@x.com' }])
  })

  it('moves a pill to another field via its menu', async () => {
    const { onMove } = setup([{ name: null, email: 'a@x.com' }])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Recipient options' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to Cc' }))
    expect(onMove).toHaveBeenCalledWith(0, 'cc')
  })

  it('renders a contact photo in a suggestion that carries one', async () => {
    const source: RecipientSuggestionSource = {
      query: async () => [
        { name: 'Ada', email: 'ada@x.test', photo: { kind: 'photo', blobId: 'b1' } },
      ],
    }
    render(
      <RecipientField
        field="to"
        label="To"
        value={[]}
        source={source}
        accountId="a"
        onChange={vi.fn()}
        onMove={vi.fn()}
        otherFields={[]}
      />,
    )
    await userEvent.setup().type(screen.getByRole('combobox'), 'ada')
    const option = await screen.findByRole('option', { name: /ada@x\.test/ })
    const img = option.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', 'blob:photo')
  })

  it('renders initials (no <img>) for a suggestion without a photo', async () => {
    const source: RecipientSuggestionSource = {
      query: async () => [{ name: 'Al', email: 'al@x.test' }],
    }
    render(
      <RecipientField
        field="to"
        label="To"
        value={[]}
        source={source}
        accountId="a"
        onChange={vi.fn()}
        onMove={vi.fn()}
        otherFields={[]}
      />,
    )
    await userEvent.setup().type(screen.getByRole('combobox'), 'al')
    const option = await screen.findByRole('option', { name: /al@x\.test/ })
    expect(option.querySelector('img')).toBeNull()
    expect(option).toHaveTextContent('AL') // initials from "Al"
  })

  it('has no a11y violations', async () => {
    setup([{ name: 'Al', email: 'al@x.com' }])
    await expectNoA11yViolations(document.body)
  })
})
