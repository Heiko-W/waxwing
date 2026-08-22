/**
 * The recipient field with the organisation directory attached (S-5).
 *
 * The claim under test is the one that made the directory a SEPARATE source rather than a third
 * member of `combineSuggestionSources`: **a slow or broken directory must cost the writer nothing.**
 * The recents and the contact cards are replica reads — instant, and working offline — and that
 * combiner awaits every source together, so a network round trip folded into it would hold all of
 * them back behind it.
 *
 * The second claim is what the directory rows LOOK like: a quiet organisation line under the name,
 * no badge and no separate list. Apple states affiliation; it does not label the source.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { RecipientField } from './RecipientField'
import type { RecipientSuggestion, RecipientSuggestionSource } from './recipient-suggestions'

vi.mock('../contacts/use-contact-photo', () => ({
  useContactPhoto: () => undefined,
}))

const local: RecipientSuggestionSource = {
  query: async () => [{ name: 'Bob (my contacts)', email: 'bob@waxwing.test' }],
}

/** A directory that answers after `delay` ms with `results` — or rejects, if `fail`. */
function directory(
  results: RecipientSuggestion[],
  options: { readonly delay?: number; readonly fail?: boolean } = {},
): RecipientSuggestionSource {
  return {
    query: async () => {
      if (options.delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delay))
      }
      if (options.fail === true) throw new Error('offline')
      return results
    },
  }
}

function setup(
  source: RecipientSuggestionSource,
  directorySource?: RecipientSuggestionSource | undefined,
) {
  render(
    <RecipientField
      field="to"
      label="To"
      value={[]}
      source={source}
      directorySource={directorySource}
      onChange={vi.fn()}
      onMove={vi.fn()}
      otherFields={['cc', 'bcc']}
    />,
  )
  return screen.getByRole('combobox')
}

const CAROL: RecipientSuggestion = {
  name: 'Carol Chen',
  email: 'carol@waxwing.test',
  organization: 'waxwing.test',
}

describe('the directory alongside the local sources', () => {
  it('shows the local hits without waiting for the directory', async () => {
    const user = userEvent.setup()
    const input = setup(local, directory([CAROL], { delay: 5_000 }))
    await user.type(input, 'ca')

    // The local option is on screen while the directory is still five seconds away. Merged through
    // `combineSuggestionSources`, this assertion is the one that would fail.
    await waitFor(() => expect(screen.getByText('Bob (my contacts)')).toBeInTheDocument())
    expect(screen.queryByText('Carol Chen')).not.toBeInTheDocument()
  })

  it('THE RULE: a directory failure never takes the local hits away', async () => {
    const user = userEvent.setup()
    const input = setup(local, directory([], { fail: true }))
    await user.type(input, 'ca')
    await waitFor(() => expect(screen.getByText('Bob (my contacts)')).toBeInTheDocument())
    // Nothing to assert about the directory — the point is that the field is unchanged, and still
    // showing the address the writer already had.
    expect(screen.getByRole('listbox')).not.toHaveAttribute('hidden')
  })

  it('appends the directory hits after the local ones, with the organisation under the name', async () => {
    const user = userEvent.setup()
    const input = setup(local, directory([CAROL]))
    await user.type(input, 'ca')

    await waitFor(() => expect(screen.getByText('Carol Chen')).toBeInTheDocument())
    const options = screen.getAllByRole('option')
    // Local first, and the order does not change once the directory answers — an option the reader
    // has already arrowed onto must not move out from under them.
    expect(options[0]).toHaveTextContent('Bob (my contacts)')
    expect(options[1]).toHaveTextContent('Carol Chen')
    // The affiliation, quietly, as a third line — not a badge and not a group header.
    expect(within(options[1] as HTMLElement).getByText('waxwing.test')).toBeInTheDocument()
    // …and only on the directory row.
    expect(within(options[0] as HTMLElement).queryByText('waxwing.test')).not.toBeInTheDocument()
  })

  it('opens a listbox the local sources left empty', async () => {
    const user = userEvent.setup()
    const empty: RecipientSuggestionSource = { query: async () => [] }
    const input = setup(empty, directory([CAROL]))
    await user.type(input, 'ca')

    // The whole point of S-5: nobody in the writer's own contacts matches, so before this the field
    // showed nothing at all and the colleague stayed unreachable.
    await waitFor(() => expect(screen.getByText('Carol Chen')).toBeInTheDocument())
    expect(input).toHaveAttribute('aria-expanded', 'true')
  })

  it('stays shut when the reader pressed Escape before the answer arrived', async () => {
    const user = userEvent.setup()
    const input = setup(local, directory([CAROL], { delay: 50 }))
    await user.type(input, 'ca')
    await waitFor(() => expect(screen.getByText('Bob (my contacts)')).toBeInTheDocument())
    await user.keyboard('{Escape}')
    expect(input).toHaveAttribute('aria-expanded', 'false')

    // A late answer must not reopen a list the reader deliberately closed.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('drops a directory row for someone already in the local hits', async () => {
    const user = userEvent.setup()
    const twin: RecipientSuggestion = {
      name: 'Bob Baker',
      email: 'BOB@waxwing.test',
      organization: 'waxwing.test',
    }
    const input = setup(local, directory([twin]))
    await user.type(input, 'bo')
    await waitFor(() => expect(screen.getByText('Bob (my contacts)')).toBeInTheDocument())
    // The writer's own contact wins: it has the name they chose, and a second row for the same
    // address would say less than the first.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })

  it('has no a11y violations with a directory row on screen', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <RecipientField
        field="to"
        label="To"
        value={[]}
        source={local}
        directorySource={directory([CAROL])}
        onChange={vi.fn()}
        onMove={vi.fn()}
        otherFields={['cc', 'bcc']}
      />,
    )
    await user.type(screen.getByRole('combobox'), 'ca')
    await waitFor(() => expect(screen.getByText('Carol Chen')).toBeInTheDocument())
    await expectNoA11yViolations(container)
  })
})
