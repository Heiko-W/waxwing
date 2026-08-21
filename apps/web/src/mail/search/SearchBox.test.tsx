import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../../test/axe'
import { SearchBox } from './SearchBox'
import type { SearchState } from './use-search'

function mockSearch(over: Partial<SearchState> = {}): SearchState {
  return {
    active: false,
    q: '',
    scope: 'folder',
    spec: null,
    scopeMailboxId: undefined,
    chips: [],
    setQuery: vi.fn(),
    setScope: vi.fn(),
    removeChip: vi.fn(),
    clear: vi.fn(),
    ...over,
  }
}

describe('SearchBox', () => {
  it('renders the field, and no chips, when empty', () => {
    render(<SearchBox search={mockSearch()} />)
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  /**
   * The scope picker is not chrome — it is part of composing a query, and it used to render
   * unconditionally: a full-width "This folder" dropdown above every folder, 52 px on a phone,
   * scoping nothing while the field was empty. Only the clear button beside it was ever gated on
   * `search.active`; this follows the same rule now, plus focus, so the choice is still reachable
   * before the query is submitted.
   */
  it('shows the scope control only once a search is being composed', async () => {
    render(<SearchBox search={mockSearch()} />)
    expect(screen.queryByRole('combobox', { name: 'Search in' })).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('searchbox', { name: 'Search' }))
    expect(screen.getByRole('combobox', { name: 'Search in' })).toBeInTheDocument()
  })

  /**
   * B-2. "All mailboxes" now leaves Trash and Junk out, so there has to be a third choice that puts
   * them back — otherwise the fix takes something away without offering a way to ask for it.
   */
  it('offers three scopes, and the widest one names what it adds', async () => {
    const search = mockSearch()
    render(<SearchBox search={search} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('searchbox', { name: 'Search' }))

    const picker = screen.getByRole('combobox', { name: 'Search in' })
    expect([...picker.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'This folder',
      'All mailboxes',
      'All mailboxes, incl. Trash & Junk',
    ])

    await user.selectOptions(picker, 'everywhere')
    expect(search.setScope).toHaveBeenCalledWith('everywhere')
  })

  /**
   * M-3. The boolean syntax has to be discoverable by the one person who wants it and invisible to
   * everyone else: it is part of the field's ONE description, shown while the field has focus.
   */
  it('names the advanced syntax in the hint, and only while the field has focus', async () => {
    render(<SearchBox search={mockSearch()} />)
    const input = screen.getByRole('searchbox', { name: 'Search' })
    const hintId = (input.getAttribute('aria-describedby') ?? '').split(' ')[0] ?? ''
    const hint = document.getElementById(hintId)
    expect(hint?.textContent).toContain('OR')
    expect(hint?.className).toMatch(/hintHidden/)

    await userEvent.setup().click(input)
    expect(document.getElementById(hintId)?.className).not.toMatch(/hintHidden/)
  })

  it('debounces typing into a replace setQuery', async () => {
    const search = mockSearch()
    render(<SearchBox search={search} />)
    await userEvent.setup().type(screen.getByRole('searchbox', { name: 'Search' }), 'tax')
    await waitFor(() => expect(search.setQuery).toHaveBeenCalledWith('tax', { replace: true }))
  })

  it('submits (Enter) with a pushing setQuery', async () => {
    const search = mockSearch()
    render(<SearchBox search={search} />)
    await userEvent.setup().type(screen.getByRole('searchbox', { name: 'Search' }), 'urgent{Enter}')
    await waitFor(() => expect(search.setQuery).toHaveBeenCalledWith('urgent'))
  })

  it('renders chips and removes one', async () => {
    const search = mockSearch({
      active: true,
      q: 'from:alice',
      chips: [{ index: 0, label: 'From: alice' }],
    })
    render(<SearchBox search={search} />)
    expect(screen.getByText('From: alice')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove From: alice filter' }))
    expect(search.removeChip).toHaveBeenCalledWith(0)
  })

  it('clears the search', async () => {
    const search = mockSearch({ active: true, q: 'tax' })
    render(<SearchBox search={search} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear search' }))
    expect(search.clear).toHaveBeenCalled()
  })

  it('has no a11y violations (with chips)', async () => {
    render(
      <SearchBox
        search={mockSearch({
          active: true,
          q: 'from:alice',
          chips: [{ index: 0, label: 'From: alice' }],
        })}
      />,
    )
    await expectNoA11yViolations(document.body)
  })

  // B20.7. The chip strip carried `aria-label={t('search.label')}` — the SAME name as the input —
  // and was pulled into that input's `aria-describedby`, so focusing the field read out every
  // active filter in full and two different things answered to "Search".
  it('names the chip strip separately and describes the field with a COUNT', async () => {
    render(
      <SearchBox
        search={mockSearch({
          active: true,
          q: 'from:bob is:unread',
          chips: [
            { index: 0, label: 'From: bob' },
            { index: 1, label: 'Unread' },
          ],
        })}
      />,
    )

    const input = screen.getByRole('searchbox', { name: 'Search' })
    const strip = screen.getByRole('list', { name: 'Active filters' })
    expect(strip).toBeInTheDocument()

    const described = (input.getAttribute('aria-describedby') ?? '').split(' ')
    expect(described, 'the chip strip is still the description').not.toContain(strip.id)
    const text = described.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    expect(text).toContain('2 filters active')
  })
})
