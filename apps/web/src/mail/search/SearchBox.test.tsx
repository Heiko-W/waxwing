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
  it('renders the search field, scope control and no chips when empty', () => {
    render(<SearchBox search={mockSearch()} />)
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Search in' })).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
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
